import type { AccountAdapter } from '../providerAdapters';
import { invokeQuiet, on } from '../ipc';
import { ageReading, measured, missing, type AccountUsage, type Reading, type ReadingScope, type UsageBucket, type UsageWindow } from '../statusModel';

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

export const CODEX_USAGE_UNBOUND =
  'Host-reported Codex allowance; account/session association and source observation time are unverified. ' +
  'This is not a universal ChatGPT allowance or a verified current-account reading.';
export const CODEX_READ_INTERVAL_MS = 60_000;
/** Two missed minute-budget reads count as old delivery, not unknown source age. */
export const CODEX_STALE_AFTER_MS = 2 * CODEX_READ_INTERVAL_MS;

export type CodexAuthMode = 'chatgpt' | 'apikey' | 'signed-out' | 'unknown';
interface AuthStatus { mode: CodexAuthMode; revision: string }

/** A private change detector, never an account ID or a rendered/persisted value. */
function authStatus(value: unknown): AuthStatus {
  const status = object(value);
  let mode: CodexAuthMode = 'unknown';
  if (status?.installed === true && !status.error) {
    if (status.isLoggedIn === false) mode = 'signed-out';
    else if (status.isLoggedIn === true && (status.authMode === 'chatgpt' || status.authMode === 'apikey')) mode = status.authMode;
  }
  return { mode, revision: JSON.stringify([mode, text(status?.email) ?? null, text(status?.planType) ?? null]) };
}

/** Shared timing only: no account data or unbound values cross monitor leases. */
export interface CodexReadBudget { authAt: number; usageAt: number; authPending: boolean; usagePending: boolean }
export const newCodexReadBudget = (): CodexReadBudget => ({ authAt: -Infinity, usageAt: -Infinity,
  authPending: false, usagePending: false });
const hostBudget = newCodexReadBudget();
interface CodexDependencies {
  invoke: (channel: string) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
  now: () => number;
  budget: CodexReadBudget;
}

/**
 * The first selected-Codex read checks auth and explicitly refreshes quantities.
 * Both existing host calls may start its managed auth app-server. Reuse that
 * lifecycle deliberately; never spawn a client or use the arbitrarily old getter.
 * Calls have a shared one-minute floor, including failures and selection churn.
 * Events are consumed locally and never cause another host refresh (GET-226).
 */
export function createCodexAccountAdapter(overrides: Partial<CodexDependencies> = {}): AccountAdapter {
  const deps: CodexDependencies = { invoke: invokeQuiet, on, now: Date.now, budget: hostBudget, ...overrides };
  let epoch = 0;
  let auth: AuthStatus | null = null;
  let authAt = -Infinity;
  let readyForEvents = false;
  let pendingEvent: { value: unknown; receivedAt: number } | null = null;
  let last: Reading<AccountUsage> | null = null;
  let work: Promise<Reading<AccountUsage>> | undefined;
  let notifyAuth: (() => void) | undefined;
  const invalidate = () => {
    epoch += 1; auth = null; authAt = -Infinity; readyForEvents = false;
    pendingEvent = null; last = null; work = undefined;
  };
  const absent = (scope: ReadingScope, reason: string,
    state: 'unavailable' | 'unauthenticated' | 'unsupported' = 'unavailable'): Reading<AccountUsage> => ({
    ...missing<AccountUsage>(state, 'codex-host-account', scope, reason, deps.now()),
    lastSuccessfulFetchAt: null, lastAttemptAt: deps.now(),
  });
  const failed = (scope: ReadingScope, reason: string): Reading<AccountUsage> => last?.value
    ? { ...last, state: 'stale', value: last.value, reason: `${reason} ${CODEX_USAGE_UNBOUND}`,
      lastAttemptAt: deps.now() }
    : absent(scope, reason);
  const receive = (value: unknown, scope: ReadingScope, receivedAt: number): Reading<AccountUsage> => {
    const usage = normalizeCodexHost(value);
    if (!usage) return failed(scope, 'Codex account allowance could not be read; the host response was unusable.');
    // Unknown source age is not a failed/old fetch. Keep it explicit and muted,
    // but reserve stale for failed refreshes or two minutes without delivery.
    last = { ...measured(usage, 'codex-host-account', scope, null, receivedAt),
      freshnessBasis: 'receipt', staleAfterMs: CODEX_STALE_AFTER_MS,
      reason: CODEX_USAGE_UNBOUND, lastSuccessfulFetchAt: receivedAt, lastAttemptAt: receivedAt };
    return last;
  };
  const adapter: AccountAdapter = {
    id: 'openai-codex', intervalMs: CODEX_READ_INTERVAL_MS, retainOnUnavailable: false,
    scope: (workspacePath) => ({ kind: 'account', provider: 'openai-codex', workspacePath,
      accountId: null, configSource: 'host-codex-usage', association: 'unbound' }),
    invalidate,
    collect(scope, signal) {
      if (work) return work;
      const generation = epoch;
      const valid = () => generation === epoch && !signal.aborted;
      const collect = async (): Promise<Reading<AccountUsage>> => {
        if (!valid()) return absent(scope, 'Codex reading cancelled.');
        const budget = deps.budget;
        // Event updates are useful only after an explicit account read in this
        // local epoch. The host cannot guarantee atomic ownership of broadcasts.
        if (auth?.mode === 'chatgpt' && deps.now() - authAt < CODEX_READ_INTERVAL_MS && pendingEvent) {
          const update = pendingEvent; pendingEvent = null;
          return receive(update.value, scope, update.receivedAt);
        }
        if (!auth || deps.now() - authAt >= CODEX_READ_INTERVAL_MS) {
          if (budget.authPending || deps.now() - budget.authAt < CODEX_READ_INTERVAL_MS) {
            return { ...absent(scope, 'Codex authentication check is throttled; waiting for the next account read.'),
              retryAt: Math.max(deps.now() + 250, budget.authAt + CODEX_READ_INTERVAL_MS) };
          }
          readyForEvents = false;
          budget.authAt = deps.now(); budget.authPending = true;
          let value: unknown;
          try { value = await deps.invoke('openai-codex:check-login'); }
          catch { value = null; }
          finally { budget.authPending = false; budget.authAt = deps.now(); }
          if (!valid()) return absent(scope, 'Codex reading cancelled after a scope/auth change.');
          const next = authStatus(value);
          if (auth && auth.revision !== next.revision) {
            // Clear the displayed/cache value at detection, before awaiting any
            // new quota request. Keep only the just-checked auth classification.
            notifyAuth?.();
            last = null; pendingEvent = null; readyForEvents = false;
          }
          auth = next; authAt = deps.now();
          if (!valid()) return absent(scope, 'Codex authentication changed; prior work was cancelled.');
        }
        if (auth.mode !== 'chatgpt') {
          last = null; readyForEvents = false; pendingEvent = null;
          return auth.mode === 'apikey'
            ? absent(scope, 'API-key authentication does not report a ChatGPT subscription allowance.', 'unsupported')
            : auth.mode === 'signed-out' ? absent(scope, 'Sign in to Codex with ChatGPT to read its allowance.', 'unauthenticated')
              : absent(scope, 'Codex authentication is unknown or could not be checked.');
        }
        if (budget.usagePending || deps.now() - budget.usageAt < CODEX_READ_INTERVAL_MS) {
          return { ...(last?.value ? { ...ageReading(last, deps.now()), lastAttemptAt: deps.now() }
            : absent(scope, 'Codex allowance refresh is throttled; waiting for the next account read.')),
            retryAt: Math.max(deps.now() + 250, budget.usageAt + CODEX_READ_INTERVAL_MS) };
        }
        readyForEvents = false;
        budget.usageAt = deps.now(); budget.usagePending = true;
        let value: unknown;
        try { value = await deps.invoke('codex-usage:refresh'); }
        catch { value = null; }
        finally { budget.usagePending = false; budget.usageAt = deps.now(); }
        if (!valid()) return absent(scope, 'Codex reading cancelled after a scope/auth change.');
        readyForEvents = true;
        return receive(value, scope, deps.now());
      };
      const current = collect().finally(() => { if (work === current) work = undefined; });
      work = current;
      return current;
    },
    subscribeInvalidation(changed) {
      const stops = ['openai-codex:auth-updated', 'openai-codex:auth-login-completed']
        .map((channel) => deps.on(channel, changed));
      return () => { for (const stop of stops) stop(); };
    },
    subscribe(refresh, authChanged) {
      let live = true;
      notifyAuth = authChanged;
      const subscriptions = [
        deps.on('codex-usage:update', (value) => {
          // Ignore the broadcast caused by our own refresh, including failed
          // refreshes. Its direct response is consumed once, without a loop.
          if (!live || !readyForEvents || work || auth?.mode !== 'chatgpt' ||
            deps.now() - authAt >= CODEX_READ_INTERVAL_MS) return;
          pendingEvent = { value, receivedAt: deps.now() };
          refresh();
        }),
        ...['openai-codex:auth-updated', 'openai-codex:auth-login-completed'].map((channel) =>
          deps.on(channel, () => { if (live) authChanged(); })),
      ];
      return () => { live = false; notifyAuth = undefined; for (const unsubscribe of subscriptions) unsubscribe(); invalidate(); };
    },
  };
  return adapter;
}

// Stateful collectors never share unbound quantities between panel instances.
export const codexAccountAdapter: AccountAdapter = {
  ...createCodexAccountAdapter(), create: () => createCodexAccountAdapter(),
};
