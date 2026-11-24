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
    git: { repoPath: WORKSPACE, branch: 'master', dirtyCount: 2 },
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
  return (['usage5h', 'usage7d', 'usageScoped'] as const)
    .map((id) => renderToStaticMarkup(<>{segments[id]}</>))
    .join('');
}

describe('a session from another provider', () => {
  it('renders every segment without throwing', () => {
    expect(() => renderStrip(codexStatus())).not.toThrow();
  });

  it('shows the raw model id rather than nothing when no label matches', () => {
    // `modelLabel` only parses Claude ids, so the honest fallback is the id
    // itself -- never "No session", which would misreport a session that is
    // plainly there.
    const html = renderStrip(codexStatus());
    expect(html).toContain('openai-codex:gpt-6-astra');
    expect(html).not.toContain('No session');
  });

  it('degrades the context bar to a placeholder that says why', () => {
    const html = renderStrip(codexStatus());
    expect(html).toContain('Context —');
    expect(html).toContain('Token usage is not reported for this session');
  });

  it('still renders the provider-neutral segments', () => {
    const html = renderStrip(codexStatus());
    expect(html).toContain('High');
    expect(html).toContain('Bypass');
    expect(html).toContain('nimbalyst-status-panel');
    expect(html).toContain('master');
  });

  it('still renders the Claude plan bars rather than dropping them', () => {
    // GET-103 chose to qualify these chips, not to hide them: the Claude plan
    // is yours whichever session is in front of you.
    const html = renderStrip(codexStatus({ planUsage: LOUD_PLAN_USAGE }));
    expect(html).toContain('5h');
    expect(html).toContain('7d Fable');
  });

  it('survives a session stripped down to an id', () => {
    // Nothing downstream may assume a model, a title or any metadata at all.
    const bare: SessionRecord = { id: 'bare' };
    expect(() =>
      renderStrip(
        codexStatus({
          session: bare,
          permissionMode: null,
          git: { repoPath: null, branch: null, dirtyCount: 0 },
        }),
      ),
    ).not.toThrow();
  });

  it('uses a model placeholder for a bare selected session and mutes unknown-provider Claude usage', () => {
    const html = renderStrip(codexStatus({ session: { id: 'bare' }, planUsage: LOUD_PLAN_USAGE }));
    expect(html).toContain('Model —');
    expect(html).toContain('Claude 5h');
    expect(html).toContain('unknown provider');
    expect(html).not.toContain('No session');
  });
});

/**
 * GET-103: the plan chips read Anthropic's usage endpoint with your Claude
 * credentials, so they describe your Claude plan whatever session is focused.
 * Beside a Codex session a red `5h 91%` reads as urgency about *that* session,
 * which is the false claim. The numbers stay; the label says whose plan they
 * are, and the colour stops asserting urgency the panel cannot vouch for.
 */
describe('the plan chips beside a non-Claude session', () => {
  const MUTED = 'var(--nim-text-muted)';

  it('qualifies every label with the plan it actually describes', () => {
    const html = renderUsage(codexStatus({ planUsage: LOUD_PLAN_USAGE }));
    expect(html).toContain('Claude 5h');
    expect(html).toContain('Claude 7d');
    expect(html).toContain('Claude 7d Fable');
  });

  it('drops the urgency colour a loud reading would otherwise carry', () => {
    const html = renderUsage(codexStatus({ planUsage: LOUD_PLAN_USAGE }));
    // 91 / 88 / 95 are all past `usageColor`'s red threshold.
    expect(html).not.toContain('#ef5350');
    // All three chips: 5h, 7d and the one scoped cap.
    expect(html.split(MUTED).length - 1).toBeGreaterThanOrEqual(3);
  });

  it('says so in the tooltip, naming the provider actually in front of you', () => {
    const html = renderUsage(codexStatus({ planUsage: LOUD_PLAN_USAGE }));
    expect(html).toContain('describes your Claude plan, not this session');
    expect(html).toContain('openai-codex');
  });

  it('keeps the percentage itself intact', () => {
    // Demotion is about the claim, not the data: hiding the number was the
    // option GET-103 rejected.
    const html = renderUsage(codexStatus({ planUsage: LOUD_PLAN_USAGE }));
    expect(html).toContain('91%');
    expect(html).toContain('95%');
  });

  it('degrades the fallback bars from claude-usage:get the same way', () => {
    // No plan-usage reading, so the chips come from the host channel instead.
    const html = renderUsage(
      codexStatus({
        usage: {
          fiveHour: { utilization: 91, resetsAt: null },
          sevenDay: { utilization: 88, resetsAt: null },
          sevenDayOpus: { utilization: 95, resetsAt: null },
        },
      }),
    );
    expect(html).toContain('Claude 5h');
    expect(html).toContain('Claude 7d Opus');
    expect(html).not.toContain('#ef5350');
  });

  it('qualifies the empty scoped-caps placeholder too', () => {
    const html = renderUsage(
      codexStatus({ planUsage: { ...LOUD_PLAN_USAGE, scoped: [] } }),
    );
    expect(html).toContain('No scoped caps');
    expect(html).toContain('the caps are not about it');
  });

  it('degrades on the model id alone when the record carries no provider', () => {
    const html = renderUsage(
      codexStatus({
        session: { id: 'x', model: 'openai-codex:gpt-5.6-luna' },
        planUsage: LOUD_PLAN_USAGE,
      }),
    );
    expect(html).toContain('Claude 5h');
  });
});

describe('the plan chips beside a Claude session', () => {
  const CLAUDE_SESSION: SessionRecord = {
    id: '0b6a0f22-5f1f-4a1d-bb2a-0a5a2b1f9c77',
    title: 'Status panel work',
    model: 'claude-code:opus-1m',
    provider: 'claude-code',
  };

  it('leaves the labels bare and the urgency colour intact', () => {
    // The disclaimer is only worth its width when there is a competing model on
    // screen; here the bars are exactly what they appear to be.
    const html = renderUsage(
      codexStatus({ session: CLAUDE_SESSION, planUsage: LOUD_PLAN_USAGE }),
    );
    expect(html).toContain('>5h<');
    expect(html).not.toContain('Claude 5h');
    expect(html).toContain('#ef5350');
  });

  it('leaves them alone when no session is resolved at all', () => {
    // Nothing on screen to contradict: the bars are simply your plan.
    const html = renderUsage(codexStatus({ session: null, planUsage: LOUD_PLAN_USAGE }));
    expect(html).not.toContain('Claude 5h');
    expect(html).toContain('#ef5350');
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
    expect(html).toContain('claude-code:opus-1m, served by claude-opus-5-5');
  });

  it('says only what it knows before the first reply', () => {
    const html = renderModel(codexStatus({ session: OPUS_SESSION, servedModel: null }));
    expect(html).toContain('Opus (1M)');
    expect(html).not.toContain('served by');
  });
});
