/** GET-227: synthetic failures use the audited host envelopes, then render real chips. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getGitInfo } from './lib/ipc';
import { emptyStatus } from './statusController';
import { buildSegments } from './StatusPanel';

const path = 'C:/workspace/nested';
afterEach(() => vi.unstubAllGlobals());
async function read(repo: unknown, files: unknown = { success: true, files: [] }, branches: unknown = { current: 'master' }) {
  const invoke = vi.fn(async (channel: string) => channel === 'git:is-repo' ? repo
    : channel === 'git:branches' ? branches : files);
  vi.stubGlobal('window', { electronAPI: { invoke } });
  const git = await getGitInfo(path);
  const segments = buildSegments({ ...emptyStatus(path), git }, path);
  const html = renderToStaticMarkup(createElement(Fragment, null, segments.branch, segments.directory));
  return { git, html, invoke };
}

describe('git source-to-card failure states', () => {
  it('shows No repo only after a successful negative check and keeps the folder', async () => {
    const r = await read({ success: true, isRepo: false });
    expect(r.html).toContain('No repo');
    expect(r.html).toContain('nested');
    expect(r.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([null, { success: false, isRepo: false, error: 'denied' }, { success: true }, { success: true, isRepo: 'false' }])(
    'renders failed or malformed detection as unavailable: %j', async (repo) => {
      const r = await read(repo);
      expect(r.git.isRepo).toBeNull();
      expect(r.html).toContain('Git —');
      expect(r.html).toContain('Git status is unavailable');
      expect(r.html).not.toContain('No repo');
      expect(r.html).not.toContain('Clean');
      expect(r.html).toContain('nested');
      expect(r.invoke).toHaveBeenCalledTimes(1);
    });
  it.each([null, { success: false, files: [], error: 'denied' }, { success: true, files: null }])(
    'does not claim a clean tree when the file count fails: %j', async (files) => {
      const r = await read({ success: true, isRepo: true }, files);
      expect(r.git.dirtyCount).toBeNull();
      expect(r.html).toContain('master');
      expect(r.html).toContain('±?');
      expect(r.html).toContain('Uncommitted-file count is unavailable');
      expect(r.html).toContain('var(--nim-text-muted)');
      expect(r.html).not.toContain('Clean');
    });
  it('keeps measured zero clean and reports a measured dirty count', async () => {
    expect((await read({ success: true, isRepo: true })).html).toContain('Clean');
    expect((await read({ success: true, isRepo: true }, { success: true, files: ['a', 'b'] })).html).toContain('±2');
  });
  it('keeps a confirmed repository distinct from missing branch data', async () => {
    const r = await read({ success: true, isRepo: true }, { success: true, files: [] }, { error: 'unavailable' });
    expect(r.html).toContain('Branch —');
    expect(r.html).not.toContain('No repo');
  });
});
