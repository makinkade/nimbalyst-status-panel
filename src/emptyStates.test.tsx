/**
 * GET-97: the strip with nothing behind it.
 *
 * Three ways the panel can be handed no data -- no session, no git repo, no
 * usage reading -- plus the permission-denied case, which is the third of those
 * arriving by a different route: reading your plan directly needs the Claude
 * credentials file, so a denied `permissions.filesystem` looks from in here
 * exactly like an unreachable endpoint.
 *
 * The invariant under all of them is the same, and it is not "renders
 * something": it is that *every configured segment stays on screen and says
 * why it is empty*. A segment that returns `null` is worse than a placeholder,
 * because the user already has a control that makes segments disappear -- the
 * config popover -- so a vanished chip reads as one they switched off rather
 * than as data the panel could not get.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildSegments } from './StatusPanel';
import { SEGMENT_IDS, type SegmentId } from './segments';
import type { Status } from './useStatus';
import { statusFixture, type StatusInputs } from './test/statusFixture';

const WORKSPACE = String.raw`C:\Users\Mark Kinkade\source\repos\nimbalyst-status-panel`;

/** Nothing resolved at all: no session, not a git repo, no usage of any kind. */
function emptyStatus(overrides: Partial<StatusInputs> = {}): Status {
  return statusFixture({
    session: null,
    model: null,
    servedModel: null,
    // GET-223 keeps an honest effort placeholder with no selected session.
    // Defaults only apply after a supported provider/session is known.
    effort: 'high',
    effortSource: 'builtin',
    permissionMode: null,
    git: { repoPath: null, branch: null, dirtyCount: 0 },
    planUsage: null,
    usage: null,
    loading: false,
    ...overrides,
  }, WORKSPACE);
}

function render(id: SegmentId, status: Status, workspacePath = WORKSPACE): string {
  return renderToStaticMarkup(<>{buildSegments(status, workspacePath)[id]}</>);
}

describe('the strip with nothing behind it', () => {
  it('renders every segment rather than throwing', () => {
    expect(() =>
      SEGMENT_IDS.map((id) => render(id, emptyStatus())).join(''),
    ).not.toThrow();
  });

  it('leaves no segment empty, so none can be mistaken for one hidden', () => {
    // The whole point of the pass: `usagePrimary` and `usageSecondary` were the two that
    // returned null here, and they were the only two.
    for (const id of SEGMENT_IDS) {
      expect(render(id, emptyStatus()), `segment "${id}" rendered nothing`).not.toBe('');
    }
  });

  it('says there is no session instead of naming a model', () => {
    expect(render('model', emptyStatus())).toContain('No session');
  });

  it('says the folder is not a repo rather than dropping the branch chip', () => {
    const html = render('branch', emptyStatus());
    expect(html).toContain('No repo');
    expect(html).toContain('is not a git repository');
  });

  it('names the missing workspace state in the permission-mode placeholder', () => {
    const html = render('permissionMode', emptyStatus());
    expect(html).toContain('Workspace —');
    expect(html).toContain('Workspace permission policy is unavailable');
  });

  it('says which link is missing in the context placeholder', () => {
    const html = render('context', emptyStatus());
    expect(html).toContain('Context —');
    expect(html).toContain('No session resolved');
  });
});

describe('a workspace with no folder path at all', () => {
  // `folderName('')` is `''`, which rendered a chip containing nothing but its
  // own icon -- a blank blue rectangle with no text and no tooltip worth
  // reading. `useStatus` explicitly keeps rendering in this state (it clears
  // `loading` with no workspace so the config chip stays reachable), so the
  // strip has to have something to say.
  it('says there is no folder instead of rendering a bare icon', () => {
    const html = render('directory', emptyStatus(), '');
    expect(html).toContain('No folder');
  });

  it('still names the folder when there is one', () => {
    expect(render('directory', emptyStatus())).toContain('nimbalyst-status-panel');
  });
});

describe('the usage windows with no reading behind them', () => {
  it('holds the primary and secondary groups open with a placeholder', () => {
    expect(render('usagePrimary', emptyStatus())).toContain('Primary usage —');
    expect(render('usageSecondary', emptyStatus())).toContain('Secondary usage —');
  });

  it('explains a missing reading without guessing credentials or permission state', () => {
    // A denied file permission and an absent adapter cannot be diagnosed from
    // a missing reading alone. The production adapter supplies specific reasons.
    const html = render('usagePrimary', emptyStatus());
    expect(html).toContain('No account usage adapter or reading');
  });

  it('reports unavailable host usage without rendering raw host errors', () => {
    const html = render('usagePrimary', emptyStatus({ usage: { error: 'not logged in' } }));
    expect(html).toContain('Claude usage is unavailable from the host');
  });

  it('distinguishes a reading that simply lacks the window', () => {
    // The endpoint answered; this particular window was not in the answer. That
    // is not an outage and should not be described as one.
    const html = render(
      'usageSecondary',
      emptyStatus({ planUsage: { timestamp: new Date().toISOString(), fiveHour: 12 } }),
    );
    expect(html).toContain('No applicable secondary window');
    expect(html).not.toContain('unreachable');
  });

  it('still renders the real bar when there is a reading', () => {
    const html = render(
      'usagePrimary',
      emptyStatus({ planUsage: { timestamp: new Date().toISOString(), fiveHour: 42 } }),
    );
    expect(html).toContain('42%');
    expect(html).not.toContain('Primary usage —');
  });
});
