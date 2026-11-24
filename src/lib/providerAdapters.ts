import { extractTokenUsage, getServedModel, resolveEffortLevel } from './ipc';
import type { ModelInfo, SessionRecord } from './ipc';
import { providerIdentity } from './provider';
import { parseModelId } from './modelNames';
import { claudeAccountAdapter } from './providers/claude';
import {
  measured, missing, type AccountUsage, type Reading, type ReadingScope,
  type StatusCapabilities, type StatusModel, type TokenCounters, type CurrentContext, type ReasoningEffort, type WorkspacePolicy,
} from './statusModel';

export interface AccountIdentity {
  /** An internal change detector only; never persisted, logged or used as an account ID. */
  revision: string | null;
  authenticated: boolean | null;
  accountId: string | null;
}

export interface AccountAdapter {
  id: string;
  intervalMs: number;
  scope(workspacePath: string): ReadingScope;
  identity?: () => Promise<AccountIdentity>;
  collect: (scope: ReadingScope, signal: AbortSignal) => Promise<Reading<AccountUsage>>;
  subscribe?: (refresh: () => void, authChanged: () => void) => () => void;
  invalidate?: () => void;
}

export interface ProviderAdapter {
  id: string;
  capabilities: StatusCapabilities;
  readServedModel?: (sessionId: string) => Promise<string | null>;
  /** Optional model-level constraint on a provider's configured effort default. */
  canDefaultEffort?: (session: SessionRecord) => boolean;
  account?: AccountAdapter;
}

const GENERIC_CAPABILITIES: StatusCapabilities = {
  servedModel: 'unknown', effort: 'unknown', context: 'unknown', tokens: 'unknown',
  execution: 'unknown', accountUsage: 'unsupported',
};
export const genericAdapter: ProviderAdapter = { id: 'generic', capabilities: GENERIC_CAPABILITIES };

/**
 * Capabilities come from GET-222, not a model-name lookup table. In particular,
 * an API OpenAI model does not confer a ChatGPT subscription allowance. Codex's
 * account adapter belongs to GET-226; its missing host association is GET-228.
 */
export function createProviderRegistry(adapters: ProviderAdapter[] = []): Map<string, ProviderAdapter> {
  const known = (id: string, changes: Partial<StatusCapabilities>): ProviderAdapter => ({
    id, capabilities: { ...GENERIC_CAPABILITIES, ...changes },
  });
  const registry = new Map<string, ProviderAdapter>([
    ['claude-code', {
      ...known('claude-code', { servedModel: 'supported', effort: 'supported', context: 'supported',
        tokens: 'supported', accountUsage: 'supported' }),
      readServedModel: getServedModel, account: claudeAccountAdapter,
      // Audited host controls support these unversioned aliases. A new/pinned
      // ID without a session setting needs verified applicability, not a copied
      // model-version table or an assumed High value (GET-224).
      canDefaultEffort: (session) => {
        const model = parseModelId(session.model);
        return !!model && model.version === null && ['Opus', 'Sonnet', 'Haiku', 'Fable'].includes(model.family);
      },
    }],
    ['openai-codex', { ...known('openai-codex', {
      servedModel: 'unsupported', effort: 'supported', context: 'supported', tokens: 'supported',
      accountUsage: 'unknown',
    }), canDefaultEffort: (session) => !!session.model?.startsWith('openai-codex:') &&
      !!session.model.slice('openai-codex:'.length).trim() }],
    ['copilot-cli', known('copilot-cli', {
      servedModel: 'unsupported', effort: 'unsupported', context: 'unsupported', tokens: 'unsupported',
    })],
    ['cursor-agent', known('cursor-agent', {
      servedModel: 'unsupported', effort: 'unsupported', context: 'unsupported', tokens: 'supported',
    })],
  ]);
  for (const adapter of adapters) registry.set(adapter.id, adapter);
  return registry;
}

export const providerRegistry = createProviderRegistry();
export function adapterFor(provider: string | null, registry = providerRegistry): ProviderAdapter {
  return (provider && registry.get(provider)) || genericAdapter;
}

export interface SessionInputs {
  workspacePath: string;
  session: SessionRecord | null;
  models: ModelInfo[];
  defaultEffort: string | null;
  permissionMode: string | null;
  workspacePolicy?: WorkspacePolicy | null;
  workspacePolicySource?: string;
  servedModel?: Reading<string>;
  accounts?: Reading<AccountUsage>[];
  now?: number;
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Common facts remain usable even when no provider-specific collector exists. */
export function normalizeSessionStatus(input: SessionInputs, registry = providerRegistry): StatusModel {
  const { workspacePath, session, models, permissionMode } = input;
  const now = input.now ?? Date.now();
  const provider = providerIdentity(session, models);
  const adapter = adapterFor(provider.id, registry);
  const { capabilities } = adapter;
  const scope: ReadingScope = { kind: 'session', provider: provider.id, workspacePath,
    ...(session ? { sessionId: session.id } : {}) };
  const absent = <T>(capability: keyof StatusCapabilities, reason: string): Reading<T> =>
    missing(capabilities[capability] === 'unsupported' ? 'unsupported' : 'unavailable',
      'sessions:get', scope, session ? reason : 'No session resolved for this workspace', now);
  const matches = models.filter((entry) => entry.id === session?.model &&
    (!provider.id || !entry.provider || entry.provider === provider.id));
  const catalog = matches.length === 1 ? matches[0] : undefined;
  const servedMatches = models.filter((entry) => entry.id === input.servedModel?.value &&
    (!provider.id || !entry.provider || entry.provider === provider.id));
  const servedCatalog = servedMatches.length === 1 ? servedMatches[0] : undefined;
  const tokens = extractTokenUsage(session);
  const counters: TokenCounters = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadInputTokens',
    'cacheCreationInputTokens', 'reasoningTokens', 'providerCumulativeInputTokens',
    'providerCumulativeOutputTokens', 'providerCumulativeCachedInputTokens'] as const) {
    if (number(tokens?.[key])) counters[key] = tokens[key];
  }
  const capacity = [tokens?.currentContext?.contextWindow, tokens?.contextWindow, catalog?.contextWindow]
    .find((value) => number(value) && value > 0) ?? null;
  const fill = tokens?.currentContext?.tokens;
  const context = capabilities.context !== 'unsupported' && number(fill)
    ? measured({ tokens: fill, window: capacity,
      percent: capacity ? Math.min(fill / capacity * 100, 100) : null },
    'sessions:get:currentContext', scope, null, now)
    : absent<CurrentContext>('context',
      !tokens ? 'Token usage is not reported for this session' : 'Current context occupancy is not reported for this session');

  const explicitEffort = session?.metadata?.effortLevel;
  const hasEffort = typeof explicitEffort === 'string' && !!explicitEffort.trim();
  const effort = session && capabilities.effort !== 'unsupported' &&
    (hasEffort || (capabilities.effort === 'supported' && (adapter.canDefaultEffort?.(session) ?? true)))
    ? measured(resolveEffortLevel(session, input.defaultEffort), 'configured-effort', scope, null, now)
    : absent<ReasoningEffort>('effort', 'Configured reasoning effort is not reported for this model and provider');
  const policy = input.workspacePolicy === undefined
    ? (permissionMode ? { mode: permissionMode } : null) : input.workspacePolicy;

  return {
    session: session ? { id: session.id, title: session.title } : null, provider, capabilities,
    model: session?.model ? measured({ requestedId: session.model, displayName: catalog?.name ?? null,
      ...(servedCatalog?.name ? { servedDisplayName: servedCatalog.name } : {}) },
      catalog || servedCatalog ? 'sessions:get+ai:getModels' : 'sessions:get', scope, null, now)
      : missing('unavailable', 'sessions:get', scope, session ? 'No model reported' : 'No session resolved', now),
    servedModel: input.servedModel ?? absent('servedModel', 'No verified served model is available'),
    effort,
    workspacePolicy: policy ? measured(policy, input.workspacePolicySource ?? 'workspace:get-state',
      { kind: 'workspace', provider: null, workspacePath }, null, now)
      : missing('unavailable', 'workspace:get-state', { kind: 'workspace', provider: null, workspacePath },
        'Workspace permission policy is unavailable', now),
    execution: missing(capabilities.execution === 'unsupported' ? 'unsupported' : 'unavailable', 'host-session-status', scope,
      'This host does not report the session’s effective execution restrictions', now),
    context,
    tokens: capabilities.tokens !== 'unsupported' && Object.keys(counters).length
      ? measured(counters, 'sessions:get:tokenUsage', scope, null, now)
      : absent('tokens', 'No measured session token counters'),
    accounts: input.accounts ?? [],
  };
}

/** GET-225 replaces this compatibility view with configurable usage groups. */
export function selectedAccountUsage(model: StatusModel): Reading<AccountUsage> {
  return model.accounts.find((entry) => entry.scope.provider === model.provider.id) ??
    missing(model.capabilities.accountUsage === 'unsupported' ? 'unsupported' : 'unavailable',
      'provider-adapter', { kind: 'account', provider: model.provider.id,
        workspacePath: model.model.scope.workspacePath, accountId: null, association: 'unbound' },
      'No account usage adapter is available for this provider');
}
