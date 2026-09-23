/**
 * GET-99: the decision the chip is rendered from.
 *
 * `fetchLatestRelease` is covered in `lib/releaseCheck.test.ts`; what is left
 * to pin down is everything around it -- which repo gets asked, what counts as
 * an update, and the several ways the answer has to come back null. The rule
 * being held here is that *every* negative outcome resolves to null rather than
 * to an error state, because the caller renders nothing for null and that is
 * the whole of "fail silent".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getInstallRecord = vi.fn();

vi.mock('./lib/marketplace', () => ({
  getInstallRecord,
  installFromGitHub: vi.fn(),
  openExternal: vi.fn(),
  copyText: vi.fn(),
}));

const REPO_URL = 'https://github.com/makinkade/nimbalyst-status-panel';
const mockFetch = vi.fn();

function releaseBody(tag: string) {
  return {
    tag_name: tag,
    html_url: `${REPO_URL}/releases/tag/${tag}`,
    name: null,
    published_at: null,
    draft: false,
    prerelease: false,
  };
}

/** A fresh module graph per test, so the release client's throttle starts open. */
async function loadHook() {
  vi.resetModules();
  return import('./useUpdateCheck');
}

beforeEach(() => {
  getInstallRecord.mockReset();
  getInstallRecord.mockResolvedValue({ githubUrl: REPO_URL });
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => releaseBody('v0.1.4') });
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('deciding whether there is an update', () => {
  it('reports the newer release, naming both ends of the jump', async () => {
    const { findUpdate } = await loadHook();

    const update = await findUpdate(undefined, '0.1.3');

    expect(update?.release.version).toBe('0.1.4');
    expect(update?.currentVersion).toBe('0.1.3');
    expect(update?.repositoryUrl).toBe(REPO_URL);
  });

  it('says nothing when the running build is already the latest', async () => {
    const { findUpdate } = await loadHook();
    expect(await findUpdate(undefined, '0.1.4')).toBeNull();
  });

  it('says nothing when the running build is ahead of the latest release', async () => {
    // A local build between releases. Offering a "downgrade to 0.1.4" would be
    // worse than saying nothing.
    const { findUpdate } = await loadHook();
    expect(await findUpdate(undefined, '0.2.0')).toBeNull();
  });

  it('says nothing when the build does not know its own version', async () => {
    // Only reachable outside a real `vite build`, where the manifest version is
    // not defined -- but the comparison would be meaningless rather than
    // merely unavailable, so it must not proceed.
    const { findUpdate } = await loadHook();

    expect(await findUpdate(undefined, null)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('never asks GitHub when there is no repo to ask about', async () => {
    // A symlinked dev install has no marketplace record, and in a test build
    // the manifest's repositoryUrl is not compiled in either.
    getInstallRecord.mockResolvedValue(null);
    const { findUpdate } = await loadHook();

    expect(await findUpdate(undefined, '0.1.3')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('which repo gets asked', () => {
  it('follows the repo the extension was actually installed from', async () => {
    // Someone running a fork should be offered their fork's releases. This is
    // the `githubUrl` on the install record that GET-99 notes nothing in the
    // host ever reads back.
    getInstallRecord.mockResolvedValue({ githubUrl: 'https://github.com/someone/their-fork' });
    const { findUpdate } = await loadHook();

    const update = await findUpdate(undefined, '0.1.3');

    expect(update?.repositoryUrl).toBe('https://github.com/someone/their-fork');
    expect(mockFetch.mock.calls[0][0]).toContain('/repos/someone/their-fork/releases/latest');
  });

  it('ignores an install record whose URL is not a GitHub repo', async () => {
    getInstallRecord.mockResolvedValue({ githubUrl: 'https://example.invalid/x' });
    const { findUpdate } = await loadHook();

    expect(await findUpdate(undefined, '0.1.3')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('the persisted reading', () => {
  it('writes through the panel storage it was handed', async () => {
    const stored: Record<string, unknown> = {};
    const storage = {
      getGlobal: (key: string) => stored[key],
      setGlobal: async (key: string, value: unknown) => {
        stored[key] = value;
      },
    };
    const { findUpdate } = await loadHook();

    await findUpdate(storage, '0.1.3');

    // Its own key, clear of the user's segment config.
    expect(stored.releaseCheck).toMatchObject({ repo: 'makinkade/nimbalyst-status-panel' });
    expect(stored.segments).toBeUndefined();
  });

  it('survives storage that refuses to answer', async () => {
    const storage = {
      getGlobal: () => {
        throw new Error('not hydrated');
      },
      setGlobal: async () => {
        throw new Error('read only');
      },
    };
    const { findUpdate } = await loadHook();

    await expect(findUpdate(storage, '0.1.3')).resolves.toMatchObject({
      release: { version: '0.1.4' },
    });
  });
});
