import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountMonitor } from '../accountMonitor';
import { AccountUsageCache } from '../accountUsageCache';
import { normalizeSessionStatus } from '../providerAdapters';
import type { AccountUsage, Reading } from '../statusModel';
import { usagePresentation } from '../usagePresentation';
import { CODEX_READ_INTERVAL_MS, createCodexAccountAdapter, newCodexReadBudget } from './codex';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/status-host-0.83.0.json', import.meta.url), 'utf8')) as {
  observations: Array<{ channel: string; payload: unknown }>;
};
const payload = (channel: string) => fixture.observations.find((row) => row.channel === channel)!.payload;
const login = payload('openai-codex:check-login');
const quota = payload('codex-usage:refresh');
const flush = () => vi.advanceTimersByTimeAsync(0);
const monitors: AccountMonitor[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function source() {
  const events = new Map<string, (...args: unknown[]) => void>();
  const disposed: string[] = [];
  const invoke = vi.fn(async (channel: string): Promise<unknown> => channel === 'openai-codex:check-login' ? login : quota);
  const on = vi.fn((channel: string, callback: (...args: unknown[]) => void) => {
    events.set(channel, callback);
    return () => { events.delete(channel); disposed.push(channel); };
  });
  const budget = newCodexReadBudget();
  const adapter = createCodexAccountAdapter({ invoke, on, budget });
  return { invoke, on, budget, adapter, events, disposed,
    emit: (channel: string, value: unknown = null) => events.get(channel)?.(value) };
}

function mount(s = source(), workspace = '/one') {
  const updates: Reading<AccountUsage>[] = [];
  const monitor = new AccountMonitor(s.adapter, new AccountUsageCache());
  monitors.push(monitor);
  monitor.start(workspace, 'local-generation', (reading) => updates.push(reading));
  return { ...s, monitor, updates, latest: () => updates[updates.length - 1]! };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-27T17:00:00Z')); });
afterEach(() => { for (const monitor of monitors.splice(0)) monitor.stop(); vi.useRealTimers(); });

describe('live Codex bridge using audited success shapes', () => {
  it('checks auth and explicitly refreshes once, preserves unknown source age, and renders muted unbound values', async () => {
    const h = mount();
    await flush();
    expect(h.invoke.mock.calls).toEqual([['openai-codex:check-login'], ['codex-usage:refresh']]);
    expect(h.latest()).toMatchObject({ state: 'stale', observedAt: null, fetchedAt: Date.now(),
      lastSuccessfulFetchAt: Date.now(), lastAttemptAt: Date.now(),
      scope: { accountId: null, association: 'unbound', workspacePath: '/one' } });
    const model = normalizeSessionStatus({ workspacePath: '/one', session: { id: 'selected', provider: 'openai-codex' },
      models: [], permissionMode: null, defaultEffort: null, accounts: [h.latest()] });
    const card = usagePresentation(model).usagePrimary.cards[0];
    expect(card).toMatchObject({ value: '20% used', muted: true, stale: true });
    expect(card.label).toContain('Host-reported Codex');
    expect(card.title).toContain('account/session association and source observation time are unverified');
    expect(card.title).toContain('Last successful fetch');
    expect(card.title).toContain('Local workspace');
    expect(JSON.stringify(h.latest())).not.toContain('<account-email>');
  });

  it('consumes the real update directly, ignores self-broadcasts and does not create a refresh loop', async () => {
    const s = source();
    s.invoke.mockImplementation(async (channel) => {
      if (channel === 'openai-codex:check-login') return login;
      s.emit('codex-usage:update', quota);
      return quota;
    });
    const h = mount(s);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    const update = (payload('codex-usage:update') as unknown[])[0];
    h.emit('codex-usage:update', update);
    await flush();
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(h.latest().lastSuccessfulFetchAt).toBe(Date.now());
    expect(h.latest().observedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(CODEX_READ_INTERVAL_MS - 1000);
    expect(h.invoke).toHaveBeenCalledTimes(2); // The update refreshed the local cache.
    await vi.advanceTimersByTimeAsync(CODEX_READ_INTERVAL_MS);
    expect(h.invoke).toHaveBeenCalledTimes(4);
  });

  it('coalesces overlapping work, throttles failure/retry and ignores updates until this epoch has a direct read', async () => {
    const s = source();
    const pending = deferred<unknown>();
    s.invoke.mockReturnValueOnce(pending.promise);
    const h = mount(s);
    await flush();
    h.emit('codex-usage:update', quota);
    const a = h.monitor.refresh(true);
    const b = h.monitor.refresh(true);
    expect(a).toBe(b);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    pending.resolve(login);
    await a;
    await h.monitor.refresh(true);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(h.latest().value).not.toBeNull();
  });
});

describe('synthetic auth/failure variants of the audited bridge', () => {
  it.each([
    [{ installed: true, isLoggedIn: true, authMode: 'apikey' }, 'unsupported'],
    [{ installed: true, isLoggedIn: false, authMode: null }, 'unauthenticated'],
    [{ installed: false, isLoggedIn: false, error: 'private failure' }, 'unavailable'],
    [{ installed: true, isLoggedIn: false, error: 'expired auth' }, 'unavailable'],
    [{ installed: true, isLoggedIn: true, authMode: 'future' }, 'unavailable'],
    [null, 'unavailable'],
  ] as const)('does not read subscription quota for unusable/API-key auth %j', async (auth, state) => {
    const s = source(); s.invoke.mockResolvedValue(auth);
    const h = mount(s); await flush();
    expect(h.latest()).toMatchObject({ state, value: null, lastSuccessfulFetchAt: null });
    expect(h.invoke.mock.calls).toEqual([['openai-codex:check-login']]);
    expect(JSON.stringify(h.latest())).not.toContain('private failure');
  });

  it.each(['401', '429', 'offline', 'denied', 'malformed', 'session-file'])(
    'fails quietly for %s and retains only this local generation with separate attempt/success times', async (failure) => {
      const s = source(); const h = mount(s); await flush();
      const successfulAt = h.latest().lastSuccessfulFetchAt;
      s.invoke.mockImplementation(async (channel) => {
        if (channel === 'openai-codex:check-login') return login;
        if (failure === 'malformed') return { source: 'account', limits: {} };
        if (failure === 'session-file') return { source: 'session', limits: [], tokenUsage: { totalTokens: 100 } };
        throw new Error(failure);
      });
      await vi.advanceTimersByTimeAsync(CODEX_READ_INTERVAL_MS);
      expect(h.latest()).toMatchObject({ state: 'stale', fetchedAt: successfulAt, lastSuccessfulFetchAt: successfulAt,
        lastAttemptAt: Date.now(), observedAt: null });
      expect(h.latest().value?.buckets[0].windows[0].utilization.value).toBe(20);
      h.emit('openai-codex:auth-updated', { authMode: null });
      expect(h.latest().value).toBeNull();
      await flush();
      expect(h.latest().value).toBeNull();
    });

  it('does not revive cached quantities on failed/unknown auth', async () => {
    const s = source(); const h = mount(s); await flush();
    s.invoke.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(CODEX_READ_INTERVAL_MS);
    expect(h.latest()).toMatchObject({ state: 'unavailable', value: null, lastSuccessfulFetchAt: null });
    expect(h.invoke).toHaveBeenCalledTimes(3);
  });

  it('rejects a global file fallback on the first read rather than displaying its tokens or quota', async () => {
    const s = source();
    s.invoke.mockImplementation(async (channel) => channel === 'openai-codex:check-login' ? login
      : { source: 'session', limits: (quota as { limits: unknown[] }).limits, limitsAvailable: true });
    const h = mount(s); await flush();
    expect(h.latest()).toMatchObject({ state: 'unavailable', value: null, lastSuccessfulFetchAt: null });
  });
});

describe('detected auth boundaries, cancellation and cleanup', () => {
  it.each(['openai-codex:auth-updated', 'openai-codex:auth-login-completed'])(
    'clears values immediately on %s and rejects late results', async (event) => {
      const s = source(); const h = mount(s); await flush();
      const pending = deferred<unknown>();
      s.invoke.mockImplementation(async (channel) => channel === 'openai-codex:check-login' ? login : pending.promise);
      await vi.advanceTimersByTimeAsync(CODEX_READ_INTERVAL_MS);
      h.emit(event, { authMode: 'chatgpt' });
      expect(h.latest().value).toBeNull();
      pending.resolve(quota);
      await flush();
      expect(h.latest().value).toBeNull();
      expect(h.invoke).toHaveBeenCalledTimes(4);
    });

  it('invalidates silently changed email/plan detectors before waiting on another quota response', async () => {
    const s = source(); const h = mount(s); await flush();
    const pending = deferred<unknown>();
    s.invoke.mockImplementation(async (channel) => channel === 'openai-codex:check-login'
      ? { ...(login as object), email: 'different-private-email', planType: 'other' } : pending.promise);
    await vi.advanceTimersByTimeAsync(CODEX_READ_INTERVAL_MS);
    expect(h.latest().value).toBeNull();
    pending.resolve(quota); await flush();
    expect(JSON.stringify(h.updates)).not.toContain('different-private-email');
  });

  it('does not share unbound values across workspaces and enforces the request floor across new collectors', async () => {
    const s = source(); const h = mount(s); await flush();
    h.monitor.stop();
    const other = createCodexAccountAdapter({ invoke: s.invoke, on: s.on, budget: s.budget });
    const result = await other.collect(other.scope('/two'), new AbortController().signal);
    expect(result).toMatchObject({ value: null, state: 'unavailable', scope: { workspacePath: '/two' } });
    expect(s.invoke).toHaveBeenCalledTimes(2);
    expect(s.disposed).toHaveLength(3);
  });

  it('guards callbacks after cleanup, including pending auth and quota work', async () => {
    const s = source(); const pending = deferred<unknown>(); s.invoke.mockReturnValueOnce(pending.promise);
    const h = mount(s); await flush();
    const old = [...s.events.values()]; const count = h.updates.length;
    h.monitor.stop();
    pending.resolve(login); for (const callback of old) callback(quota);
    await flush();
    expect(h.updates).toHaveLength(count);
    expect(s.disposed).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });
});
