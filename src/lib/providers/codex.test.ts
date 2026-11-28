import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterFor } from '../providerAdapters';
import { codexAccountAdapter, codexRejectionReason, createCodexAccountAdapter, newCodexReadBudget, normalizeCodexHost } from './codex';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/status-host-0.83.0.json', import.meta.url), 'utf8')) as {
  observations: Array<{ channel: string; payload: unknown }>;
};
const payloads = (channel: string) => fixture.observations.filter((row) => row.channel === channel).map((row) => row.payload);
const snapshot = (limits: unknown[] = [], extra: Record<string, unknown> = {}) => ({ source: 'account', limits, ...extra });
const limit = (extra: Record<string, unknown> = {}) => ({ id: 'codex', name: null, windows: [
  { slot: 'primary', usedPercent: 0, windowDurationMins: 95, resetsAt: null },
], ...extra });

afterEach(() => vi.unstubAllGlobals());

describe('Codex normalization from audited Nimbalyst 0.83.0 payloads', () => {
  it('normalizes real getters and refresh/update snapshots without granting ownership or freshness', () => {
    const values = [...payloads('codex-usage:get'), ...payloads('codex-usage:refresh'),
      ...(payloads('codex-usage:update')[0] as unknown[])];
    expect(values.length).toBeGreaterThan(2);
    for (const value of values) {
      const normalized = normalizeCodexHost(value)!;
      expect(normalized.buckets[0]).toMatchObject({ id: 'codex', label: 'codex', plan: 'plus',
        credits: { hasCredits: false, unlimited: false, balance: '0' } });
      expect(normalized.buckets[0].windows).toMatchObject([
        { id: 'window:primary', role: 'primary', label: 'codex 5h', durationMinutes: 300,
          utilization: { unit: 'percent-used' }, resetsAt: expect.any(String) },
        { id: 'window:secondary', role: 'secondary', label: 'codex 7d', durationMinutes: 10080 },
      ]);
      expect(normalized.resetCredits).toEqual({ availableCount: 0, credits: [] });
      expect(normalized).not.toHaveProperty('scope');
      expect(normalized).not.toHaveProperty('observedAt');
      expect(normalized).not.toHaveProperty('lastUpdated');
    }
  });
});

describe('Codex normalization (synthetic variations of the audited contract)', () => {
  it.each([0, 100, 120])('keeps %s percent used and actual duration without assuming a secondary window', (percent) => {
    const result = normalizeCodexHost(snapshot([limit({ name: 'Returned name', windows: [
      { slot: 'primary', usedPercent: percent, windowDurationMins: 95, resetsAt: null },
    ] })]))!;
    expect(result.buckets[0].windows).toEqual([{ id: 'window:primary', label: 'Returned name 95m',
      role: 'primary', durationMinutes: 95, utilization: { value: percent, unit: 'percent-used' }, resetsAt: null }]);
    expect(result.buckets[0].modelScope).toBeUndefined();
  });

  it('keeps weekly-only, extra buckets and unfamiliar window slots with stable IDs', () => {
    const result = normalizeCodexHost(snapshot([
      limit({ id: 'weekly', windows: [{ slot: 'secondary', usedPercent: 9, windowDurationMins: 10080 }] }),
      limit({ id: 'other', name: 'Other allowance', windows: [{ slot: 'burst', usedPercent: 42, windowDurationMins: 15 }] }),
    ]))!;
    expect(result.buckets.map((bucket) => bucket.id)).toEqual(['weekly', 'other']);
    expect(result.buckets[0].windows[0]).toMatchObject({ role: 'secondary', label: 'weekly 7d' });
    expect(result.buckets[1].windows[0]).toMatchObject({ id: 'window:burst', role: 'additional', label: 'Other allowance 15m' });
  });

  it('deduplicates IDs without using changing utilization or reset times as identity', () => {
    const first = limit();
    const result = normalizeCodexHost(snapshot([first, limit({ name: 'Duplicate' }),
      limit({ id: 'other', windows: [first.windows[0], { ...first.windows[0], usedPercent: 99 }] }),
    ]))!;
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[1].windows).toHaveLength(1);
    expect(result.buckets[1].windows[0].utilization.value).toBe(0);
  });

  it.each([undefined, null, -1, NaN, Infinity, '12', true])('never converts invalid utilization %s to zero', (usedPercent) => {
    const result = normalizeCodexHost(snapshot([limit({ windows: [{ slot: 'primary', usedPercent }] })]))!;
    expect(result.buckets[0].windows).toEqual([]);
  });

  it('tolerates invalid duration/reset fields and ignores upstream numeric reset timestamps', () => {
    const result = normalizeCodexHost(snapshot([limit({ windows: [
      { slot: 'primary', usedPercent: 0, windowDurationMins: -1, resetsAt: 1730947200 },
      { slot: 'secondary', usedPercent: 100, windowDurationMins: '300', resetsAt: 'not a date' },
    ] })]))!;
    for (const window of result.buckets[0].windows) {
      expect(window.durationMinutes).toBeUndefined();
      expect(window.resetsAt).toBeNull();
    }
    expect(result.buckets[0].windows[0].label).toBe('codex primary');
  });

  it('preserves valid host ISO resets and keeps a missing reset absent', () => {
    const iso = '2026-11-30T19:49:53.000Z';
    const result = normalizeCodexHost(snapshot([limit({ windows: [
      { slot: 'primary', usedPercent: 0, resetsAt: iso }, { slot: 'secondary', usedPercent: 0 },
    ] })]))!;
    expect(result.buckets[0].windows.map((window) => window.resetsAt)).toEqual([iso, null]);
  });

  it('keeps credit-only responses when limitsAvailable is false, without inventing a percentage or currency', () => {
    const result = normalizeCodexHost(snapshot([limit({ windows: [], credits: { balance: '12.50', unlimited: false } })],
      { limitsAvailable: false }))!;
    expect(result.buckets[0].credits).toEqual({ balance: '12.50', unlimited: false });
    expect(result.buckets[0].windows).toEqual([]);
    expect(result.buckets[0].credits?.hasCredits).toBeUndefined();
  });

  it('uses only explicit boolean credit flags and valid reported balances', () => {
    const result = normalizeCodexHost(snapshot([
      limit({ id: 'unlimited', windows: [], credits: { unlimited: true } }),
      limit({ id: 'invalid', windows: [], credits: { unlimited: 'true', hasCredits: 1, balance: 'NaN' } }),
      limit({ id: 'zero', windows: [], credits: { balance: 0, hasCredits: false } }),
    ]))!;
    expect(result.buckets.map((bucket) => bucket.credits)).toEqual([
      { unlimited: true }, undefined, { balance: 0, hasCredits: false },
    ]);
  });

  it.each([null, []])('preserves reset-credit detail state %s and allowlists real host detail fields', (details) => {
    expect(normalizeCodexHost(snapshot([], { rateLimitResetCredits: { availableCount: 2, credits: details } }))?.resetCredits)
      .toEqual({ availableCount: 2, credits: details });
    const result = normalizeCodexHost(snapshot([], { rateLimitResetCredits: { availableCount: 2, credits: [
      { id: 'reset-1', title: 'Returned title', expiresAt: null, arbitrary: 'private' },
    ] } }))!;
    expect(result.resetCredits).toEqual({ availableCount: 2, credits: [
      { id: 'reset-1', title: 'Returned title', description: null, expiresAt: null },
    ] });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('keeps reported individual percentages separate from unverified quantities', () => {
    const result = normalizeCodexHost(snapshot([limit({ windows: [], individualLimit: {
      remainingPercent: 25, limit: 1000, used: 750, resetsAt: '2026-11-30T19:49:53.000Z',
    } })]))!;
    expect(result.buckets[0].windows).toEqual([{ id: 'individual', label: 'codex individual limit',
      role: 'additional', utilization: { value: 25, unit: 'percent-remaining' }, resetsAt: '2026-11-30T19:49:53.000Z' }]);
    expect(JSON.stringify(result)).not.toContain('750');
    expect(normalizeCodexHost(snapshot([limit({ windows: [], individualLimit: { remainingPercent: 101 } })]))?.buckets[0].windows).toEqual([]);
  });

  it.each([null, [], {}, { source: 'account' }, snapshot([null, { windows: [] }]),
    { source: 'account', limits: {} }, { source: 'session', limits: [limit()] },
    { source: 'session', limitsAvailable: false, tokenUsage: { totalTokens: 100 } },
    ...['401', '429', 'offline', 'access denied'].map((error) => snapshot([], { error, lastUpdated: Date.now() })),
  ])('rejects errors, missing shapes and unbound session fallbacks: %j', (value) => {
    expect(normalizeCodexHost(value)).toBeNull();
  });

  it.each([
    [null, 'could not refresh Codex usage'],
    [{ limits: [], error: 'No Codex usage data found. Use Codex CLI with a ChatGPT subscription to see usage.' },
      'no Codex account limits and no recent Codex session data'],
    [{ limits: [], error: 'EACCES: C:\\Users\\private\\.codex\\sessions' }, 'details are in Nimbalyst’s log'],
    [{ source: 'session', limits: [limit()] }, 'fell back to recent Codex session files'],
    [{ source: 'account', limits: {} }, 'form the panel does not recognize'],
  ])('explains why a response was refused: %j', (value, reason) => {
    expect(codexRejectionReason(value)).toContain(reason);
    expect(codexRejectionReason(value)).not.toContain('private');
  });

  it('allows absent optional details without inferring plan or identity and drops unrelated fields', () => {
    const result = normalizeCodexHost(snapshot([null, limit({ windows: null, planType: null, extra: 'private' })],
      { email: 'private', lastUpdated: Date.now(), futureField: { secret: 'private' } }))!;
    expect(result).toEqual({ buckets: [{ id: 'codex', label: 'codex', windows: [] }] });
    expect(normalizeCodexHost(snapshot())).toEqual({ buckets: [] });
  });
});

describe('Codex host compatibility', () => {
  it('is registered only for Codex and keeps failed/unknown auth unavailable without reading quota', async () => {
    const invoke = vi.fn(async () => null);
    const adapter = adapterFor('openai-codex');
    expect(adapter.account).toBe(codexAccountAdapter);
    expect(adapter.capabilities.accountUsage).toBe('supported');
    for (const provider of ['openai', 'openai-compatible', 'custom', 'openai-codex-acp']) {
      expect(adapterFor(provider).account).toBeUndefined();
    }
    const collector = createCodexAccountAdapter({ invoke, budget: newCodexReadBudget() });
    const reading = await collector.collect(collector.scope('/workspace'), new AbortController().signal);
    expect(reading).toMatchObject({ state: 'unavailable', value: null, observedAt: null,
      scope: { provider: 'openai-codex', accountId: null, association: 'unbound' } });
    expect(invoke.mock.calls).toEqual([['openai-codex:check-login']]);
  });
});
