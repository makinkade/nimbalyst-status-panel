/**
 * GET-106: which copy of the panel is running.
 *
 * The footer exists because GET-99 created a question the panel could not
 * answer: the update chip says a newer release exists, and nothing anywhere
 * named the version you were on. So the two states that matter are "up to
 * date" and "an update is known", and the second has to name *both* versions
 * or it is no better than the chip alone.
 *
 * The version reaches this component as a build-time constant rather than a
 * prop, so the tests stub the global the `define` step would otherwise supply.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VersionFooter } from './ConfigChip';

/** What `vite.config.ts` bakes in as `__PANEL_VERSION__`. */
function withVersion(version: string | undefined) {
  if (version === undefined) vi.unstubAllGlobals();
  else vi.stubGlobal('__PANEL_VERSION__', version);
}

const render = (updateVersion: string | null = null) =>
  renderToStaticMarkup(<VersionFooter updateVersion={updateVersion} />);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the version footer', () => {
  it('names the running version', () => {
    withVersion('0.1.5');
    expect(render()).toContain('Status Panel 0.1.5');
  });

  it('says nothing about updates while up to date', () => {
    withVersion('0.1.5');
    const html = render(null);
    expect(html).not.toContain('available');
    expect(html).toContain('Running 0.1.5.');
  });

  it('names both versions when an update is known', () => {
    // The whole point: "0.1.6 available" alone leaves the reader where the
    // update chip already left them.
    withVersion('0.1.5');
    const html = render('0.1.6');
    expect(html).toContain('0.1.5');
    expect(html).toContain('0.1.6 available');
  });

  it('admits to being a development build rather than trailing off', () => {
    // Only reachable outside `npm run build`, where the define step that
    // supplies the version has not run. A bare "Status Panel" would read as a
    // truncated string rather than as a known state.
    withVersion(undefined);
    const html = render();
    expect(html).toContain('development build');
    expect(html).not.toMatch(/Status Panel\s*<\//);
  });

  it('treats an empty version as no version', () => {
    withVersion('');
    expect(render()).toContain('development build');
  });
});
