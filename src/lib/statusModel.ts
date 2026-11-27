/**
 * GET-223: provider-independent facts. Missing, unsupported and failed readings
 * are different answers; none is a measured zero. Scope travels with the value
 * so a renderer cannot accidentally turn account usage into session usage.
 */
export type ReadingState = 'available' | 'unsupported' | 'unauthenticated' | 'unavailable' | 'stale';
export type Capability = 'supported' | 'unsupported' | 'unknown';

export interface ReadingScope {
  kind: 'session' | 'workspace' | 'account';
  provider: string | null;
  workspacePath: string | null;
  sessionId?: string;
  /** Only a verified, non-secret stable identifier belongs here. */
  accountId?: string | null;
  configSource?: string;
  association?: 'verified' | 'unbound';
}

export interface ReadingMetadata {
  source: string;
  scope: ReadingScope;
  /** Source observation time, not the time a cached getter returned it. */
  observedAt: number | null;
  fetchedAt: number;
  /** GET-226: distinguish successful delivery from a failed/throttled attempt. */
  lastSuccessfulFetchAt?: number | null;
  lastAttemptAt?: number;
  staleAfterMs?: number;
  reason: string | null;
}

export type Reading<T> = ReadingMetadata & (
  | { state: 'available' | 'stale'; value: T }
  | { state: 'unsupported' | 'unauthenticated' | 'unavailable'; value: null }
);

export function missing<T>(
  state: 'unsupported' | 'unauthenticated' | 'unavailable',
  source: string,
  scope: ReadingScope,
  reason: string,
  now = Date.now(),
): Reading<T> {
  return { state, value: null, source, scope, reason, observedAt: null, fetchedAt: now };
}

export function measured<T>(
  value: T, source: string, scope: ReadingScope, observedAt: number | null,
  fetchedAt = Date.now(), staleAfterMs?: number,
): Reading<T> {
  observedAt = observedAt !== null && Number.isFinite(new Date(observedAt).getTime()) ? observedAt : null;
  const stale = staleAfterMs !== undefined &&
    (observedAt === null || observedAt > fetchedAt || fetchedAt - observedAt > staleAfterMs);
  return {
    state: stale ? 'stale' : 'available', value, source, scope, observedAt, fetchedAt, staleAfterMs,
    reason: stale ? 'The last reading is old or its observation time is unknown.' : null,
  };
}

/** Aging a cached value must not advance its successful observation/fetch time. */
export function ageReading<T>(reading: Reading<T>, now = Date.now()): Reading<T> {
  if (reading.state !== 'available' || reading.staleAfterMs === undefined) return reading;
  if (reading.observedAt !== null && reading.observedAt <= now &&
    now - reading.observedAt <= reading.staleAfterMs) return reading;
  return { ...reading, state: 'stale', value: reading.value,
    reason: 'The last reading is old or its observation time is unknown.' };
}

export interface ProviderIdentity {
  id: string | null;
  source: 'session' | 'catalog' | 'prefix' | 'unknown';
}

export interface StatusCapabilities {
  servedModel: Capability;
  effort: Capability;
  context: Capability;
  tokens: Capability;
  execution: Capability;
  accountUsage: Capability;
}

export interface ModelIdentity {
  requestedId: string;
  displayName: string | null;
  /** Only populated from an unambiguous catalog match to the actual served ID. */
  servedDisplayName?: string;
}
export interface WorkspacePolicy {
  mode: string;
  /** Keep the classifier flag: bypass with automatic review is a different policy. */
  allowAllUsesClassifier?: boolean;
}
export interface ReasoningEffort { level: string; source: 'session' | 'app-default' | 'builtin' }
export interface CurrentContext { tokens: number; window: number | null; percent: number | null }
export interface TokenCounters {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  providerCumulativeInputTokens?: number;
  providerCumulativeOutputTokens?: number;
  providerCumulativeCachedInputTokens?: number;
}
export interface ExecutionRestrictions {
  approvalPolicy?: string;
  reviewer?: string;
  sandbox?: string;
  filesystem?: string;
  network?: string;
}

export interface UsageWindow {
  id: string;
  label: string;
  /** GET-225: semantic placement supplied by the adapter; unknown roles stay additional. */
  role?: 'primary' | 'secondary' | 'additional';
  durationMinutes?: number;
  utilization: { value: number; unit: 'percent-used' | 'percent-remaining' | 'credits' | 'tokens' };
  resetsAt: string | null;
}
export interface UsageBucket {
  id: string;
  label: string;
  modelScope?: string;
  windows: UsageWindow[];
  plan?: string;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | number };
}
export interface AccountUsage {
  buckets: UsageBucket[];
  plan?: string;
  resetCredits?: { availableCount?: number; credits?: unknown[] | null };
}

export interface StatusModel {
  session: { id: string; title?: string } | null;
  provider: ProviderIdentity;
  capabilities: StatusCapabilities;
  model: Reading<ModelIdentity>;
  servedModel: Reading<string>;
  effort: Reading<ReasoningEffort>;
  workspacePolicy: Reading<WorkspacePolicy>;
  execution: Reading<ExecutionRestrictions>;
  context: Reading<CurrentContext>;
  tokens: Reading<TokenCounters>;
  /** May include explicitly attributed accounts unrelated to the selection. */
  accounts: Reading<AccountUsage>[];
}
