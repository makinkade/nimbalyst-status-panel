import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsageChip } from '../components/UsageChip';
import { USAGE_GROUP_IDS } from '../segments';
import { normalizeSessionStatus, selectedAccountUsage } from './providerAdapters';
import { claudeReading, normalizeClaudePlan } from './providers/claude';
import { normalizeCodexHost, CODEX_USAGE_UNBOUND } from './providers/codex';
import { measured, missing, type AccountUsage, type Reading, type ReadingScope, type UsageWindow } from './statusModel';
import { MUTED, NEUTRAL, PALETTE } from './thresholds';
import { usagePresentation } from './usagePresentation';

// Synthetic contract cases; the real audited payload is exercised separately below.
const now = Date.parse('2026-11-24T15:00:00Z');
const scope: ReadingScope = { kind: 'account', provider: 'future-provider', workspacePath: '<workspace>',
  accountId: 'verified-account', association: 'verified' };
const window = (overrides: Partial<UsageWindow> = {}): UsageWindow => ({ id: 'arbitrary', label: '3h burst',
  role: 'primary', durationMinutes: 180, utilization: { value: 42, unit: 'percent-used' }, resetsAt: null, ...overrides });
const reading = (windows = [window()], extras: Partial<AccountUsage> = {}): Reading<AccountUsage> =>
  measured({ buckets: [{ id: 'general', label: 'General allowance', windows }], ...extras }, 'verified-source', scope, now, now, 60000);
function model(account = reading(), provider: string | null = scope.provider) {
  return normalizeSessionStatus({ workspacePath: '<workspace>',
    session: { id: 'selected', ...(provider ? { provider } : {}) }, models: [],
    defaultEffort: null, permissionMode: null, accounts: [account], now });
}
const groups = (account = reading()) => usagePresentation(model(account), undefined, now);
const primary = (account = reading()) => groups(account).usagePrimary.cards[0];
const render = (account = reading()) => USAGE_GROUP_IDS.flatMap((id) => groups(account)[id].cards)
  .map((card) => renderToStaticMarkup(<UsageChip card={card} />)).join('');

describe('provider-neutral usage cards', () => {
  it.each([0, 49, 50, 80, 81, 100, 120])('preserves %s percent used and the existing threshold boundaries', (percent) => {
    const card = primary(reading([window({ utilization: { value: percent, unit: 'percent-used' } })]));
    const html = renderToStaticMarkup(<UsageChip card={card} />);
    expect(card).toMatchObject({ value: `${percent}% used`, percent, muted: false });
    expect(html).toContain(percent > 80 ? PALETTE.red : percent >= 50 ? PALETTE.yellow : PALETTE.green);
    expect(html).toContain(`${percent} percent used`);
    if (percent === 120) expect(html.split(PALETTE.red).length - 1).toBe(12); // border, icon, ten cells
  });

  it.each([0, 25, 100])('converts %s percent remaining to used and explains the source direction', (remaining) => {
    const card = primary(reading([window({ utilization: { value: remaining, unit: 'percent-remaining' } })]));
    expect(card).toMatchObject({ percent: 100 - remaining, value: `${100 - remaining}% used` });
    expect(card.title).toContain(`${remaining}% remaining reported`);
  });

  it.each([NaN, Infinity, -1])('does not turn invalid utilization %s into zero or unlimited', (value) => {
    const card = primary(reading([window({ utilization: { value, unit: 'percent-used' } })]));
    expect(card).toMatchObject({ value: null, percent: null, muted: true });
    const html = renderToStaticMarkup(<UsageChip card={card} />);
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain('0%');
    expect(html).not.toContain('Unlimited');
    expect(card.title).toContain('No usable utilization');
  });

  it('rejects impossible remaining percentages and unfamiliar units', () => {
    expect(primary(reading([window({ utilization: { value: 101, unit: 'percent-remaining' } })])).percent).toBeNull();
    expect(primary(reading([window({ utilization: { value: 1, unit: 'unknown' as 'tokens' } })])).value).toBeNull();
  });

  it('keeps weekly-only accounts secondary without fabricating a primary limit', () => {
    const result = groups(reading([window({ role: 'secondary', label: 'Weekly', durationMinutes: 10080 })]));
    expect(result.usagePrimary.cards[0].title).toContain('No applicable primary window');
    expect(result.usagePrimary.cards[0].percent).toBeNull();
    expect(result.usageSecondary.cards[0].label).toBe('future-provider Weekly');
    expect(result.usageSecondary.cards[0].title).toContain('7d (10080 minutes)');
  });

  it('uses arbitrary durations and includes non-model buckets without roles', () => {
    const result = groups(reading([], { buckets: [
      { id: 'projects', label: 'Project runs', windows: [window({ label: 'Burst', durationMinutes: 95 })] },
      { id: 'tools', label: 'Tool calls', windows: [window({ role: undefined, label: 'Daily calls', durationMinutes: 1440 })] },
    ] }));
    expect(result.usagePrimary.cards[0].title).toContain('95m (95 minutes)');
    expect(result.usageAdditional.cards[0].label).toBe('future-provider Tool calls: Daily calls');
    expect(result.usageAdditional.cards[0].title).toContain('1d (1440 minutes)');
    expect(result.usageAdditional.label).toContain('Tool calls: Daily calls');
    expect(result.usageAdditional.description).toContain('Provider: future-provider');
  });

  it('distinguishes successful absent windows and empty buckets from an outage', () => {
    const result = groups(reading([], { buckets: [{ id: 'empty', label: 'Extra bucket', windows: [] }] }));
    expect(result.usagePrimary.cards[0].label).toContain('not applicable');
    expect(result.usagePrimary.cards[0].title).not.toContain('No account usage adapter');
    expect(result.usageAdditional.cards[0].title).toContain('no usable window or credits');
    expect(groups(reading([], { buckets: [] })).usageAdditional.cards[0].title).toContain('No additional limits or credits');
  });

  it('deduplicates windows, merges repeated buckets, and separates credits keys', () => {
    const first = window({ id: 'credits', role: 'additional' });
    const list = groups(reading([], { buckets: [
      { id: 'same', label: 'One', windows: [] },
      { id: 'same', label: 'One', windows: [first, first], credits: { balance: 10 } },
      { id: 'other', label: 'Two', windows: [first] },
    ] })).usageAdditional.cards;
    expect(list).toHaveLength(3);
    expect(new Set(list.map((card) => card.key)).size).toBe(3);
    expect(list.some((card) => card.title.includes('no usable window'))).toBe(false);
  });

  it('keeps source identities stable across display reordering and label/reset changes', () => {
    const entries = [window(), window({ id: 'extra', role: undefined })];
    const keys = (windows: UsageWindow[]) => USAGE_GROUP_IDS.flatMap((id) => groups(reading(windows))[id].cards.map((c) => c.key)).sort();
    expect(keys(entries)).toEqual(keys([...entries].reverse().map((w) => ({ ...w, label: 'Renamed', resetsAt: 'new' }))));
  });
});

describe('units, credits and resets', () => {
  it.each(['credits', 'tokens'] as const)('renders %s quantities without a bar or urgency', (unit) => {
    const card = primary(reading([window({ utilization: { value: 23000, unit } })]));
    expect(card).toMatchObject({ percent: null, value: `23,000 ${unit}`, muted: false });
    const html = renderToStaticMarkup(<UsageChip card={card} />);
    expect(html).toContain(NEUTRAL);
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain(PALETTE.red);
    expect(card.title).toContain('no percentage or monetary spend');
  });

  it.each([
    [{ balance: 0 }, 'Balance 0'], [{ balance: '12.50' }, 'Balance 12.50'],
    [{ unlimited: true }, 'Unlimited'], [{ unlimited: false }, null],
    [{ hasCredits: true }, 'Available'], [{ hasCredits: false }, 'None available'], [{}, null],
  ] as const)('renders only explicit credit details %j', (credits, value) => {
    const account = reading([], { plan: 'Reported plan', buckets: [{ id: 'credits', label: 'Extra', windows: [], credits }] });
    const result = groups(account);
    expect(result.usageAdditional.cards[0].value).toBe(value);
    expect(result.usageAdditional.cards[0].percent).toBeNull();
    expect(result.usageAdditional.cards[0].title).toContain('Plan: Reported plan');
    expect(result.usagePrimary.cards[0].label).toContain('not applicable');
    expect(render(account)).not.toContain('role="img"');
  });

  it('includes only supplied bucket plan, model scope and reset-credit count', () => {
    const card = primary(reading([], { resetCredits: { availableCount: 0 }, buckets: [
      { id: 'model', label: 'Fast', modelScope: 'Fast model', plan: 'Team', windows: [window()] },
    ] }));
    expect(card.title).toContain('Bucket plan: Team');
    expect(card.title).toContain('Model scope: Fast model');
    expect(card.title).toContain('Reset credits available: 0');
    expect(primary().title).not.toContain('Plan:');
  });

  it('renders an explicitly supplied reset-credit count even without quota buckets', () => {
    const account = reading([], { buckets: [], resetCredits: { availableCount: 2 } });
    const card = groups(account).usageAdditional.cards[0];
    expect(card).toMatchObject({ value: '2 available', percent: null, label: 'future-provider Reset credits' });
    expect(render(account)).not.toContain('No additional limits or credits');
  });

  it('lists each reset credit and its expiry in the reset-credit tooltip', () => {
    const expiresAt = new Date(now + 13 * 86_400_000 + 2 * 3_600_000).toISOString();
    const account = reading([], { buckets: [], resetCredits: { availableCount: 2, credits: [
      { id: 'a', title: 'Full reset', description: 'Resets every window.', expiresAt },
      { id: 'b', title: null, description: null, expiresAt: null },
    ] } });
    const title = groups(account).usageAdditional.cards[0].title;
    expect(title).toMatch(/Full reset: expires \S+ \S+ \(in 13d 2h\)\. Resets every window\./);
    expect(title).toContain('Reset credit: no expiry reported.');
    const unreported = reading([], { buckets: [], resetCredits: { availableCount: 1, credits: null } });
    expect(groups(unreported).usageAdditional.cards[0].title).toContain('Individual reset-credit details are not reported.');
  });

  it('explains valid, missing, invalid and elapsed resets without inventing a countdown', () => {
    const card = primary(reading([window({ resetsAt: new Date(now + 3600000).toISOString() })]));
    expect(card.reset).not.toBe('');
    expect(card.title).toContain('(in 1h)');
    expect(primary().title).toContain('Reset time is not reported');
    expect(primary(reading([window({ resetsAt: 'invalid' })])).title).toContain('could not be read');
    expect(primary(reading([window({ resetsAt: new Date(now - 3600000).toISOString() })])).title).not.toContain('(in ');
  });
});

describe('scope, states and freshness', () => {
  it.each(['unsupported', 'unauthenticated', 'unavailable'] as const)('keeps all groups visible when %s', (state) => {
    const result = groups(missing<AccountUsage>(state, 'source', scope, 'Specific source explanation', now));
    for (const id of USAGE_GROUP_IDS) {
      expect(result[id].cards[0]).toMatchObject({ value: null, percent: null, muted: true });
      expect(result[id].cards[0].title).toContain('Specific source explanation');
      expect(result[id].cards[0].label).toContain(state === 'unauthenticated' ? 'sign in required' : state);
    }
  });

  it('uses observation time, not fetchedAt, and retains timestamps on failure', () => {
    const account = reading();
    const aged = usagePresentation(model(account), undefined, now + 60001).usagePrimary.cards[0];
    expect(aged).toMatchObject({ stale: true, muted: true, percent: 42 });
    expect(aged.title).toContain('last successful cached reading');
    const failed: Reading<AccountUsage> = { ...account, state: 'stale', value: account.value!, reason: 'Offline' };
    expect(primary(failed).title).toContain('Offline');
    expect(primary(failed).title).toContain(new Date(now).toLocaleString());
    expect(account).toMatchObject({ state: 'available', observedAt: now, fetchedAt: now });
    expect(render(failed)).toContain(MUTED);
    expect(render(failed)).toContain('(stale)');
  });

  it.each([null, NaN, now + 1])('mutes an unknown or future observation time %s', (observedAt) => {
    expect(primary({ ...reading(), observedAt, staleAfterMs: undefined })).toMatchObject({ stale: true, muted: true });
  });

  it('rejects mismatched scopes and ambiguous accounts instead of taking the first', () => {
    for (const extra of [{ workspacePath: '<other>' }, { sessionId: 'other' }, { kind: 'session' as const }]) {
      const wrong = { ...reading(), scope: { ...scope, ...extra } };
      expect(selectedAccountUsage(model(wrong)).value).toBeNull();
      expect(primary(wrong).title).toContain('different workspace or session scope');
    }
    const data = model();
    data.accounts.push({ ...reading(), scope: { ...scope, accountId: 'another' } });
    expect(selectedAccountUsage(data).reason).toContain('ambiguous');
    expect(usagePresentation(data, undefined, now).usagePrimary.cards[0].value).toBeNull();
  });

  it('mutes an explicitly retained reading from a different workspace even for the same provider', () => {
    const data = model();
    const foreign = { ...reading(), scope: { ...scope, workspacePath: '<other>' } };
    const card = usagePresentation(data, foreign, now).usagePrimary.cards[0];
    expect(card).toMatchObject({ value: '42% used', muted: true });
    expect(card.title).toContain('not this session’s quota');
  });

  it('keeps unbound same-provider values explicit without claiming session ownership', () => {
    const card = primary({ ...reading(), scope: { ...scope, accountId: null, association: 'unbound' } });
    expect(card.title).toContain('has not been linked to the selected session');
    expect(card.title).toContain('Account identity is not reported');
    expect(card.value).toBe('42% used');
  });

  it('follows the selected provider while any explicit foreign display stays attributed/muted', () => {
    const data = model(reading(), 'openai-codex');
    const own = usagePresentation(data, undefined, now).usagePrimary.cards[0];
    expect(own).toMatchObject({ value: null, muted: true });
    expect(own.label).toContain('Codex');
    const retained = usagePresentation(data, data.accounts[0], now).usagePrimary.cards[0];
    expect(retained).toMatchObject({ value: '42% used', muted: true });
    expect(retained.title).toContain('not this session’s quota');
    expect(retained.label).toContain('future-provider');
    expect(renderToStaticMarkup(<UsageChip card={retained} />)).toContain(MUTED);
  });

  it('preserves unknown identity even if an unowned reading has a null provider', () => {
    const data = model({ ...reading(), scope: { ...scope, provider: null } }, null);
    const card = usagePresentation(data, undefined, now).usagePrimary.cards[0];
    expect(card.value).toBeNull();
    expect(card.title).toContain('provider is unknown');
  });

  it('keeps unsupported provider cards honest even while Claude data exists', () => {
    const data = model({ ...reading(), scope: { ...scope, provider: 'claude-code' } }, 'copilot-cli');
    const card = usagePresentation(data, undefined, now).usagePrimary.cards[0];
    expect(card.label).toContain('unsupported');
    expect(card.title).toContain('No quota API');
  });

  it('preserves the explicit standalone Claude view without a session', () => {
    const account = measured(normalizeClaudePlan({ fiveHour: 0 }), 'claude-direct',
      { ...scope, provider: 'claude-code', association: 'unbound' }, now, now, 300000);
    const data = model(account);
    data.session = null;
    const card = usagePresentation(data, undefined, now).usagePrimary.cards[0];
    expect(card.label).toBe('Claude 5h');
    expect(card.value).toBe('0% used');
    expect(card.title).toContain('standalone account reading');
  });
});

describe('audited Claude host payload in production presentation', () => {
  it('retains real percentages, window roles, scope and old observation time', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/status-host-0.83.0.json', import.meta.url), 'utf8'));
    const payload = (channel: string, index = 0) => fixture.observations.filter((row: { channel: string }) => row.channel === channel)[index].payload;
    const capturedAt = Date.parse(fixture.provenance.capturedAt);
    const account = claudeReading(payload('claude-usage:get'), { ...scope, provider: 'claude-code',
      accountId: null, association: 'unbound' }, 'claude-host', capturedAt);
    const data = normalizeSessionStatus({ workspacePath: '<workspace>', session: payload('sessions:get', 1).session,
      models: [], defaultEffort: null, permissionMode: null, accounts: [account], now: capturedAt });
    const result = usagePresentation(data, undefined, capturedAt);
    expect(result.usagePrimary.cards[0]).toMatchObject({ label: 'Claude 5h', percent: 17, stale: true, muted: true });
    expect(result.usageSecondary.cards[0].label).toBe('Claude 7d');
    expect(result.usagePrimary.cards[0].title).toContain('claude-host');
    expect(account.observedAt).toBe(payload('claude-usage:get').lastUpdated);
  });
});

describe('compact Codex labels with full attribution in tooltips', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/status-host-0.83.0.json', import.meta.url), 'utf8'));
  const host = fixture.observations.find((r: { channel: string }) => r.channel === 'codex-usage:refresh').payload;
  function present(payload: unknown) {
    const account: Reading<AccountUsage> = { ...measured(normalizeCodexHost(payload)!, 'codex-host-account',
      { ...scope, provider: 'openai-codex', accountId: null, association: 'unbound' }, null, now),
      freshnessBasis: 'receipt', staleAfterMs: 120000, lastSuccessfulFetchAt: now, reason: CODEX_USAGE_UNBOUND };
    return usagePresentation(model(account, 'openai-codex'), undefined, now);
  }
  it('renders the audited default windows/credits without duplicating provider or bucket names', () => {
    const result = present(host);
    expect(result.usagePrimary.cards[0].label).toBe('Codex 5h');
    expect(result.usageSecondary.cards[0].label).toBe('Codex 7d');
    expect(result.usageAdditional.cards.map(c => c.label)).toContain('Codex credits');
    for (const card of Object.values(result).flatMap(g => g.cards)) {
      expect(card.label).not.toMatch(/Host-reported|Codex codex/i);
      expect(card.stale).toBe(false);
      expect(card.muted).toBe(false);
      expect(card.title).toContain('Host-reported Codex allowance');
      expect(renderToStaticMarkup(<UsageChip card={card} />)).not.toContain('(stale)');
    }
  });
  it('preserves meaningful names and distinct keys for additional buckets', () => {
    const multiple = structuredClone(host);
    multiple.limits.push({ ...structuredClone(multiple.limits[0]), id: 'code-review', name: 'Code review' });
    const result = present(multiple);
    expect(result.usagePrimary.cards.map(c => c.label)).toEqual(['Codex 5h', 'Codex Code review 5h']);
    expect(new Set(result.usagePrimary.cards.map(c => c.key)).size).toBe(2);
    expect(result.usagePrimary.cards[1].title).toContain('Bucket: Code review');
  });
});
