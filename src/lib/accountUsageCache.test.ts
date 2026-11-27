import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountUsageCache } from './accountUsageCache';
import { measured, missing, type AccountUsage, type Reading, type ReadingScope } from './statusModel';
import type { AccountAdapter } from './providerAdapters';

const scope: ReadingScope = { kind: 'account', provider: 'synthetic', workspacePath: '/one',
  accountId: 'account-A', association: 'unbound' };
const sample = (scope: ReadingScope) => measured<AccountUsage>({ buckets: [
  { id: 'weekly', label: 'Weekly only', windows: [{ id: 'any-window', label: 'Returned label',
    durationMinutes: 1234, utilization: { value: 0, unit: 'percent-used' }, resetsAt: null }],
  credits: { unlimited: false, balance: '0' } },
] }, 'synthetic-source', scope, Date.now(), Date.now(), 60000);
const deferred = () => {
  let resolve!: (value: Reading<AccountUsage>) => void;
  return { promise: new Promise<Reading<AccountUsage>>((finish) => { resolve = finish; }),
    resolve: (value: Reading<AccountUsage>) => resolve(value) };
};

function adapter() {
  const collect = vi.fn(async (scope: ReadingScope, _signal: AbortSignal) => sample(scope));
  const adapter: AccountAdapter = { id: 'synthetic', intervalMs: 60000, scope: () => scope, collect };
  return { collect, adapter };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-24T15:00:00Z')); });
afterEach(() => vi.useRealTimers());

describe('scoped account work (synthetic contract cases)', () => {
  it('shares an in-flight request and a young cached result within the same owner epoch', async () => {
    const cache = new AccountUsageCache();
    const { adapter: source, collect } = adapter();
    const pending = deferred();
    collect.mockReturnValueOnce(pending.promise);
    const first = cache.read(source, scope, 'epoch-1');
    const second = cache.read(source, scope, 'epoch-1');
    expect(second).toBe(first);
    await Promise.resolve();
    expect(collect).toHaveBeenCalledTimes(1);
    pending.resolve(sample(scope));
    await first;
    await cache.read(source, scope, 'epoch-1');
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('partitions provider, account, workspace, config source and auth epoch', async () => {
    const cache = new AccountUsageCache();
    const { adapter: source, collect } = adapter();
    await cache.read(source, scope, 'epoch-1');
    for (const other of [
      { ...scope, provider: 'other' }, { ...scope, accountId: 'account-B' },
      { ...scope, workspacePath: '/two' }, { ...scope, configSource: 'other-config' },
    ]) await cache.read(source, other, 'epoch-1');
    await cache.read(source, scope, 'epoch-2');
    expect(collect).toHaveBeenCalledTimes(6);
  });

  it('does not share unknown owners across independent consumer leases', async () => {
    const cache = new AccountUsageCache();
    const { adapter: source, collect } = adapter();
    const unknown = { ...scope, accountId: null };
    await cache.read(source, unknown, 'consumer-one');
    await cache.read(source, unknown, 'consumer-two');
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('partitions session association, scope kind and binding status even in the same auth lease', async () => {
    const cache = new AccountUsageCache();
    const { adapter: source, collect } = adapter();
    for (const scoped of [scope, { ...scope, sessionId: 'one' }, { ...scope, sessionId: 'two' },
      { ...scope, kind: 'workspace' as const }, { ...scope, association: 'verified' as const }]) {
      await cache.read(source, scoped, 'same-lease');
    }
    expect(collect).toHaveBeenCalledTimes(5);
  });

  it.each([{ accountId: 'account-B' }, { sessionId: 'other-session' }, { association: 'verified' as const }])(
    'clears cached values on ownership mismatch instead of retaining them as stale: %j', async (mismatch) => {
      const cache = new AccountUsageCache();
      const { adapter: source, collect } = adapter();
      await cache.read(source, scope, 'epoch-1');
      collect.mockResolvedValueOnce(sample({ ...scope, ...mismatch }));
      expect(await cache.read(source, scope, 'epoch-1', true)).toMatchObject({ state: 'unavailable', value: null,
        reason: 'The reading belongs to a different account scope' });
      collect.mockRejectedValueOnce(new Error('offline'));
      expect((await cache.read(source, scope, 'epoch-1', true)).value).toBeNull();
    });

  it('retains only same-scope successful data on a failed refresh and never converts sign-out to stale', async () => {
    const cache = new AccountUsageCache();
    const { adapter: source, collect } = adapter();
    const first = await cache.read(source, scope, 'epoch-1');
    collect.mockRejectedValueOnce(new Error('offline'));
    const stale = await cache.read(source, scope, 'epoch-1', true);
    expect(stale).toMatchObject({ state: 'stale', value: first.value, observedAt: first.observedAt });
    collect.mockResolvedValueOnce(missing('unauthenticated', 'synthetic', scope, 'Sign in'));
    const signedOut = await cache.read(source, scope, 'epoch-1', true);
    expect(signedOut).toMatchObject({ state: 'unauthenticated', value: null });
  });

  it('rejects mismatched owner responses and keeps unknown credits/units distinct from zero percentages', async () => {
    const cache = new AccountUsageCache();
    const { adapter: source, collect } = adapter();
    collect.mockResolvedValueOnce(sample({ ...scope, accountId: 'account-B' }));
    expect((await cache.read(source, scope, 'epoch-1')).value).toBeNull();
    const result = await cache.read(source, scope, 'epoch-1', true);
    expect(result.value?.buckets[0].credits?.balance).toBe('0');
    expect(result.value?.buckets[0].windows[0].durationMinutes).toBe(1234);
    expect(result.value?.buckets[0].windows[0].utilization).toEqual({ value: 0, unit: 'percent-used' });
    expect(result.value?.resetCredits).toBeUndefined();
  });

  it('invalidates shared owned work without letting its late response repopulate the cache', async () => {
    const cache = new AccountUsageCache();
    const { adapter: source, collect } = adapter();
    const pending = deferred();
    collect.mockReturnValueOnce(pending.promise);
    const first = cache.read(source, scope, 'epoch-1');
    await Promise.resolve();
    cache.clear('synthetic');
    expect(collect.mock.calls[0][1].aborted).toBe(true);
    const second = await cache.read(source, scope, 'epoch-1');
    pending.resolve(sample(scope));
    expect((await first).value).toBeNull();
    expect((await cache.read(source, scope, 'epoch-1')).value).toEqual(second.value);
    expect(collect).toHaveBeenCalledTimes(2);
  });
});
