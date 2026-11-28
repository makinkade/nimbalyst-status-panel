import type { AccountAdapter } from '../providerAdapters';
import { formatDuration } from '../format';
import { invokeQuiet, on } from '../ipc';
import {
  ageReading, measured, missing,
  type AccountUsage, type Reading, type ReadingScope, type ResetCredit, type UsageBucket, type UsageWindow,
} from '../statusModel';

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
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

function credits(value: unknown): UsageBucket['credits'] {
  const source = object(value);
  if (!source) return undefined;
  const result: NonNullable<UsageBucket['credits']> = {};
  for (const flag of ['hasCredits', 'unlimited'] as const) {
    if (typeof source[flag] === 'boolean') result[flag] = source[flag];
  }
  const balance = source.balance;
  if (typeof balance === 'number' && Number.isFinite(balance)) {
    result.balance = balance;
  } else if (typeof balance === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(balance.trim()) &&
    Number.isFinite(Number(balance))) {
    result.balance = balance.trim();
  }
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
    result.push({
      id: `window:${slot}`,
      label: `${label} ${formatDuration(duration) ?? slot}`,
      role: slot === 'primary' || slot === 'secondary' ? slot : 'additional',
      ...(duration !== undefined ? { durationMinutes: duration } : {}),
      utilization: { value: source.usedPercent, unit: 'percent-used' },
      resetsAt: reset(source.resetsAt),
    });
  }
  return result;
}

function resetCreditList(value: unknown): ResetCredit[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  // Allowlist the fields the host converter returns, not arbitrary metadata.
  return value.flatMap((entry) => {
    const credit = object(entry);
    const id = text(credit?.id);
    return credit && id ? [{
      id,
      title: text(credit.title) ?? null,
      description: text(credit.description) ?? null,
      expiresAt: reset(credit.expiresAt),
    }] : [];
  });
}

/**
 * GET-226: normalize only the audited host's account-source payload.
 * This returns quantities, NOT an authenticated Reading. lastUpdated is host
 * processing time and cannot establish ownership or freshness. The revised
 * scope permits explicitly unbound host-reported quantities with unknown age.
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
      bucket.windows.push({
        id: 'individual',
        label: `${label} individual limit`,
        role: 'additional',
        utilization: { value: individual.remainingPercent, unit: 'percent-remaining' },
        resetsAt: reset(individual.resetsAt),
      });
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
    const list = resetCreditList(resetCredits.credits);
    if (list !== undefined) normalized.credits = list;
    if (Object.keys(normalized).length) result.resetCredits = normalized;
  }
  return result;
}

/**
 * Say why a usage response was refused, instead of a bare "unusable". The
 * host's own error text stays in Nimbalyst's log: it may name local paths.
 */
export function codexRejectionReason(value: unknown): string {
  const source = object(value);
  if (!source) return 'Nimbalyst could not refresh Codex usage.';
  const error = text(source.error);
  if (error?.startsWith('No Codex usage data found')) {
    return 'Nimbalyst found no Codex account limits and no recent Codex session data.';
  }
  if (error) return 'Nimbalyst reported an error while reading Codex usage; details are in Nimbalyst’s log.';
  if (source.source === 'session') {
    return 'Nimbalyst could not read the Codex account’s limits and fell back to recent Codex session files. ' +
      'Those files are not tied to this account, so they are not shown.';
  }
  return 'Nimbalyst returned Codex usage in a form the panel does not recognize.';
}

export const CODEX_USAGE_UNBOUND =
  'Host-reported Codex allowance; account/session association and source observation time are unverified. ' +
  'This is not a universal ChatGPT allowance or a verified current-account reading.';
/**
 * Background read cadence (Mark's choice in review, 2026-11-27). Nimbalyst
 * pushes codex-usage:update itself whenever the Codex app-server reports new
 * limits, typically after each turn, so this poll only catches use elsewhere
 * and windows that reset. Each host refresh calls OpenAI, writes Nimbalyst's
 * usage history and broadcasts to every window, so once a minute was too much.
 */
export const CODEX_READ_INTERVAL_MS = 5 * 60_000;
/**
 * Shared floor between host calls, across panels, failures and retries. Kept
 * well under the poll interval so a scheduled read is never refused merely
 * because the previous request took a moment to finish.
 */
export const CODEX_REQUEST_FLOOR_MS = 60_000;
/** Two missed reads (or pushes) count as old delivery, not unknown source age. */
export const CODEX_STALE_AFTER_MS = 2 * CODEX_READ_INTERVAL_MS;
/** How soon to look again while another caller's host request is still running. */
const PENDING_RETRY_MS = 1_000;

export type CodexAuthMode = 'chatgpt' | 'apikey' | 'signed-out' | 'unknown';
interface AuthStatus { mode: CodexAuthMode; revision: string }

/** A private change detector, never an account ID or a rendered/persisted value. */
function authStatus(value: unknown): AuthStatus {
  const status = object(value);
  let mode: CodexAuthMode = 'unknown';
  if (status?.installed === true && !status.error) {
    if (status.isLoggedIn === false) mode = 'signed-out';
    else if (status.isLoggedIn === true && (status.authMode === 'chatgpt' || status.authMode === 'apikey')) {
      mode = status.authMode;
    }
  }
  return { mode, revision: JSON.stringify([mode, text(status?.email) ?? null, text(status?.planType) ?? null]) };
}

/** Shared timing only: no account data or unbound values cross monitor leases. */
export interface CodexReadBudget { authAt: number; usageAt: number; authPending: boolean; usagePending: boolean }
export const newCodexReadBudget = (): CodexReadBudget => ({
  authAt: -Infinity, usageAt: -Infinity, authPending: false, usagePending: false,
});
const hostBudget = newCodexReadBudget();

interface CodexDependencies {
  invoke: (channel: string) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
  now: () => number;
  budget: CodexReadBudget;
}

const AUTH_CHANNELS = ['openai-codex:auth-updated', 'openai-codex:auth-login-completed'];

/**
 * The first selected-Codex read checks auth and explicitly refreshes quantities.
 * Both existing host calls may start its managed auth app-server. Reuse that
 * lifecycle deliberately; never spawn a client or use the arbitrarily old getter.
 * Host calls share a one-minute floor, including failures and selection churn.
 * Events are consumed locally and never cause another host refresh (GET-226).
 *
 * Codex limits belong to the signed-in account, not to a session. So leaving a
 * Codex session (unsubscribe) only pauses this collector: its auth check and
 * last reading survive, and the next Codex session shows them immediately.
 * Only a detected auth change (invalidate) discards them. Before this, every
 * session switch threw them away while the shared floor still refused a new
 * read, blanking Codex usage for up to a minute.
 */
export function createCodexAccountAdapter(overrides: Partial<CodexDependencies> = {}): AccountAdapter {
  const deps: CodexDependencies = { invoke: invokeQuiet, on, now: Date.now, budget: hostBudget, ...overrides };
  let epoch = 0;
  let auth: AuthStatus | null = null;
  let authAt = -Infinity;
  /** An explicit account read has completed in this auth epoch. */
  let readyForEvents = false;
  /** No panel is showing Codex: finish bookkeeping, but start no host calls. */
  let paused = false;
  let pendingEvent: { value: unknown; receivedAt: number } | null = null;
  let last: Reading<AccountUsage> | null = null;
  let work: Promise<Reading<AccountUsage>> | undefined;
  let notifyAuth: (() => void) | undefined;

  const invalidate = () => {
    epoch += 1;
    auth = null;
    authAt = -Infinity;
    readyForEvents = false;
    pendingEvent = null;
    last = null;
    work = undefined;
  };

  const absent = (scope: ReadingScope, reason: string,
    state: 'unavailable' | 'unauthenticated' | 'unsupported' = 'unavailable'): Reading<AccountUsage> => ({
    ...missing<AccountUsage>(state, 'codex-host-account', scope, reason, deps.now()),
    lastSuccessfulFetchAt: null,
    lastAttemptAt: deps.now(),
  });

  /** A failed refresh keeps the last value, marked stale until a later success. */
  const failed = (scope: ReadingScope, reason: string): Reading<AccountUsage> => {
    if (!last?.value) return absent(scope, reason);
    last = { ...last, state: 'stale', value: last.value, reason: `${reason} ${CODEX_USAGE_UNBOUND}`,
      lastAttemptAt: deps.now() };
    return last;
  };

  const receive = (value: unknown, scope: ReadingScope, receivedAt: number): Reading<AccountUsage> => {
    const usage = normalizeCodexHost(value);
    if (!usage) return failed(scope, codexRejectionReason(value));
    // Unknown source age is not a failed/old fetch. Keep it explicit, but
    // reserve stale for failed refreshes or two intervals without delivery.
    last = {
      ...measured(usage, 'codex-host-account', scope, null, receivedAt),
      freshnessBasis: 'receipt',
      staleAfterMs: CODEX_STALE_AFTER_MS,
      reason: CODEX_USAGE_UNBOUND,
      lastSuccessfulFetchAt: receivedAt,
      lastAttemptAt: receivedAt,
    };
    // Schedule the next read from this delivery, so a pushed update postpones
    // it rather than the monitor's fixed tick deciding. Not stored on `last`.
    return { ...last, retryAt: receivedAt + CODEX_READ_INTERVAL_MS };
  };

  /** Not a refresh: the last value with its original timestamps, plus when to try. */
  const waiting = (scope: ReadingScope, retryAt: number, reason: string): Reading<AccountUsage> => ({
    ...(last?.value ? ageReading(last, deps.now()) : absent(scope, reason)),
    retryAt: Math.max(deps.now() + 250, retryAt),
  });

  const throttled = (scope: ReadingScope, pending: boolean, at: number, reason: string) =>
    waiting(scope, pending ? deps.now() + PENDING_RETRY_MS : at + CODEX_REQUEST_FLOOR_MS, reason);

  const run = async (scope: ReadingScope): Promise<Reading<AccountUsage>> => {
    const generation = epoch;
    const current = () => generation === epoch;
    const budget = deps.budget;
    if (last && last.scope.workspacePath !== scope.workspacePath) last = null;

    if (!auth || deps.now() - authAt >= CODEX_READ_INTERVAL_MS) {
      if (budget.authPending || deps.now() - budget.authAt < CODEX_REQUEST_FLOOR_MS) {
        // A reading exists only under an auth this collector already checked
        // (auth changes and non-ChatGPT modes clear it), so it may stay shown.
        return throttled(scope, budget.authPending, budget.authAt,
          'Codex authentication check is throttled; waiting for the next account read.');
      }
      const started = deps.now();
      budget.authAt = started;
      budget.authPending = true;
      let value: unknown;
      try { value = await deps.invoke('openai-codex:check-login'); } catch { value = null; }
      finally { budget.authPending = false; }
      if (!current()) return absent(scope, 'Codex reading cancelled after an auth change.');
      const next = authStatus(value);
      if (auth && auth.revision !== next.revision) {
        // Clear the displayed/cache value at detection, before awaiting any
        // new quota request. Keep only the just-checked auth classification.
        notifyAuth?.();
        last = null;
        pendingEvent = null;
        readyForEvents = false;
      }
      auth = next;
      authAt = started;
      if (!current()) return absent(scope, 'Codex authentication changed; prior work was cancelled.');
      if (paused) return absent(scope, 'Codex reading paused; no Codex session is selected.');
    }

    if (auth.mode !== 'chatgpt') {
      last = null;
      readyForEvents = false;
      pendingEvent = null;
      if (auth.mode === 'apikey') {
        return absent(scope, 'API-key authentication does not report a ChatGPT subscription allowance.', 'unsupported');
      }
      if (auth.mode === 'signed-out') {
        return absent(scope, 'Sign in to Codex with ChatGPT to read its allowance.', 'unauthenticated');
      }
      return absent(scope, 'Codex authentication is unknown or could not be checked.');
    }

    // A pushed update counts only after an explicit account read in this auth
    // epoch: the host cannot guarantee atomic ownership of broadcasts.
    if (pendingEvent && readyForEvents) {
      const update = pendingEvent;
      pendingEvent = null;
      return receive(update.value, scope, update.receivedAt);
    }

    // A successful reading (read or pushed) is good until the next interval.
    const succeededAt = last?.value && last.state === 'available' ? last.lastSuccessfulFetchAt : null;
    if (typeof succeededAt === 'number' && deps.now() - succeededAt < CODEX_READ_INTERVAL_MS) {
      return waiting(scope, succeededAt + CODEX_READ_INTERVAL_MS, 'Waiting for the next Codex account read.');
    }
    if (budget.usagePending || deps.now() - budget.usageAt < CODEX_REQUEST_FLOOR_MS) {
      return throttled(scope, budget.usagePending, budget.usageAt,
        'Codex allowance refresh is throttled; waiting for the next account read.');
    }
    if (paused) return absent(scope, 'Codex reading paused; no Codex session is selected.');
    budget.usageAt = deps.now();
    budget.usagePending = true;
    let value: unknown;
    try { value = await deps.invoke('codex-usage:refresh'); } catch { value = null; }
    finally { budget.usagePending = false; }
    if (!current()) return absent(scope, 'Codex reading cancelled after an auth change.');
    readyForEvents = true;
    return receive(value, scope, deps.now());
  };

  const adapter: AccountAdapter = {
    id: 'openai-codex',
    intervalMs: CODEX_READ_INTERVAL_MS,
    retainOnUnavailable: false,
    scope: (workspacePath) => ({ kind: 'account', provider: 'openai-codex', workspacePath,
      accountId: null, configSource: 'host-codex-usage', association: 'unbound' }),
    invalidate,
    // One run at a time per collector. A run outlives the caller that started
    // it, so its result is stored here; the cache discards it for a caller
    // whose own request was cancelled.
    collect(scope) {
      if (work) return work;
      const current = run(scope).finally(() => { if (work === current) work = undefined; });
      work = current;
      return current;
    },
    subscribeInvalidation(changed) {
      const stops = AUTH_CHANNELS.map((channel) => deps.on(channel, changed));
      return () => { for (const stop of stops) stop(); };
    },
    subscribe(refresh, authChanged) {
      let live = true;
      paused = false;
      notifyAuth = authChanged;
      const subscriptions = [
        deps.on('codex-usage:update', (value) => {
          // Ignore the broadcast caused by our own refresh, including failed
          // refreshes. Its direct response is consumed once, without a loop.
          // The run that consumes this re-checks auth first when it is due.
          if (!live || !readyForEvents || work || auth?.mode !== 'chatgpt') return;
          pendingEvent = { value, receivedAt: deps.now() };
          refresh();
        }),
        ...AUTH_CHANNELS.map((channel) => deps.on(channel, () => { if (live) authChanged(); })),
      ];
      return () => {
        live = false;
        paused = true;
        notifyAuth = undefined;
        pendingEvent = null;
        for (const unsubscribe of subscriptions) unsubscribe();
      };
    },
  };
  return adapter;
}

// Stateful collectors never share unbound quantities between panel instances.
export const codexAccountAdapter: AccountAdapter = {
  ...createCodexAccountAdapter(), create: () => createCodexAccountAdapter(),
};
