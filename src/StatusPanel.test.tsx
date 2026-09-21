import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildSegments } from './StatusPanel';
import { SEGMENT_IDS } from './segments';
import type { SessionRecord } from './lib/ipc';
import type { Status } from './useStatus';

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

function codexStatus(overrides: Partial<Status> = {}): Status {
  return {
    session: CODEX_SESSION,
    // The model catalog has no entry for a provider whose CLI is not installed.
    model: null,
    // `resolveEffortLevel` finds nothing on the session and falls back.
    effort: 'high',
    effortSource: 'builtin',
    permissionMode: 'bypass-all',
    git: { repoPath: WORKSPACE, branch: 'master', dirtyCount: 2 },
    planUsage: null,
    usage: null,
    loading: false,
    ...overrides,
  };
}

/** The strip as the panel assembles it: every segment, in default order. */
function renderStrip(status: Status): string {
  const segments = buildSegments(status, WORKSPACE);
  return SEGMENT_IDS.map((id) => renderToStaticMarkup(<>{segments[id]}</>)).join('');
}

describe('a session from another provider', () => {
  it('renders every segment without throwing', () => {
    expect(() => renderStrip(codexStatus())).not.toThrow();
  });

  it('shows the raw model id rather than nothing when no label matches', () => {
    // `friendlyModelName` only knows `claude-code:` variants, so the honest
    // fallback is the id itself -- never "No session", which would misreport a
    // session that is plainly there.
    const html = renderStrip(codexStatus());
    expect(html).toContain('openai-codex:gpt-6-astra');
    expect(html).not.toContain('No session');
  });

  it('degrades the context bar to a placeholder that says why', () => {
    const html = renderStrip(codexStatus());
    expect(html).toContain('Context —');
    expect(html).toContain('no tokenUsage in metadata');
  });

  it('still renders the provider-neutral segments', () => {
    const html = renderStrip(codexStatus());
    expect(html).toContain('High');
    expect(html).toContain('Bypass');
    expect(html).toContain('nimbalyst-status-panel');
    expect(html).toContain('master');
  });

  it('renders the Claude plan bars alongside it rather than failing on them', () => {
    // The usage chips report the Claude plan whatever the session is. Unrelated
    // numbers are the documented v1 rough edge; a crash would not be.
    const html = renderStrip(
      codexStatus({
        planUsage: {
          timestamp: new Date().toISOString(),
          fiveHour: 41,
          fiveHourReset: new Date(Date.now() + 3_600_000).toISOString(),
          sevenDay: 63,
          sevenDayReset: new Date(Date.now() + 86_400_000).toISOString(),
          scoped: [{ label: '7d Fable', pct: 12, reset: null }],
        },
      }),
    );
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
});
