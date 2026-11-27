import type { AccountAdapter } from '../providerAdapters';
import { missing, type AccountUsage, type UsageBucket, type UsageWindow } from '../statusModel';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectValue : null;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function reset(value: unknown): string | null {
  // GET-222's host converter already changed Unix seconds to ISO strings.
  // Do not interpret an upstream numeric timestamp as this host contract.
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value)) ? value : null;
}
function durationLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function credits(value: unknown): UsageBucket['credits'] {
  const source = object(value);
  if (!source) return undefined;
  const result: NonNullable<UsageBucket['credits']> = {};
  for (const flag of ['hasCredits', 'unlimited'] as const) {
    if (typeof source[flag] === 'boolean') result[flag] = source[flag];
  }
  const balance = source.balance;
  if (typeof balance === 'number' && Number.isFinite(balance)) result.balance = balance;
  else if (typeof balance === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(balance.trim()) &&
    Number.isFinite(Number(balance))) result.balance = balance.trim();
  return Object.keys(result).length ? result : undefined;
}

function windows(value: unknown, label: string): UsageWindow[] {
  if (!Array.isArray(value)) return [];
  const result: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const source = object(entry);
    const slot = text(source?.slot);
    if (!source || !slot || !nonnegative(source.usedPercent) || seen.has(slot)) continue;
    seen.add(slot);
    const duration = nonnegative(source.windowDurationMins) && source.windowDurationMins > 0
      ? source.windowDurationMins : undefined;
    result.push({ id: `window:${slot}`, label: `${label} ${duration === undefined ? slot : durationLabel(duration)}`,
      role: slot === 'primary' || slot === 'secondary' ? slot : 'additional',
      ...(duration !== undefined ? { durationMinutes: duration } : {}),
      utilization: { value: source.usedPercent, unit: 'percent-used' }, resetsAt: reset(source.resetsAt) });
  }
  return result;
}

/**
 * GET-226 foundation: normalize only the audited host's account-source payload.
 * This returns quantities, NOT an authenticated Reading. lastUpdated is host
 * processing time and cannot establish ownership or freshness (GET-228).
 * Production collection stays disabled until a real scoped bridge is verified.
 */
export function normalizeCodexHost(value: unknown): AccountUsage | null {
  const source = object(value);
  if (!source || source.source !== 'account' || !Array.isArray(source.limits) ||
    (source.error !== undefined && source.error !== null && source.error !== '')) return null;
  const buckets: UsageBucket[] = [];
  const seen = new Set<string>();
  for (const entry of source.limits) {
    const limit = object(entry);
    const id = text(limit?.id);
    if (!limit || !id || seen.has(id)) continue;
    seen.add(id);
    const label = text(limit.name) ?? id;
    const bucket: UsageBucket = { id, label, windows: windows(limit.windows, label) };
    const plan = text(limit.planType);
    if (plan) bucket.plan = plan;
    const balance = credits(limit.credits);
    if (balance) bucket.credits = balance;
    const individual = object(limit.individualLimit);
    if (nonnegative(individual?.remainingPercent) && individual.remainingPercent <= 100) {
      // The host supplies a percentage, but no verified unit for limit/used.
      bucket.windows.push({ id: 'individual', label: `${label} individual limit`, role: 'additional',
        utilization: { value: individual.remainingPercent, unit: 'percent-remaining' },
        resetsAt: reset(individual.resetsAt) });
    }
    buckets.push(bucket);
  }
  if (source.limits.length && !buckets.length) return null;
  const result: AccountUsage = { buckets };
  const resetCredits = object(source.rateLimitResetCredits);
  if (resetCredits) {
    const normalized: NonNullable<AccountUsage['resetCredits']> = {};
    if (nonnegative(resetCredits.availableCount) && Number.isSafeInteger(resetCredits.availableCount)) {
      normalized.availableCount = resetCredits.availableCount;
    }
    if (resetCredits.credits === null) normalized.credits = null;
    else if (Array.isArray(resetCredits.credits)) {
      // Allowlist the fields the host converter returns, not arbitrary metadata.
      normalized.credits = resetCredits.credits.flatMap((entry) => {
        const credit = object(entry);
        const id = text(credit?.id);
        return credit && id ? [{ id, title: text(credit.title) ?? null,
          description: text(credit.description) ?? null, expiresAt: reset(credit.expiresAt) }] : [];
      });
    }
    if (Object.keys(normalized).length) result.resetCredits = normalized;
  }
  return result;
}

export const CODEX_USAGE_UNAVAILABLE =
  'Codex allowance is unavailable: this integration cannot verify account ownership or when usage was observed. ' +
  'Host support is required before account usage can be shown safely.';

/**
 * No IPC, auth probe, event-driven refresh or credential access here. Even the
 * old cached getter can spawn a host auth app-server on a cache miss. Do not
 * enable that path from a card mount, or guess GET-228's future channel/fields.
 */
export const codexAccountAdapter: AccountAdapter = {
  id: 'openai-codex', intervalMs: 60_000,
  scope: (workspacePath) => ({ kind: 'account', provider: 'openai-codex', workspacePath,
    accountId: null, configSource: 'host-codex-usage', association: 'unbound' }),
  async collect(scope) {
    return missing('unavailable', 'codex-host-bridge', scope, CODEX_USAGE_UNAVAILABLE);
  },
};
