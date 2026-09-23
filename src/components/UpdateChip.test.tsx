/**
 * GET-99: what the update chip looks like before anyone clicks it.
 *
 * The chip is the one thing in this feature that cannot be exercised against
 * the real app until a newer release actually exists, so the closed state gets
 * pinned here instead. What matters is that it joins the strip's existing
 * vocabulary rather than shouting over it: GET-97 settled that a value the
 * panel is merely mentioning is drawn muted and themed, and a release is a
 * mention, not an alert.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { UpdateChip } from './UpdateChip';
import { MUTED } from '../lib/thresholds';
import type { AvailableUpdate } from '../lib/releaseCheck';

const UPDATE: AvailableUpdate = {
  release: {
    tag: 'v0.1.4',
    version: '0.1.4',
    url: 'https://github.com/makinkade/nimbalyst-status-panel/releases/tag/v0.1.4',
    name: 'Status Panel 0.1.4',
    publishedAt: '2026-09-22T21:15:35Z',
  },
  currentVersion: '0.1.3',
  repositoryUrl: 'https://github.com/makinkade/nimbalyst-status-panel',
};

const html = () => renderToStaticMarkup(<UpdateChip update={UPDATE} />);

describe('the update chip', () => {
  it('names the version on offer', () => {
    expect(html()).toContain('0.1.4');
  });

  it('names both ends of the jump in the tooltip, not just the new one', () => {
    // "Update 0.1.4" alone leaves the reader to remember what they are on.
    const markup = html();
    expect(markup).toContain('0.1.4 is available');
    expect(markup).toContain('running 0.1.3');
  });

  it('is drawn muted rather than as an alert', () => {
    // The stale-reading treatment, not a new red/yellow style. A hex literal
    // here would be the GET-97 bug again: it cannot know which theme it is on.
    expect(html()).toContain(MUTED);
    expect(html()).toContain('var(--nim-text-muted)');
  });

  it('keeps the popover shut until it is asked for', () => {
    // Nothing installs, and nothing is even offered, without a click.
    const markup = html();
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('Update to 0.1.4');
    expect(markup).not.toContain('Install from GitHub');
  });
});
