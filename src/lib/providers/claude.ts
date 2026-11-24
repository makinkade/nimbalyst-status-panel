import { getUsage, invokeQuiet, on } from '../ipc';
import type { ClaudeUsage } from '../ipc';
import { fetchPlanUsageResult, invalidatePlanUsage } from '../planUsage';
import type { PlanUsage } from '../planUsage';
import type { AccountAdapter } from '../providerAdapters';
import { measured, missing, type AccountUsage, type Reading, type ReadingScope,
  type UsageBucket, type UsageWindow } from '../statusModel';

/** Preserve the existing five-minute visual grace period for Claude readings. */
export const CLAUDE_STALE_MS = 5 * 60_000;

function percent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function window(id: string, label: string, value: unknown, reset: unknown,
  durationMinutes?: number): UsageWindow[] {
  return percent(value) ? [{ id, label, durationMinutes,
    utilization: { value, unit: 'percent-used' },
    resetsAt: typeof reset === 'string' ? reset : null }] : [];
}

/** Keep source labels/semantic IDs; neither utilization nor reset time is identity. */
export function normalizeClaudePlan(usage: PlanUsage): AccountUsage {
  const buckets: UsageBucket[] = [{ id: 'plan', label: 'Claude plan', windows: [
    ...window('five-hour', '5h', usage.fiveHour, usage.fiveHourReset, 300),
    ...window('seven-day', '7d', usage.sevenDay, usage.sevenDayReset, 10080),
  ] }];
  const scoped = (usage.allLimits ?? []).filter((limit) => limit.model);
  if (scoped.length) {
    for (const limit of scoped) {
      const label = limit.group === 'session' ? '5h' : limit.group === 'weekly' ? '7d' : limit.group ?? 'Limit';
      const id = `model:${encodeURIComponent(limit.model!)}`;
      let bucket = buckets.find((entry) => entry.id === id);
      if (!bucket) {
        bucket = { id, label: limit.model!, modelScope: limit.model!, windows: [] };
        buckets.push(bucket);
      }
      bucket.windows.push(...window(`group:${limit.group ?? 'unknown'}`, `${label} ${limit.model}`,
        limit.percent, limit.resets, limit.group === 'session' ? 300 : limit.group === 'weekly' ? 10080 : undefined));
    }
  } else {
    // Older PowerShell caches only have the preformatted scoped collection.
    for (const limit of usage.scoped ?? []) {
      const legacy = /^(5h|7d) (.+)$/.exec(limit.label);
      const model = legacy?.[2] ?? limit.label;
      const id = legacy ? `model:${encodeURIComponent(model)}` : `scoped:${encodeURIComponent(limit.label)}`;
      let bucket = buckets.find((entry) => entry.id === id);
      if (!bucket) { bucket = { id, label: model, modelScope: model, windows: [] }; buckets.push(bucket); }
      bucket.windows.push(...window(legacy ? `group:${legacy[1] === '5h' ? 'session' : 'weekly'}` : 'limit',
        limit.label, limit.pct, limit.reset, legacy?.[1] === '5h' ? 300 : legacy?.[1] === '7d' ? 10080 : undefined));
    }
  }
  for (const limit of usage.allLimits ?? []) {
    if (limit.model || !limit.group) continue;
    const id = limit.group === 'session' ? 'five-hour' : limit.group === 'weekly' ? 'seven-day' : `group:${limit.group}`;
    if (buckets[0].windows.some((entry) => entry.id === id)) continue;
    buckets[0].windows.push(...window(id, limit.group === 'session' ? '5h' : limit.group === 'weekly' ? '7d' : limit.group,
      limit.percent, limit.resets, limit.group === 'session' ? 300 : limit.group === 'weekly' ? 10080 : undefined));
  }
  return { buckets };
}

export function normalizeClaudeHost(usage: ClaudeUsage): AccountUsage {
  const normalized = normalizeClaudePlan({
    fiveHour: usage.fiveHour?.utilization, fiveHourReset: usage.fiveHour?.resetsAt,
    sevenDay: usage.sevenDay?.utilization, sevenDayReset: usage.sevenDay?.resetsAt,
    allLimits: (Array.isArray(usage.weeklyModelLimits) ? usage.weeklyModelLimits : []).map((limit) => ({
      group: 'weekly', model: limit.model, percent: limit.utilization, resets: limit.resetsAt,
    })),
  });
  // Do not duplicate Opus when the richer collection already names it.
  if (usage.sevenDayOpus && !normalized.buckets.some((bucket) => bucket.modelScope?.toLowerCase().includes('opus'))) {
    normalized.buckets.push({ id: 'model:opus', label: 'Opus', modelScope: 'Opus',
      windows: window('group:weekly', '7d Opus', usage.sevenDayOpus.utilization, usage.sevenDayOpus.resetsAt, 10080) });
  }
  return normalized;
}

export function claudeReading(usage: PlanUsage | ClaudeUsage, scope: ReadingScope,
  source: 'claude-direct' | 'claude-host', now = Date.now()): Reading<AccountUsage> {
  if (source === 'claude-host' && (usage as ClaudeUsage).error) {
    return missing('unavailable', source, scope, 'Claude usage is unavailable from the host', now);
  }
  const observed = source === 'claude-direct'
    ? Date.parse((usage as PlanUsage).timestamp ?? '') : (usage as ClaudeUsage).lastUpdated;
  return measured(source === 'claude-direct' ? normalizeClaudePlan(usage as PlanUsage)
    : normalizeClaudeHost(usage as ClaudeUsage), source, scope,
  typeof observed === 'number' && Number.isFinite(observed) ? observed : null, now, CLAUDE_STALE_MS);
}

let invalidatedAt = 0;
export const claudeAccountAdapter: AccountAdapter = {
  id: 'claude-code', intervalMs: 60_000,
  scope: (workspacePath) => ({ kind: 'account', provider: 'claude-code', workspacePath,
    accountId: null, configSource: 'host-claude-config', association: 'unbound' }),
  async identity() {
    // A change detector, not a session-account binding. The source has no stable
    // account ID. Never put this private revision in the status model/storage.
    const status = await invokeQuiet<Record<string, unknown>>('claude-code:check-login');
    const authenticated = typeof status?.isLoggedIn === 'boolean'
      ? status.isLoggedIn && status.isExpired !== true : null;
    return { accountId: null, authenticated,
      revision: authenticated === null ? null : JSON.stringify([
        authenticated, status?.isExpired === true,
        typeof status?.email === 'string' ? status.email : null,
        typeof status?.organization === 'string' ? status.organization : null,
      ]) };
  },
  async collect(scope, signal) {
    const result = await fetchPlanUsageResult();
    if (signal.aborted) return missing('unavailable', 'claude-direct', scope, 'Reading cancelled');
    if (result.failure === 'unauthenticated') {
      return missing('unauthenticated', 'claude-direct', scope, 'Sign in to Claude to read plan usage');
    }
    if (result.usage) {
      const reading = claudeReading(result.usage, scope, 'claude-direct');
      return result.failure && reading.value
        ? { ...reading, state: 'stale', value: reading.value,
          reason: result.failure === 'credentials-unavailable' ? 'Claude credentials are unavailable; showing the last reading'
            : 'Claude usage could not be refreshed; showing the last reading' } : reading;
    }
    const host = await getUsage();
    if (signal.aborted) return missing('unavailable', 'claude-host', scope, 'Reading cancelled');
    // The host singleton is unpartitioned too. After a detected auth change an
    // older host snapshot is no more trustworthy than the old shared file.
    if (host && !host.error && (!invalidatedAt ||
      (typeof host.lastUpdated === 'number' && host.lastUpdated > invalidatedAt)) &&
      (host.fiveHour || host.sevenDay || host.sevenDayOpus || Array.isArray(host.weeklyModelLimits))) {
      return claudeReading(host, scope, 'claude-host');
    }
    return missing('unavailable', 'claude-usage', scope,
      result.failure === 'credentials-unavailable'
        ? 'Claude credentials are unavailable and the host has no usable reading'
        : 'Claude plan usage is unavailable');
  },
  subscribe: (refresh) => on('claude-usage:update', refresh),
  invalidate() { invalidatedAt = Date.now(); invalidatePlanUsage(); },
};
