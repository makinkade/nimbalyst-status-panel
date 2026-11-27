import { readFileSync } from 'node:fs';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusController, type Status, type StatusDependencies } from './statusController';
import { latestServedModel, normalizeModels, selectedSessionId, type SessionRecord, type WorkspaceState } from './lib/ipc';
import { adapterFor, createProviderRegistry, type AccountAdapter, type AccountIdentity } from './lib/providerAdapters';
import { measured, type AccountUsage, type Reading, type ReadingScope } from './lib/statusModel';
import { normalizeClaudePlan } from './lib/providers/claude';
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
    getGitInfo: vi.fn(async () => ({ repoPath: workspacePath, branch: 'master', dirtyCount: 1 })),
    on: subscribe, onWindowEvent: subscribe,
    registry: createProviderRegistry([{ ...adapterFor('claude-code'), readServedModel: served, account: undefined }]),
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
