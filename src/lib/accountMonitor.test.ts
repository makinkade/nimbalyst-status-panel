import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountMonitor } from './accountMonitor';
import { AccountUsageCache } from './accountUsageCache';
import type { AccountAdapter } from './providerAdapters';
import { measured, type AccountUsage, type Reading, type ReadingScope } from './statusModel';

afterEach(() => vi.useRealTimers());

describe('shared account consumer cancellation', () => {
  it('detaches a stopped consumer without aborting another consumer sharing the same request', async () => {
    vi.useFakeTimers();
    const scope: ReadingScope = { kind: 'account', provider: 'synthetic', workspacePath: '/one',
      accountId: null, association: 'unbound' };
    let finish!: (value: Reading<AccountUsage>) => void;
    const pending = new Promise<Reading<AccountUsage>>((resolve) => { finish = resolve; });
    const collect = vi.fn((_scope: ReadingScope, _signal: AbortSignal) => pending);
    const adapter: AccountAdapter = { id: 'synthetic', scope: () => scope, collect, intervalMs: 60000 };
    const cache = new AccountUsageCache();
    const first = new AccountMonitor(adapter, cache);
    const second = new AccountMonitor(adapter, cache);
    const publishFirst = vi.fn();
    const publishSecond = vi.fn();
    first.start('/one', 'shared-epoch', publishFirst);
    second.start('/one', 'shared-epoch', publishSecond);
    await vi.advanceTimersByTimeAsync(0);
    expect(collect).toHaveBeenCalledTimes(1);
    first.stop();
    expect(collect.mock.calls[0][1].aborted).toBe(false);
    finish(measured({ buckets: [] }, 'synthetic', scope, Date.now()));
    await vi.advanceTimersByTimeAsync(0);
    expect(publishFirst).not.toHaveBeenCalled();
    expect(publishSecond).toHaveBeenCalledTimes(1);
    second.stop();
    cache.clear();
    expect(vi.getTimerCount()).toBe(0);
  });
});
