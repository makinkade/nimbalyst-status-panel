import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildSegments } from './StatusPanel';
import { SEGMENT_IDS } from './segments';
import type { SessionRecord } from './lib/ipc';
import type { Status } from './useStatus';
import { statusFixture, type StatusInputs } from './test/statusFixture';

/**
 * GET-89: v1 is Claude Code only, so a session from another provider is
 * allowed to render a rough strip -- but not to throw.
 *
 * The session below is the record Nimbalyst actually wrote for a Codex session
 * created in this workspace: `provider: "openai-codex"`, a model id no Claude
 * label knows, and a `metadata` object with neither `tokenUsage` nor
 * `effortLevel` in it. Everything the panel can learn about a session arrives
 * through `sessions:get`, so that record is the whole of the provider-specific
 * input to the strip.
 */
const CODEX_SESSION: SessionRecord = {
  id: 'efeddbf2-b04b-4bd5-8962-9a184ef9ef9b',
  title: 'GET-89 Codex degradation probe',
  model: 'openai-codex:gpt-6-astra',
  provider: 'openai-codex',
  updatedAt: '2026-09-19T16:12:15.897Z',
  metadata: { toolScope: 'read' } as SessionRecord['metadata'],
};

const WORKSPACE = String.raw`C:\Users\Mark Kinkade\source\repos\nimbalyst-status-panel`;

function codexStatus(overrides: Partial<StatusInputs> = {}): Status {
  return statusFixture({
    session: CODEX_SESSION,
    // The model catalog has no entry for a provider whose CLI is not installed.
    model: null,
    // Codex turns are not served by a Claude model, so nothing parses.
    servedModel: null,
    // `resolveEffortLevel` finds nothing on the session and falls back.
    effort: 'high',
    effortSource: 'builtin',
    permissionMode: 'bypass-all',
    git: { isRepo: true, repoPath: WORKSPACE, branch: 'master', dirtyCount: 2 },
    planUsage: null,
    usage: null,
    loading: false,
    ...overrides,
  }, WORKSPACE);
}

/** Plan-usage readings high enough that the colour is a loud claim. */
const LOUD_PLAN_USAGE = {
  timestamp: new Date().toISOString(),
  fiveHour: 91,
  fiveHourReset: new Date(Date.now() + 3_600_000).toISOString(),
  sevenDay: 88,
  sevenDayReset: new Date(Date.now() + 86_400_000).toISOString(),
  scoped: [{ label: '7d Fable', pct: 95, reset: null }],
};

/** The strip as the panel assembles it: every segment, in default order. */
function renderStrip(status: Status): string {
  const segments = buildSegments(status, WORKSPACE);
  return SEGMENT_IDS.map((id) => renderToStaticMarkup(<>{segments[id]}</>)).join('');
}

/** Just the three plan chips, which are the ones that can lie about a session. */
function renderUsage(status: Status): string {
  const segments = buildSegments(status, WORKSPACE);
  return (['usagePrimary', 'usageSecondary', 'usageAdditional'] as const)
    .map((id) => renderToStaticMarkup(<>{segments[id]}</>))
    .join('');
}

describe('the selected provider strip (GET-225)', () => {
  it('renders every configured segment without throwing for a Codex or bare session', () => {
    expect(() => renderStrip(codexStatus())).not.toThrow();
    expect(() => renderStrip(codexStatus({ session: { id: 'bare' } }))).not.toThrow();
  });

  it('keeps model and provider-neutral cards useful', () => {
    const html = renderStrip(codexStatus());
    for (const value of ['openai-codex:gpt-6-astra', 'High', 'Bypass', 'master', 'nimbalyst-status-panel']) {
      expect(html).toContain(value);
    }
    expect(html).toContain('Context —');
    expect(html).toContain('Token usage is not reported for this session');
  });

  it('never fills Codex or unknown-provider groups with retained Claude readings', () => {
    for (const session of [CODEX_SESSION, { id: 'bare' }]) {
      const html = renderUsage(codexStatus({ session, planUsage: LOUD_PLAN_USAGE }));
      expect(html).not.toContain('91%');
      expect(html).not.toContain('Claude 5h');
      expect(html).not.toContain('#ef5350');
      expect(html).toContain('unavailable');
      expect(html).toContain('var(--nim-text-muted)');
    }
  });

  it('keeps actual Claude windows, thresholds, reset stamps and ownership explanations', () => {
    const html = renderUsage(codexStatus({ session: { id: 'claude', provider: 'claude-code' }, planUsage: LOUD_PLAN_USAGE }));
    expect(html).toContain('Claude 5h');
    expect(html).toContain('Claude 7d');
    expect(html).toContain('7d Fable');
    expect(html).toContain('91% used');
    expect(html).toContain('#ef5350');
    expect(html).toContain('has not been linked to the selected session');
    expect(html).toContain('↻');
  });

  it('keeps the standalone Claude account view explicitly attributed without a session', () => {
    const html = renderUsage(codexStatus({ session: null, planUsage: LOUD_PLAN_USAGE }));
    expect(html).toContain('Claude 5h');
    expect(html).toContain('standalone account reading');
    expect(html).toContain('91% used');
  });

  it('mutes host fallback values with unknown source observation time', () => {
    const html = renderUsage(codexStatus({ session: { id: 'claude', provider: 'claude-code' }, usage: {
      fiveHour: { utilization: 91, resetsAt: null }, sevenDay: { utilization: 88, resetsAt: null },
      sevenDayOpus: { utilization: 95, resetsAt: null },
    } }));
    expect(html).toContain('91% used');
    expect(html).toContain('(stale)');
    expect(html).not.toContain('#ef5350');
    expect(html).toContain('Observation time is unknown');
  });
});
describe('the model chip', () => {
  const OPUS_SESSION: SessionRecord = {
    id: '406e39d9-085d-4d04-9dda-323b0f69c216',
    title: 'Status bar disappearing fix',
    model: 'claude-code:opus-1m',
    provider: 'claude-code',
  };

  function renderModel(status: Status): string {
    return renderToStaticMarkup(<>{buildSegments(status, WORKSPACE).model}</>);
  }

  it('names the version that actually answered, not the one a table remembers', () => {
    // The session this was reported from: an `opus-1m` alias, answered by Opus
    // 5.5, with the chip reading `Opus 5 (1M)`.
    const html = renderModel(
      codexStatus({ session: OPUS_SESSION, servedModel: 'claude-opus-5-5' }),
    );
    expect(html).toContain('Opus 5.5 (1M)');
  });

  it('puts both ids in the tooltip, so a wrong label can be checked', () => {
    const html = renderModel(
      codexStatus({ session: OPUS_SESSION, servedModel: 'claude-opus-5-5' }),
    );
    expect(html).toContain('Requested model: claude-code:opus-1m');
    expect(html).toContain('Last observed reply served by: claude-opus-5-5');
  });

  it('says only what it knows before the first reply', () => {
    const html = renderModel(codexStatus({ session: OPUS_SESSION, servedModel: null }));
    expect(html).toContain('Opus (1M)');
    expect(html).not.toContain('served by');
  });
});
