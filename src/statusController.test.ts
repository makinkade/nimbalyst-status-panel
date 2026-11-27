import { readFileSync } from 'node:fs';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusController, SESSION_SNAPSHOT_LIMIT, type Status, type StatusDependencies } from './statusController';
import { latestServedModel, normalizeModels, selectedSessionId, type SessionRecord, type WorkspaceState } from './lib/ipc';
import { adapterFor, createProviderRegistry, type AccountAdapter, type AccountIdentity } from './lib/providerAdapters';
import { measured, type AccountUsage, type Reading, type ReadingScope } from './lib/statusModel';
import { normalizeClaudePlan } from './lib/providers/claude';
import { createCodexAccountAdapter, newCodexReadBudget } from './lib/providers/codex';
import { buildSegments } from './StatusPanel';

const fixture = JSON.parse(readFileSync(new URL('./lib/fixtures/status-host-0.83.0.json', import.meta.url), 'utf8'));
const payload = (channel: string, index = 0) => fixture.observations.filter((row: { channel: string }) => row.channel === channel)[index].payload;
const codex: SessionRecord = payload('sessions:get').session;
const claude: SessionRecord = payload('sessions:get', 1).session;
const controllers: StatusController[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
function rendered(status: Status) {
  const segments = buildSegments(status, status.workspacePath);
  return ['model', 'effort', 'permissionMode', 'context'].map((id) =>
    renderToStaticMarkup(createElement(Fragment, null, segments[id as keyof typeof segments]))).join('');
}
const stateFor = (id: string | null): WorkspaceState => ({ ...payload('workspace:get-state'),
  agenticCodingWindowState: { selectedWorkstream: id ? { type: 'session', id } : null } });

function harness(overrides: Partial<StatusDependencies> = {}, workspacePath = '<workspace>') {
  let selected: string | null = codex.id;
  const records = new Map([[codex.id, codex], [claude.id, claude]]);
  const events = new Map<string, Set<() => void>>();
  const unsubscribers: ReturnType<typeof vi.fn>[] = [];
  const subscribe = (channel: string, callback: () => void) => {
    const listeners = events.get(channel) ?? new Set();
    listeners.add(callback);
    events.set(channel, listeners);
    const unsubscribe = vi.fn(() => { listeners.delete(callback); });
    unsubscribers.push(unsubscribe);
    return unsubscribe;
  };
  const served = vi.fn(async () => latestServedModel(payload('transcript:get-tail-messages', 1)));
  const deps: StatusDependencies = {
    getWorkspaceState: vi.fn(async () => stateFor(selected)),
    getFocusedSession: vi.fn(async (_path, state) => records.get(selectedSessionId(state) ?? '') ?? null),
    getModels: vi.fn(async () => normalizeModels(payload('ai:getModels'))),
    getDefaultEffortLevel: vi.fn(async () => payload('settings:get-default-effort-level')),
    getWorkspacePolicy: vi.fn(async () => ({ policy: { mode: 'bypass-all', allowAllUsesClassifier: true }, source: 'workspace:get-state' })),
    getGitInfo: vi.fn(async () => ({ isRepo: true, repoPath: workspacePath, branch: 'master', dirtyCount: 1 })),
    on: subscribe, onWindowEvent: subscribe,
    // Common-status tests isolate host account collection; live-adapter cases inject it below.
    registry: createProviderRegistry([
      { ...adapterFor('claude-code'), readServedModel: served, account: undefined },
      { ...adapterFor('openai-codex'), account: undefined },
    ]),
    relatedAccounts: [], ...overrides,
  };
  const updates: Status[] = [];
  const controller = new StatusController(workspacePath, (status) => updates.push(status), deps);
  controllers.push(controller);
  controller.start();
  return { controller, deps, records, events, unsubscribers, served, updates,
    select: (id: string | null) => { selected = id; }, latest: () => updates[updates.length - 1]! };
}

/** Synthetic auth identities exercise epochs; the real host has no such binding. */
function account() {
  let identity: AccountIdentity = { revision: 'private-A', authenticated: true, accountId: 'scope-A' };
  const callbacks: { refresh: () => void; auth: () => void }[] = [];
  const unsubscribers: ReturnType<typeof vi.fn>[] = [];
  const scope = (workspacePath: string): ReadingScope => ({ kind: 'account', provider: 'synthetic-account',
    workspacePath, accountId: null, association: 'unbound' });
  const collect = vi.fn(async (scope: ReadingScope, _signal: AbortSignal) =>
    measured<AccountUsage>({ buckets: [] }, 'synthetic', scope, Date.now(), Date.now(), 300000));
  const adapter: AccountAdapter = {
    id: 'synthetic-account', intervalMs: 60000, scope, collect,
    identity: vi.fn(async () => identity), invalidate: vi.fn(),
    subscribe(refresh, auth) {
      callbacks.push({ refresh, auth });
      const unsubscribe = vi.fn();
      unsubscribers.push(unsubscribe);
      return unsubscribe;
    },
  };
  return { adapter, collect, callbacks, unsubscribers,
    identify: (value: AccountIdentity) => { identity = value; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(fixture.provenance.capturedAt)); });
afterEach(() => { for (const controller of controllers.splice(0)) controller.stop(); vi.useRealTimers(); });

describe('production status lifecycle with audited session/catalog payloads', () => {
  it('renders muted live Codex usage through throttled polling and provider switches', async () => {
    const invoke = vi.fn(async (channel: string) => channel === 'openai-codex:check-login'
      ? payload(channel) : payload('codex-usage:refresh'));
    const on = vi.fn(() => () => {});
    const codexAdapter = createCodexAccountAdapter({ invoke, on, budget: newCodexReadBudget() });
    try {
      const usage = account();
      usage.adapter.id = 'claude-code';
      usage.adapter.scope = (workspacePath) => ({ kind: 'account', provider: 'claude-code', workspacePath,
        accountId: null, association: 'unbound' });
      usage.collect.mockImplementation(async (scope) => measured(normalizeClaudePlan({ fiveHour: 91 }),
        'synthetic-claude', scope, Date.now(), Date.now(), 300000));
      const h = harness({ relatedAccounts: [usage.adapter], registry: createProviderRegistry([
        { ...adapterFor('openai-codex'), account: codexAdapter },
        { ...adapterFor('claude-code'), account: undefined },
      ]) });
      await flush();
      await vi.advanceTimersByTimeAsync(120000);
      for (const status of h.updates.filter((status) => status.readings.session?.id === codex.id)) {
        const reading = status.readings.accounts.find((reading) => reading.scope.provider === 'openai-codex');
        if (reading?.value) expect(reading).toMatchObject({ state: 'available', freshnessBasis: 'receipt', observedAt: null, scope: { association: 'unbound' } });
      }
      const segments = buildSegments(h.latest(), '<workspace>');
      const html = renderToStaticMarkup(createElement(Fragment, null,
        segments.usagePrimary, segments.usageSecondary, segments.usageAdditional));
      expect(html).toContain('Host-reported Codex');
      expect(html).toContain('20% used');
      expect(html).toContain('unverified');
      expect(html).toContain('openai-codex');
      expect(html).not.toContain('91%');
      expect(html).toContain('role="img"');
      h.select(claude.id);
      await h.controller.pollSelection();
      await flush();
      expect(h.latest().readings.accounts.find((reading) => reading.scope.provider === 'claude-code')?.value).not.toBeNull();
      expect(h.latest().readings.accounts.some((reading) => reading.scope.provider === 'openai-codex')).toBe(false);
      h.select(codex.id);
      await h.controller.pollSelection();
      await flush();
      expect(h.latest().readings.accounts.find((reading) => reading.scope.provider === 'openai-codex'))
        .toMatchObject({ state: 'stale', cached: true, observedAt: null });
      // Returning uses a display-only session snapshot; collection still starts
      // a new epoch and respects the shared request floor.
      await vi.advanceTimersByTimeAsync(60000);
      expect(h.latest().readings.accounts.find((reading) => reading.scope.provider === 'openai-codex'))
        .toMatchObject({ state: 'available', observedAt: null, scope: { association: 'unbound' } });
      expect(invoke.mock.calls.filter(([channel]) => channel === 'openai-codex:check-login')).toHaveLength(4);
      expect(invoke.mock.calls.filter(([channel]) => channel === 'codex-usage:refresh')).toHaveLength(4);
      expect(on).toHaveBeenCalled();
      h.controller.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders selected-provider groups without flashing retained or late Claude quota', async () => {
    const usage = account();
    usage.adapter.id = 'claude-code';
    usage.adapter.scope = (workspacePath) => ({ kind: 'account', provider: 'claude-code', workspacePath,
      accountId: null, association: 'unbound' });
    usage.collect.mockImplementation(async (scope) => measured(normalizeClaudePlan({ fiveHour: 91 }),
      'synthetic-claude', scope, Date.now(), Date.now(), 300000));
    const h = harness({ relatedAccounts: [usage.adapter] });
    const renderUsage = (status: Status) => {
      const segments = buildSegments(status, status.workspacePath);
      return ['usagePrimary', 'usageSecondary', 'usageAdditional'].map((id) =>
        renderToStaticMarkup(createElement(Fragment, null, segments[id as keyof typeof segments]))).join('');
    };
    await flush();
    expect(renderUsage(h.latest())).not.toContain('91%');
    h.select(claude.id);
    await h.controller.pollSelection();
    await flush();
    expect(renderUsage(h.latest())).toContain('Claude 5h');
    expect(renderUsage(h.latest())).toContain('91% used');
    const late = deferred<Reading<AccountUsage>>();
    usage.collect.mockReturnValueOnce(late.promise);
    usage.callbacks[usage.callbacks.length - 1].refresh();
    await flush();
    const switchedAt = h.updates.length;
    h.select(codex.id);
    await h.controller.pollSelection();
    await flush();
    late.resolve(measured(normalizeClaudePlan({ fiveHour: 99 }), 'late-Claude', usage.adapter.scope('<workspace>'),
      Date.now(), Date.now(), 300000));
    await flush();
    for (const state of h.updates.slice(switchedAt)) {
      expect(renderUsage(state)).not.toContain('91%');
      expect(renderUsage(state)).not.toContain('99%');
    }
    expect(renderUsage(h.latest())).toContain('openai-codex');
    expect(renderUsage(h.latest())).toContain('unavailable');
    expect(usage.unsubscribers[0]).toHaveBeenCalled();
  });

  it('preserves the 1 s selection poll and 5 s full refresh with no per-tick quota request', async () => {
    const usage = account();
    const h = harness({ relatedAccounts: [usage.adapter] });
    await flush();
    expect(h.latest().readings.provider.id).toBe('openai-codex');
    expect(h.latest().readings.context.value?.window).toBe(475000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.deps.getFocusedSession).toHaveBeenCalledTimes(1);
    expect(h.deps.getWorkspaceState).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.deps.getFocusedSession).toHaveBeenCalledTimes(2);
    expect(usage.collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(55000);
    expect(h.deps.getFocusedSession).toHaveBeenCalledTimes(13);
    expect(usage.collect).toHaveBeenCalledTimes(2);
    expect(usage.adapter.identity).toHaveBeenCalledTimes(2);
  });

  it('clears the old session immediately on observation and discards late A → B → A results', async () => {
    const h = harness();
    await flush();
    const firstA = deferred<SessionRecord | null>();
    const b = deferred<SessionRecord | null>();
    const nextA = deferred<SessionRecord | null>();
    vi.mocked(h.deps.getFocusedSession).mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(b.promise).mockReturnValueOnce(nextA.promise);
    const oldA = h.controller.refresh();
    await flush();
    h.select(claude.id);
    const pendingB = h.controller.pollSelection();
    await flush();
    expect(h.latest().readings.session).toBeNull();
    expect(rendered(h.latest())).toContain('No session');
    expect(rendered(h.latest())).not.toContain(codex.model!);
    h.select(codex.id);
    const pendingA = h.controller.pollSelection();
    await flush();
    nextA.resolve(codex);
    await pendingA;
    await flush(); // The independent Codex fallback can publish after common status.
    const committed = h.latest();
    b.resolve(claude);
    firstA.resolve({ ...codex, model: 'obsolete:model' });
    await Promise.all([oldA, pendingB]);
    expect(h.latest()).toBe(committed);
    expect(h.latest().readings.model.value?.requestedId).toBe(codex.model);
    expect(rendered(h.latest())).toContain('GPT-6.1 Sol');
    expect(rendered(h.latest())).not.toContain(claude.model!);
  });

  it('catches a selection change before the first full record resolves', async () => {
    const first = deferred<SessionRecord | null>();
    const focused = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(claude);
    const h = harness({ getFocusedSession: focused });
    await flush();
    h.select(claude.id);
    await h.controller.pollSelection();
    expect(h.latest().readings.session?.id).toBe(claude.id);
    first.resolve(codex);
    await flush();
    expect(h.latest().readings.session?.id).toBe(claude.id);
  });

  it('ignores an older workspace read when a later poll already observed another selection', async () => {
    const h = harness();
    await flush();
    const oldState = deferred<WorkspaceState | null>();
    vi.mocked(h.deps.getWorkspaceState).mockReturnValueOnce(oldState.promise);
    const old = h.controller.refresh();
    h.select(claude.id);
    await h.controller.pollSelection();
    oldState.resolve(stateFor(codex.id));
    await old;
    expect(h.latest().readings.session?.id).toBe(claude.id);
  });

  it('finds switches on a full refresh and disposes account subscriptions on provider changes', async () => {
    const usage = account();
    const h = harness({ relatedAccounts: [usage.adapter] });
    await flush();
    h.select(claude.id);
    await h.controller.refresh();
    await flush();
    expect(h.latest().readings.servedModel.value).toBe('claude-opus-5-5');
    expect(usage.unsubscribers[0]).toHaveBeenCalledTimes(1);
    const count = usage.collect.mock.calls.length;
    usage.callbacks[0].auth();
    usage.callbacks[0].refresh();
    await flush();
    expect(usage.collect).toHaveBeenCalledTimes(count);
    expect(usage.adapter.invalidate).not.toHaveBeenCalled();
  });

  it('invalidates account callbacks when the provider changes inside the same selected session', async () => {
    const usage = account();
    const h = harness({ relatedAccounts: [usage.adapter] });
    await flush();
    h.records.set(codex.id, { ...claude, id: codex.id });
    await h.controller.refresh();
    await flush();
    expect(h.latest().readings.session?.id).toBe(codex.id);
    expect(h.latest().readings.provider.id).toBe('claude-code');
    expect(rendered(h.latest())).toContain('Opus 5.5 (1M)');
    expect(rendered(h.latest())).not.toContain('GPT-6.1 Sol');
    expect(usage.unsubscribers[0]).toHaveBeenCalledTimes(1);
    const count = usage.collect.mock.calls.length;
    usage.callbacks[0].refresh();
    await flush();
    expect(usage.collect).toHaveBeenCalledTimes(count);
  });

  it('remembers a last-observed served model only for that session/provider/requested model', async () => {
    const h = harness();
    h.select(claude.id);
    await h.controller.pollSelection();
    h.served.mockResolvedValue(null);
    await h.controller.refresh();
    expect(h.latest().readings.servedModel).toMatchObject({ state: 'stale', value: 'claude-opus-5-5' });
    const count = h.updates.length;
    await h.controller.refresh();
    expect(h.updates.slice(count).every((update) => update.readings.servedModel.state === 'stale')).toBe(true);
    h.records.set(claude.id, { ...claude, model: 'claude-code:sonnet' });
    await h.controller.refresh();
    expect(h.latest().readings.servedModel.value).toBeNull();
    expect(rendered(h.latest())).toContain('>Sonnet<');
    expect(rendered(h.latest())).not.toContain('Opus 5.5');
    h.records.set(claude.id, { ...claude, provider: 'custom', model: 'custom:new' });
    await h.controller.refresh();
    expect(h.latest().readings.provider.id).toBe('custom');
    expect(h.latest().readings.servedModel.value).toBeNull();
    expect(rendered(h.latest())).toContain('custom new');
    expect(rendered(h.latest())).not.toContain('Sonnet');
  });

  it('never renders a late reply from a previously selected provider', async () => {
    const pending = deferred<string | null>();
    const h = harness();
    await flush();
    h.served.mockReturnValueOnce(pending.promise);
    h.select(claude.id);
    const old = h.controller.pollSelection();
    await flush();
    expect(rendered(h.latest())).toContain('Requested model: claude-code:opus-1m');
    h.select(codex.id);
    await h.controller.pollSelection();
    await flush(); // Settle the selected adapter before testing the old transcript.
    const count = h.updates.length;
    pending.resolve('claude-sonnet-5');
    await old;
    expect(h.updates).toHaveLength(count);
    expect(rendered(h.latest())).toContain('GPT-6.1 Sol');
    expect(rendered(h.latest())).not.toContain('claude-sonnet-5');
  });

  it('detaches pending session, selection and account work on unmount and clears a lost workspace', async () => {
    const usage = account();
    const pendingUsage = deferred<Awaited<ReturnType<AccountAdapter['collect']>>>();
    usage.collect.mockReturnValue(pendingUsage.promise);
    const h = harness({ relatedAccounts: [usage.adapter] });
    await flush();
    const pendingSession = deferred<SessionRecord | null>();
    vi.mocked(h.deps.getFocusedSession).mockReturnValueOnce(pendingSession.promise);
    const refresh = h.controller.refresh();
    await flush();
    const pendingState = deferred<WorkspaceState | null>();
    vi.mocked(h.deps.getWorkspaceState).mockReturnValueOnce(pendingState.promise);
    const poll = h.controller.pollSelection();
    const count = h.updates.length;
    h.controller.stop();
    const empty = harness({}, '');
    expect(empty.latest()).toMatchObject({ loading: false, git: { branch: null }, readings: { session: null, accounts: [] } });
    pendingSession.resolve(claude);
    pendingState.resolve(stateFor(claude.id));
    pendingUsage.resolve(measured({ buckets: [] }, 'late', usage.adapter.scope('<workspace>'), Date.now()));
    await Promise.all([refresh, poll]);
    await flush();
    expect(h.updates).toHaveLength(count);
    expect(h.unsubscribers.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
    expect(usage.unsubscribers[0]).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces overlapping full refreshes rather than running duplicate git work', async () => {
    const h = harness();
    await flush();
    const pending = deferred<SessionRecord | null>();
    vi.mocked(h.deps.getFocusedSession).mockReturnValueOnce(pending.promise);
    const first = h.controller.refresh();
    await flush();
    const second = h.controller.refresh();
    await flush();
    expect(h.deps.getGitInfo).toHaveBeenCalledTimes(2);
    pending.resolve(codex);
    await Promise.all([first, second]);
  });

  it('publishes common facts and quota independently of a slow or failing served-model source', async () => {
    const pending = deferred<string | null>();
    const usage = account();
    const registry = createProviderRegistry([{ ...adapterFor('openai-codex'), readServedModel: () => pending.promise }]);
    const h = harness({ registry, relatedAccounts: [usage.adapter] });
    await flush();
    expect(h.latest().readings.session?.id).toBe(codex.id);
    expect(h.latest().git.branch).toBe('master');
    expect(usage.collect).toHaveBeenCalledTimes(1);
    pending.resolve(null);
    await flush();
    registry.set('openai-codex', { ...adapterFor('openai-codex'), readServedModel: async () => { throw new Error('unavailable'); } });
    await h.controller.refresh();
    expect(h.latest().readings.context.value?.tokens).toBe(124715);
  });

  it('keeps directory/git and workspace policy without a session or account adapter', async () => {
    const h = harness();
    h.select(null);
    await h.controller.pollSelection();
    expect(h.latest().readings.session).toBeNull();
    expect(h.latest().readings.accounts).toEqual([]);
    expect(h.latest().git.branch).toBe('master');
    expect(h.latest().readings.workspacePolicy.value).toEqual({ mode: 'bypass-all', allowAllUsesClassifier: true });
  });
});

describe('account auth epochs (synthetic contract cases)', () => {
  it('clears prior account values on auth events and ignores a late response from that account', async () => {
    const usage = account();
    const h = harness({ relatedAccounts: [usage.adapter] });
    await flush();
    expect(h.latest().readings.accounts[0].scope.accountId).toBe('scope-A');
    const old = deferred<Awaited<ReturnType<AccountAdapter['collect']>>>();
    usage.collect.mockReturnValueOnce(old.promise);
    usage.callbacks[0].refresh();
    await flush();
    usage.identify({ revision: 'private-B', authenticated: true, accountId: 'scope-B' });
    usage.callbacks[0].auth();
    expect(h.latest().readings.accounts[0].value).toBeNull();
    await flush();
    expect(h.latest().readings.accounts[0].scope.accountId).toBe('scope-B');
    old.resolve(measured({ buckets: [{ id: 'old', label: 'Old account', windows: [] }] }, 'late',
      { ...usage.adapter.scope('<workspace>'), accountId: 'scope-A' }, Date.now()));
    await flush();
    expect(h.latest().readings.accounts[0].scope.accountId).toBe('scope-B');
    expect(h.latest().readings.accounts[0].value?.buckets).toEqual([]);
    expect(JSON.stringify(h.latest())).not.toContain('private-');
  });

  it('uses affirmative auth state for signed-out accounts without calling the collector', async () => {
    const usage = account();
    usage.identify({ revision: 'signed-out', authenticated: false, accountId: null });
    const h = harness({ relatedAccounts: [usage.adapter] });
    await flush();
    expect(h.latest().readings.accounts[0].state).toBe('unauthenticated');
    expect(usage.collect).not.toHaveBeenCalled();
    usage.identify({ revision: null, authenticated: null, accountId: null });
    usage.callbacks[0].auth();
    await flush();
    expect(h.latest().readings.accounts[0].state).toBe('available');
    expect(h.latest().readings.accounts[0].scope).toMatchObject({ accountId: null, association: 'unbound' });
  });

  it('detects identity changes at the quota cadence even without an auth event', async () => {
    const usage = account();
    const h = harness({ relatedAccounts: [usage.adapter] });
    await flush();
    usage.identify({ revision: 'private-B', authenticated: true, accountId: 'scope-B' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.latest().readings.accounts[0].scope.accountId).toBe('scope-B');
    expect(usage.adapter.invalidate).toHaveBeenCalled();
    expect(usage.adapter.identity).toHaveBeenCalledTimes(2);
  });

  it('invalidates on affirmative auth changes even if the source has no revision or account ID', async () => {
    const usage = account();
    usage.identify({ revision: null, authenticated: true, accountId: null });
    const h = harness({ relatedAccounts: [usage.adapter] });
    await flush();
    usage.identify({ revision: null, authenticated: false, accountId: null });
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.latest().readings.accounts[0]).toMatchObject({ state: 'unauthenticated', value: null });
    expect(usage.adapter.invalidate).toHaveBeenCalled();
  });
});

/** GET-227: source-derived capabilities and synthetic providers, not live executions. */
describe('provider matrix through the production controller and all configured cards', () => {
  it.each(['copilot-cli', 'cursor-agent', 'lmstudio', 'openai', 'custom-local', 'future-provider', null])(
    'keeps common status useful without quota for %s', async (provider) => {
      const session: SessionRecord = { id: 'matrix', model: 'Future_Model/V2.17_Q8',
        ...(provider ? { provider } : {}), metadata: { tokenUsage: {
          totalTokens: 9000, currentContext: { tokens: 0, contextWindow: 2000 },
        } } };
      const h = harness({ getFocusedSession: vi.fn(async () => session) });
      await flush();
      const status = h.latest();
      const segments = buildSegments(status, status.workspacePath);
      const html = renderToStaticMarkup(createElement(Fragment, null, ...Object.values(segments)));
      expect(html).toContain('Future Model V2.17 Q8');
      expect(html).toContain('Effort —');
      expect(html).toContain('master');
      expect(html).toContain('±1');
      expect(html).toContain('Workspace: Agent-verified');
      expect(html).toContain('effective execution restrictions');
      expect(html).not.toContain('Claude 5h');
      expect(html).not.toContain('Host-reported Codex');
      for (const segment of Object.values(segments)) {
        expect(renderToStaticMarkup(createElement(Fragment, null, segment))).not.toBe('');
      }
      expect(status.readings.context.state).toBe(provider === 'copilot-cli' || provider === 'cursor-agent' ? 'unsupported' : 'available');
      if (status.readings.context.value) expect(html).toContain('0%');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(status.readings.accounts).toEqual([]);
      expect(h.deps.getFocusedSession).toHaveBeenCalledTimes(13);
    });
});

/** GET-227 follow-up: per-session display snapshots never confer account ownership. */
describe('cached session return while refreshing', () => {
  it('restores only the returning session before a delayed full read, then replaces its cached facts', async () => {
    const h = harness(); await flush();
    const first = h.latest();
    h.select(claude.id); await h.controller.pollSelection(); await flush();
    const pending = deferred<SessionRecord | null>();
    vi.mocked(h.deps.getFocusedSession).mockReturnValueOnce(pending.promise);
    h.select(codex.id); const returning = h.controller.pollSelection(); await flush();
    expect(h.latest()).toMatchObject({ cached: true, readings: { session: { id: codex.id },
      context: { state: 'stale', cached: true, value: first.readings.context.value } } });
    expect(rendered(h.latest())).toContain('GPT-6.1 Sol');
    expect(rendered(h.latest())).not.toContain('Opus');
    expect(first.readings.context.cached).toBeUndefined(); // no mutation of the original snapshot
    const updated = structuredClone(codex);
    updated.metadata = { tokenUsage: { currentContext: { tokens: 100, contextWindow: 1000 } } };
    pending.resolve(updated); await returning; await flush();
    expect(h.latest().cached).not.toBe(true);
    expect(h.latest().readings.context).toMatchObject({ state: 'available', value: { tokens: 100, percent: 10 } });
  });

  it('preserves Codex windows and timestamps while throttled and retries at the actual request floor', async () => {
    let quota = structuredClone(payload('codex-usage:refresh'));
    const invoke = vi.fn(async (channel: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return channel === 'openai-codex:check-login' ? payload(channel) : quota;
    });
    const adapter = createCodexAccountAdapter({ invoke, on: () => () => {}, budget: newCodexReadBudget() });
    const h = harness({ registry: createProviderRegistry([{ ...adapterFor('openai-codex'), account: adapter }]) });
    await vi.advanceTimersByTimeAsync(2500);
    const original = h.latest().readings.accounts.find(a => a.scope.provider === 'openai-codex')!;
    expect(original.value).not.toBeNull();
    h.select(claude.id); await h.controller.pollSelection(); await flush();
    h.select(codex.id); await h.controller.pollSelection(); await flush();
    const cached = h.latest().readings.accounts.find(a => a.scope.provider === 'openai-codex')!;
    expect(cached).toMatchObject({ cached: true, value: original.value, fetchedAt: original.fetchedAt,
      lastSuccessfulFetchAt: original.lastSuccessfulFetchAt, observedAt: null });
    const html = renderToStaticMarkup(createElement(Fragment, null, ...Object.values(buildSegments(h.latest(), '<workspace>'))));
    expect(html).toContain('20% used (cached)');
    expect(html).toContain('previous visit to this session');
    expect(invoke).toHaveBeenCalledTimes(2);
    quota.limits[0].windows[0].usedPercent = 35;
    await vi.advanceTimersByTimeAsync(58499);
    expect(invoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // t=61s: initial auth finished at t=1s
    expect(invoke).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);
    const refreshed = h.latest().readings.accounts.find(a => a.scope.provider === 'openai-codex')!;
    expect(refreshed.cached).not.toBe(true);
    expect(refreshed.value?.buckets[0].windows[0].utilization.value).toBe(35);
    expect(refreshed.fetchedAt).toBeGreaterThan(original.fetchedAt);
    h.controller.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps separate snapshots for two sessions from the same provider', async () => {
    const usage = account(); usage.adapter.identity = undefined;
    usage.adapter.id = 'openai-codex';
    usage.adapter.scope = workspacePath => ({ kind: 'account', provider: 'openai-codex', workspacePath, association: 'unbound' });
    let amount = 20;
    usage.collect.mockImplementation(async scope => measured(normalizeClaudePlan({ fiveHour: amount }), 'synthetic', scope, Date.now()));
    const h = harness({ registry: createProviderRegistry([{ ...adapterFor('openai-codex'), account: usage.adapter }]) });
    const second = { ...codex, id: 'second-codex' }; h.records.set(second.id, second);
    await flush(); amount = 70;
    h.select(second.id); await h.controller.pollSelection(); await flush();
    expect(h.latest().readings.accounts[0].value?.buckets[0].windows[0].utilization.value).toBe(70);
    const pending = deferred<Reading<AccountUsage>>(); usage.collect.mockReturnValueOnce(pending.promise);
    h.select(codex.id); await h.controller.pollSelection(); await flush();
    expect(h.latest().readings.accounts[0]).toMatchObject({ cached: true });
    expect(h.latest().readings.accounts[0].value?.buckets[0].windows[0].utilization.value).toBe(20);
    pending.resolve(measured(normalizeClaudePlan({ fiveHour: 25 }), 'synthetic', usage.adapter.scope('<workspace>'), Date.now()));
    await flush(); expect(h.latest().readings.accounts[0].cached).not.toBe(true);
  });

  it('purges inactive Codex snapshots on auth events without reading the host in the background', async () => {
    const callbacks = new Map<string, Set<(...args: unknown[]) => void>>();
    const on = (channel: string, callback: (...args: unknown[]) => void) => {
      const set = callbacks.get(channel) ?? new Set(); set.add(callback); callbacks.set(channel, set);
      return () => { set.delete(callback); };
    };
    const invoke = vi.fn(async (channel: string) => channel === 'openai-codex:check-login' ? payload(channel) : payload('codex-usage:refresh'));
    const adapter = createCodexAccountAdapter({ invoke, on, budget: newCodexReadBudget() });
    const h = harness({ registry: createProviderRegistry([{ ...adapterFor('openai-codex'), account: adapter }]) });
    await flush(); expect(h.latest().readings.accounts[0].value).not.toBeNull();
    h.select(claude.id); await h.controller.pollSelection(); await flush();
    for (const callback of callbacks.get('openai-codex:auth-updated')!) callback({});
    await flush(); expect(invoke).toHaveBeenCalledTimes(2);
    h.select(codex.id); await h.controller.pollSelection(); await flush();
    expect(h.latest().readings.accounts[0].value).toBeNull();
    expect(h.latest().readings.accounts[0].cached).not.toBe(true);
    h.controller.stop();
    expect([...callbacks.values()].every(set => set.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['unauthenticated', 'unsupported', 'unavailable'] as const)('does not preserve cached allowance after a completed %s result', async state => {
    const usage = account(); usage.adapter.identity = undefined;
    usage.adapter.id = 'openai-codex'; usage.adapter.scope = workspacePath => ({ kind: 'account', provider: 'openai-codex', workspacePath });
    usage.collect.mockImplementation(async scope => measured(normalizeClaudePlan({ fiveHour: 20 }), 'synthetic', scope, Date.now()));
    const h = harness({ registry: createProviderRegistry([{ ...adapterFor('openai-codex'), account: usage.adapter }]) });
    await flush(); h.select(claude.id); await h.controller.pollSelection(); await flush();
    usage.collect.mockImplementation(async scope => ({ state, value: null, source: 'synthetic', scope,
      observedAt: null, fetchedAt: Date.now(), reason: 'Completed auth/usage result' }));
    h.select(codex.id); await h.controller.pollSelection(); await flush();
    expect(h.latest().readings.accounts[0]).toMatchObject({ state, value: null });
    h.select(claude.id); await h.controller.pollSelection(); await flush();
    const delayed = deferred<SessionRecord | null>(); vi.mocked(h.deps.getFocusedSession).mockReturnValueOnce(delayed.promise);
    h.select(codex.id); const returning = h.controller.pollSelection(); await flush();
    expect(h.latest().readings.accounts.every(a => a.value === null)).toBe(true);
    delayed.resolve(codex); await returning; await flush();
  });

  it('invalidates restored usage when a fresh session reveals a changed model or provider', async () => {
    const h = harness(); await flush();
    h.select(claude.id); await h.controller.pollSelection(); await flush();
    h.records.set(codex.id, { ...codex, provider: 'custom', model: 'custom:new' });
    h.select(codex.id); await h.controller.pollSelection(); await flush();
    expect(h.latest().readings.provider.id).toBe('custom');
    expect(h.latest().readings.accounts).toEqual([]);
    expect(rendered(h.latest())).not.toContain('GPT-6.1 Sol');
  });

  it('removes a snapshot when its selected session no longer resolves', async () => {
    const h = harness(); await flush();
    h.select(claude.id); await h.controller.pollSelection(); await flush();
    h.records.delete(codex.id);
    h.select(codex.id); await h.controller.pollSelection(); await flush();
    expect(h.latest().readings.session).toBeNull();
    h.select(claude.id); await h.controller.pollSelection(); await flush();
    const delayed = deferred<SessionRecord | null>(); vi.mocked(h.deps.getFocusedSession).mockReturnValueOnce(delayed.promise);
    h.select(codex.id); const returning = h.controller.pollSelection(); await flush();
    expect(h.latest().readings.session).toBeNull();
    delayed.resolve(null); await returning; await flush();
  });
});

describe('display snapshot lifetime', () => {
  it('bounds the visited-session cache and does not borrow another workspace or stopped controller snapshot', async () => {
    const h = harness(); await flush();
    for (let i = 0; i < SESSION_SNAPSHOT_LIMIT; i++) {
      const session = { id: `future-${i}`, provider: 'custom', model: `custom:model-${i}` };
      h.records.set(session.id, session); h.select(session.id);
      await h.controller.pollSelection(); await flush();
    }
    const pending = deferred<SessionRecord | null>(); vi.mocked(h.deps.getFocusedSession).mockReturnValueOnce(pending.promise);
    h.select(codex.id); const returning = h.controller.pollSelection(); await flush();
    expect(h.latest().cached).not.toBe(true); // oldest entry was evicted
    expect(h.latest().readings.session).toBeNull();
    pending.resolve(codex); await returning; await flush(); h.controller.stop();
    const delayed = deferred<SessionRecord | null>();
    const other = harness({ getFocusedSession: vi.fn(() => delayed.promise) }, '<another-workspace>');
    await flush(); expect(other.latest().readings.session).toBeNull(); expect(other.latest().cached).not.toBe(true);
    delayed.resolve(codex); await flush(); other.controller.stop(); expect(vi.getTimerCount()).toBe(0);
  });
});
