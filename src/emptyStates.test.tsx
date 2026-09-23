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

const WORKSPACE = String.raw`C:\Users\Mark Kinkade\source\repos\nimbalyst-status-panel`;

/** Nothing resolved at all: no session, not a git repo, no usage of any kind. */
function emptyStatus(overrides: Partial<Status> = {}): Status {
  return {
    session: null,
    model: null,
    // Effort still resolves with no session -- it is the app-level default the
    // next session would use, and the tooltip says so.
    effort: 'high',
    effortSource: 'builtin',
    permissionMode: null,
    git: { repoPath: null, branch: null, dirtyCount: 0 },
    planUsage: null,
    usage: null,
    loading: false,
    ...overrides,
  };
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
    // The whole point of the pass: `usage5h` and `usage7d` were the two that
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
    expect(html).toContain('Mode —');
    expect(html).toContain('agentPermissions.permissionMode');
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
  it('holds the 5h and 7d segments open with a placeholder', () => {
    expect(render('usage5h', emptyStatus())).toContain('5h —');
    expect(render('usage7d', emptyStatus())).toContain('7d —');
  });

  it('names the denied-permission case, which is indistinguishable from here', () => {
    // A denied `permissions.filesystem` means no credentials file, so no token,
    // so no plan reading -- and the tooltip is the only place that can say so.
    const html = render('usage5h', emptyStatus());
    expect(html).toContain('filesystem permission is denied');
  });

  it('reports the host channel error when that is what came back', () => {
    const html = render('usage5h', emptyStatus({ usage: { error: 'not logged in' } }));
    expect(html).toContain('Usage unavailable: not logged in');
  });

  it('distinguishes a reading that simply lacks the window', () => {
    // The endpoint answered; this particular window was not in the answer. That
    // is not an outage and should not be described as one.
    const html = render(
      'usage7d',
      emptyStatus({ planUsage: { timestamp: new Date().toISOString(), fiveHour: 12 } }),
    );
    expect(html).toContain('carried no 7d window');
    expect(html).not.toContain('unreachable');
  });

  it('still renders the real bar when there is a reading', () => {
    const html = render(
      'usage5h',
      emptyStatus({ planUsage: { timestamp: new Date().toISOString(), fiveHour: 42 } }),
    );
    expect(html).toContain('42%');
    expect(html).not.toContain('5h —');
  });
});
