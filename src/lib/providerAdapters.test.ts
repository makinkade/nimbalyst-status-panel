import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeModels, type SessionRecord } from './ipc';
import { providerIdentity } from './provider';
import { adapterFor, createProviderRegistry, genericAdapter, normalizeSessionStatus, selectedAccountUsage } from './providerAdapters';
import { ageReading, measured, type AccountUsage, type ReadingScope } from './statusModel';
import { claudeReading, normalizeClaudePlan } from './providers/claude';
import { usagePresentation } from './usagePresentation';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/status-host-0.83.0.json', import.meta.url), 'utf8'));
const payload = (channel: string, index = 0) => fixture.observations.filter((row: { channel: string }) => row.channel === channel)[index].payload;
const codex: SessionRecord = payload('sessions:get').session;
const claude: SessionRecord = payload('sessions:get', 1).session;
const catalog = normalizeModels(payload('ai:getModels'));
const scope: ReadingScope = { kind: 'account', provider: 'claude-code', workspacePath: '<workspace>',
  accountId: null, association: 'unbound', configSource: 'host-claude-config' };
const now = Date.parse(fixture.provenance.capturedAt);

function status(session: SessionRecord | null) {
  return normalizeSessionStatus({ workspacePath: '<workspace>', session, models: catalog,
    permissionMode: 'auto', defaultEffort: 'high', now });
}

describe('GET-222 host payload normalization', () => {
  it('uses display names and grouped capacity, never flat maxTokens', () => {
    expect(catalog.find((model) => model.id === codex.model)).toMatchObject({
      name: 'GPT-6.1 Sol', contextWindow: 272000, provider: 'openai-codex',
    });
    expect(status(codex).context.value).toEqual({ tokens: 124715, window: 475000,
      percent: 124715 / 475000 * 100 });
    const flatOnly = normalizeModels({ success: true, models: payload('ai:getModels').models });
    expect(flatOnly.every((model) => model.contextWindow === undefined)).toBe(true);
  });

  it('retains the older array/keyed catalog shapes without unwrapping invoke', () => {
    const model = { id: 'custom:new', name: 'New', provider: 'custom', contextWindow: 1000 };
    expect(normalizeModels([model])).toEqual([model]);
    expect(normalizeModels({ custom: [model] })).toEqual([model]);
    expect(normalizeModels({ success: false, models: [model] })).toEqual([]);
  });

  it('separates current context, cumulative/cache counters, configured effort and policy', () => {
    const data = status(codex);
    expect(data.tokens.value).toMatchObject({ totalTokens: 8946657, cacheReadInputTokens: 8803200,
      providerCumulativeInputTokens: 8936042 });
    expect(data.effort.value).toEqual({ level: 'high', source: 'session' });
    expect(data.workspacePolicy).toMatchObject({ value: { mode: 'auto' }, scope: { kind: 'workspace' } });
    expect(data.execution).toMatchObject({ state: 'unavailable', value: null });
    expect(data.servedModel).toMatchObject({ state: 'unsupported', value: null });
    expect(data.model.value?.requestedId).toBe(codex.model);
  });

  it('leaves the real old Claude host reading stale, with its original scope and timestamp', () => {
    const host = payload('claude-usage:get');
    const reading = claudeReading(host, scope, 'claude-host', now);
    expect(reading).toMatchObject({ state: 'stale', source: 'claude-host', observedAt: host.lastUpdated,
      fetchedAt: now, scope: { accountId: null, association: 'unbound' } });
    expect(reading.value?.buckets[0].windows[0].utilization).toEqual({ value: 17, unit: 'percent-used' });
    expect(status(claude).context.value?.window).toBe(1000000);
  });
});

describe('adapter identity and generic capabilities (synthetic edge cases)', () => {
  it('prefers explicit metadata, then a unique catalog match, then a prefix', () => {
    expect(providerIdentity({ ...codex, provider: 'future-vendor' }, catalog)).toEqual({ id: 'future-vendor', source: 'session' });
    expect(providerIdentity({ id: 'x', model: codex.model }, catalog)).toEqual({ id: 'openai-codex', source: 'catalog' });
    expect(providerIdentity({ id: 'x', model: 'new:future-model' }, catalog)).toEqual({ id: 'new', source: 'prefix' });
    expect(providerIdentity({ id: 'x', model: 'gpt-future' }, catalog)).toEqual({ id: null, source: 'unknown' });
    expect(adapterFor('new')).toBe(genericAdapter);
    expect(adapterFor('openai')).toBe(genericAdapter);
  });

  it('does not infer ChatGPT ownership from an OpenAI model or an unknown provider', () => {
    const data = status({ id: 'x', provider: 'openai', model: 'gpt-future' });
    expect(selectedAccountUsage(data).state).toBe('unsupported');
    expect(data.provider.id).toBe('openai');
    expect(status({ id: 'x', model: 'gpt-future' }).provider.id).toBeNull();
    expect(status({ id: 'x', model: 'gpt-future' }).effort.value).toBeNull();
  });

  it('preserves ambiguity when two catalog providers advertise the same bare ID', () => {
    const models = normalizeModels([{ id: 'shared', provider: 'one', name: 'One' },
      { id: 'shared', provider: 'two', name: 'Two' }]);
    expect(models).toHaveLength(2);
    expect(providerIdentity({ id: 'x', model: 'shared' }, models).id).toBeNull();
    const data = normalizeSessionStatus({ workspacePath: '/one', session: { id: 'x', model: 'shared' },
      models, defaultEffort: 'high', permissionMode: null });
    expect(data.model.value).toEqual({ requestedId: 'shared', displayName: null });
  });

  it('keeps common data and zero measurements without a quota adapter', () => {
    const data = status({ id: 'x', provider: 'custom', model: 'custom:future', metadata: {
      tokenUsage: { totalTokens: 999999, currentContext: { tokens: 0, contextWindow: 2000 } },
    } });
    expect(data.context.value).toEqual({ tokens: 0, window: 2000, percent: 0 });
    expect(data.tokens.value?.totalTokens).toBe(999999);
    expect(data.workspacePolicy.value?.mode).toBe('auto');
    expect(selectedAccountUsage(data).state).toBe('unsupported');
    expect(status(null).model.value).toBeNull();
  });

  it('does not turn a token-only total or a known zero fallback into context', () => {
    const session = { id: 'x', provider: 'cursor-agent', metadata: { tokenUsage: { totalTokens: 1000 } } };
    expect(status(session).context.state).toBe('unsupported');
    expect(status(session).tokens.value?.totalTokens).toBe(1000);
    expect(status({ ...session, provider: 'copilot-cli', metadata: { tokenUsage: { totalTokens: 0 } } }).tokens.state).toBe('unsupported');
    expect(status({ ...session, provider: 'custom' }).context.value).toBeNull();
    expect(status({ ...session, provider: 'cursor-agent' }).effort.state).toBe('unsupported');
  });

  it('can register another adapter without changing common collection or rendering', () => {
    const registry = createProviderRegistry([{ ...genericAdapter, id: 'new', capabilities: {
      ...genericAdapter.capabilities, effort: 'supported',
    } }]);
    const data = normalizeSessionStatus({ workspacePath: '<workspace>', session: { id: 'x', provider: 'new' },
      models: [], permissionMode: null, defaultEffort: 'low' }, registry);
    expect(data.effort.value).toEqual({ level: 'low', source: 'app-default' });
    expect(adapterFor('not-registered', registry)).toBe(genericAdapter);
  });
});

describe('Claude normalized allowance collection', () => {
  it('has stable semantic IDs across order, percent and reset changes and accepts arbitrary windows', () => {
    const limits = [{ group: 'monthly', model: 'Future', percent: 0, resets: null },
      { group: 'weekly', model: 'Fable', percent: 95, resets: 'old' }];
    const first = normalizeClaudePlan({ allLimits: limits });
    const second = normalizeClaudePlan({ allLimits: [...limits].reverse().map((limit) => ({ ...limit, percent: 80, resets: 'new' })) });
    const ids = (usage: AccountUsage) => usage.buckets.flatMap((bucket) => bucket.windows.map((w) => `${bucket.id}/${w.id}`)).sort();
    expect(ids(first)).toEqual(ids(second));
    expect(first.buckets[1].windows[0]).toMatchObject({ label: 'monthly Future', utilization: { value: 0, unit: 'percent-used' } });
    expect(first.buckets[0].windows).toEqual([]);
  });

  it('includes newer host scoped limits, skips missing utilization, and rejects error zeros', () => {
    const reading = claudeReading({ lastUpdated: now, weeklyModelLimits: [
      { model: 'Fable', utilization: 73, resetsAt: null },
    ] }, scope, 'claude-host', now);
    expect(reading.value?.buckets[1].windows[0].label).toBe('7d Fable');
    expect(normalizeClaudePlan({ allLimits: [{ group: 'weekly', model: 'X', percent: null, resets: null }] })
      .buckets.every((bucket) => !bucket.windows.length)).toBe(true);
    expect(claudeReading({ error: 'offline', lastUpdated: now, fiveHour: { utilization: 0, resetsAt: null } },
      scope, 'claude-host', now).value).toBeNull();
  });

  it('accepts Claude limits-array-only readings and keeps legacy scoped IDs consistent', () => {
    const direct = normalizeClaudePlan({ allLimits: [
      { group: 'session', model: null, percent: 20, resets: null },
      { group: 'weekly', model: 'Fable', percent: 80, resets: null },
    ] });
    expect(direct.buckets[0].windows[0]).toMatchObject({ id: 'five-hour', durationMinutes: 300 });
    const legacy = normalizeClaudePlan({ scoped: [{ label: '7d Fable', pct: 80, reset: null }] });
    expect(legacy.buckets[1]).toEqual(direct.buckets[1]);
  });

  it('ages cached data without moving observation/fetch times and mutes unknown observation time', () => {
    const reading = measured({ buckets: [] }, 'source', scope, now, now, 60000);
    const aged = ageReading(reading, now + 60001);
    expect(aged).toMatchObject({ state: 'stale', observedAt: now, fetchedAt: now });
    expect(claudeReading({ fiveHour: { utilization: 100, resetsAt: null } }, scope, 'claude-host', now).state).toBe('stale');
    expect(measured({ buckets: [] }, 'source', scope, Number.NaN, now, 60000)).toMatchObject({ state: 'stale', observedAt: null });
  });

  it('does not substitute Claude usage for an unknown provider and keeps the owner unbound', () => {
    const data = status({ id: 'x', model: 'unfamiliar' });
    data.accounts = [claudeReading({ timestamp: new Date().toISOString(), fiveHour: 91 }, scope, 'claude-direct')];
    expect(usagePresentation(data).usagePrimary.cards[0]).toMatchObject({ percent: null, muted: true });
    expect(usagePresentation(data, data.accounts[0]).usagePrimary.cards[0]).toMatchObject({ percent: 91, muted: true });
    expect(data.accounts[0].scope.accountId).toBeNull();
    expect(data.accounts[0].scope.association).toBe('unbound');
  });
});
