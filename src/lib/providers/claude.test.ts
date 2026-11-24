import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanResult } from '../planUsage';
import type { ReadingScope } from '../statusModel';

const mocks = vi.hoisted(() => ({ plan: vi.fn(), host: vi.fn(), login: vi.fn(), on: vi.fn(), invalidate: vi.fn() }));
vi.mock('../ipc', () => ({ getUsage: mocks.host, invokeQuiet: mocks.login, on: mocks.on }));
vi.mock('../planUsage', () => ({ fetchPlanUsageResult: mocks.plan, invalidatePlanUsage: mocks.invalidate }));
const scope: ReadingScope = { kind: 'account', provider: 'claude-code', workspacePath: '/workspace',
  accountId: null, configSource: 'host-claude-config', association: 'unbound' };
const read = async () => (await import('./claude')).claudeAccountAdapter.collect(scope, new AbortController().signal);

beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); mocks.host.mockResolvedValue(null); });

describe('Claude account adapter failure semantics', () => {
  it('prefers the direct source, carries the unbound scope, and does not query the host fallback', async () => {
    mocks.plan.mockResolvedValue({ usage: { timestamp: new Date().toISOString(), fiveHour: 0 }, failure: null } satisfies PlanResult);
    const result = await read();
    expect(result).toMatchObject({ state: 'available', scope, source: 'claude-direct' });
    expect(result.value?.buckets[0].windows[0].utilization.value).toBe(0);
    expect(mocks.host).not.toHaveBeenCalled();
  });

  it.each(['rate-limited', 'unavailable', 'credentials-unavailable'] as const)(
    'marks a retained direct reading stale immediately after %s', async (failure) => {
      const timestamp = new Date().toISOString();
      mocks.plan.mockResolvedValue({ usage: { timestamp, sevenDay: 83 }, failure } satisfies PlanResult);
      const result = await read();
      expect(result).toMatchObject({ state: 'stale', observedAt: Date.parse(timestamp) });
      expect(result.value?.buckets[0].windows[0].utilization.value).toBe(83);
    });

  it('uses newer host scoped windows on missing file credentials without claiming signed-out state', async () => {
    mocks.plan.mockResolvedValue({ usage: null, failure: 'credentials-unavailable' } satisfies PlanResult);
    mocks.host.mockResolvedValue({ lastUpdated: Date.now(), weeklyModelLimits: [{ model: 'Fable', utilization: 42, resetsAt: null }] });
    expect((await read()).value?.buckets[1].windows[0].label).toBe('7d Fable');
  });

  it('treats a 401 as unauthenticated and does not revive a host singleton under that login', async () => {
    mocks.plan.mockResolvedValue({ usage: { fiveHour: 50 }, failure: 'unauthenticated' } satisfies PlanResult);
    expect(await read()).toMatchObject({ state: 'unauthenticated', value: null });
    expect(mocks.host).not.toHaveBeenCalled();
  });

  it('does not interpret a host error with fresh zero windows as successful or unauthenticated', async () => {
    mocks.plan.mockResolvedValue({ usage: null, failure: 'unavailable' } satisfies PlanResult);
    mocks.host.mockResolvedValue({ error: 'private raw failure', lastUpdated: Date.now(), fiveHour: { utilization: 0 } });
    const result = await read();
    expect(result).toMatchObject({ state: 'unavailable', value: null });
    expect(JSON.stringify(result)).not.toContain('private raw failure');
  });

  it('keeps host data with missing observation time muted instead of inventing freshness', async () => {
    mocks.plan.mockResolvedValue({ usage: null, failure: 'credentials-unavailable' } satisfies PlanResult);
    mocks.host.mockResolvedValue({ fiveHour: { utilization: 91, resetsAt: null } });
    expect(await read()).toMatchObject({ state: 'stale', observedAt: null, source: 'claude-host' });
  });

  it('uses private login fields only as a change detector, never as an account/session binding', async () => {
    mocks.login.mockResolvedValue({ isLoggedIn: true, email: 'private@example.test', organization: 'private-org',
      subscriptionType: 'Pro', token: 'must-not-be-retained' });
    const { claudeAccountAdapter } = await import('./claude');
    const identity = await claudeAccountAdapter.identity!();
    expect(identity).toMatchObject({ authenticated: true, accountId: null });
    expect(identity.revision).toContain('private@example.test');
    expect(identity.revision).not.toContain('must-not-be-retained');
    expect(claudeAccountAdapter.scope('/workspace')).toMatchObject({ accountId: null, association: 'unbound' });
    mocks.login.mockResolvedValue({ isLoggedIn: true, isExpired: true });
    expect((await claudeAccountAdapter.identity!()).authenticated).toBe(false);
  });

  it('suppresses a pre-auth-change host cache and delegates shared-client invalidation', async () => {
    mocks.plan.mockResolvedValue({ usage: null, failure: 'credentials-unavailable' } satisfies PlanResult);
    const { claudeAccountAdapter } = await import('./claude');
    claudeAccountAdapter.invalidate!();
    mocks.host.mockResolvedValue({ lastUpdated: Date.now() - 1000, fiveHour: { utilization: 70 } });
    expect((await read()).value).toBeNull();
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
});
