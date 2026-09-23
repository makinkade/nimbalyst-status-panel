/**
 * GET-99: the self-update check, held to the three rules that define it.
 *
 * Fail silent, poll rarely, never act on its own. Each is a constraint the
 * panel cannot be allowed to drift off, and each fails in a way that is
 * invisible in normal use -- a check that offers a beta build, or one that
 * burns the hourly GitHub budget, both look exactly like a working check until
 * the day they do not. So they get tests naming the failure rather than the
 * mechanism.
 *
 * The module keeps its throttle in module scope, so each test reopens it
 * through `__resetThrottleForTests()` -- that is what makes the interval floor
 * and the in-flight guard start closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHECK_TTL_MS,
  ReleaseCacheStore,
  ReleaseCheckCache,
  __resetThrottleForTests,
  compareVersions,
  fetchLatestRelease,
  isNewerVersion,
  parseVersion,
  repoSlug,
} from './releaseCheck';

const REPO = 'makinkade/nimbalyst-status-panel';

/** A GitHub `releases/latest` body, in the shape the API actually returns. */
function releaseBody(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'v0.1.4',
    html_url: 'https://github.com/makinkade/nimbalyst-status-panel/releases/tag/v0.1.4',
    name: 'Status Panel 0.1.4',
    published_at: '2026-09-22T10:00:00Z',
    draft: false,
    prerelease: false,
    ...overrides,
  };
}

/** Panel storage, as far as this module can see it. */
function memoryStore(initial: ReleaseCheckCache | null = null): ReleaseCacheStore & {
  value: ReleaseCheckCache | null;
  writes: number;
} {
  return {
    value: initial,
    writes: 0,
    read() {
      return this.value;
    },
    write(next: ReleaseCheckCache) {
      this.value = next;
      this.writes += 1;
    },
  };
}

const mockFetch = vi.fn();

function answerWith(body: unknown, ok = true, status = 200) {
  mockFetch.mockResolvedValue({ ok, status, json: async () => body });
}

beforeEach(() => {
  __resetThrottleForTests();
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  // The module reaches for the timer functions on `window`; under the node
  // environment there is not one, so it gets the globals it would have had.
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

describe('reading a release tag', () => {
  it('reads the tag the repo actually publishes, with its v', () => {
    expect(parseVersion('v0.1.4')).toEqual([0, 1, 4]);
    expect(parseVersion('0.1.4')).toEqual([0, 1, 4]);
  });

  it('refuses a prerelease tag rather than reading it as the stable version', () => {
    // The failure this prevents: stripping `-beta.1` leaves `0.2.0`, which
    // compares as newer than 0.1.3 and offers a beta build to someone who
    // installed a stable one. A tag we cannot read confidently is a tag we say
    // nothing about.
    expect(parseVersion('v0.2.0-beta.1')).toBeNull();
    expect(parseVersion('0.1.4+build7')).toBeNull();
  });

  it('refuses anything that is not a version at all', () => {
    for (const tag of ['latest', 'release-2026-09', '', 'v', 'v1.2.3.4.5', null, undefined]) {
      expect(parseVersion(tag), `parsed ${String(tag)}`).toBeNull();
    }
  });

  it('compares component by component rather than as text', () => {
    // `'0.10.0' > '0.9.0'` is false as strings, which is the whole reason this
    // is not a string comparison.
    expect(compareVersions([0, 10, 0], [0, 9, 0])).toBeGreaterThan(0);
    expect(compareVersions([1, 0], [1, 0, 0])).toBe(0);
    expect(compareVersions([0, 1, 3], [0, 1, 4])).toBeLessThan(0);
  });

  it('treats an unreadable version on either side as "no update"', () => {
    expect(isNewerVersion('v0.1.4', '0.1.3')).toBe(true);
    expect(isNewerVersion('v0.1.3', '0.1.3')).toBe(false);
    expect(isNewerVersion('nightly', '0.1.3')).toBe(false);
    expect(isNewerVersion('v0.1.4', null)).toBe(false);
  });
});

describe('the repo to ask about', () => {
  it('accepts the shapes a repository URL turns up in', () => {
    for (const url of [
      'https://github.com/makinkade/nimbalyst-status-panel',
      'https://github.com/makinkade/nimbalyst-status-panel/',
      'https://github.com/makinkade/nimbalyst-status-panel.git',
      'https://www.github.com/makinkade/nimbalyst-status-panel',
    ]) {
      expect(repoSlug(url), url).toBe(REPO);
    }
  });

  it('refuses anything that is not a GitHub repo path', () => {
    // The slug is interpolated straight into an API path, so this is closed
    // rather than tolerant.
    for (const url of [
      'https://gitlab.com/makinkade/status-panel',
      'https://github.com/makinkade',
      'file:///etc/passwd',
      'not a url',
      null,
    ]) {
      expect(repoSlug(url), String(url)).toBeNull();
    }
  });

  it('cannot be walked out of the repos path by a traversal', () => {
    // `new URL` resolves `..` before the path is ever read, so this is the
    // ordinary repo `admin/x` rather than an escape -- and the charset check
    // is what stops anything that survives normalization from carrying a
    // slash, a dot-dot or a query into the API path.
    expect(repoSlug('https://github.com/../../admin/x')).toBe('admin/x');
    expect(repoSlug('https://github.com/owner/repo?ref=../../x')).toBe('owner/repo');
    expect(repoSlug('https://github.com/owner/re%2Fpo')).toBeNull();
  });
});

describe('failing silent', () => {
  it('says nothing when the API rate-limits, which it does at 60/hour per IP', async () => {
    answerWith({}, false, 403);
    expect(await fetchLatestRelease(REPO, memoryStore())).toBeNull();
  });

  it('says nothing when the repo has no releases, or was renamed', async () => {
    answerWith({}, false, 404);
    expect(await fetchLatestRelease(REPO, memoryStore())).toBeNull();
  });

  it('says nothing when the network is gone', async () => {
    mockFetch.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(await fetchLatestRelease(REPO, memoryStore())).toBeNull();
  });

  it('says nothing when the body is not a release', async () => {
    answerWith({ message: 'Not Found' });
    expect(await fetchLatestRelease(REPO, memoryStore())).toBeNull();
  });

  it('never rejects, so a `void` call site cannot become an unhandled rejection', async () => {
    const store = memoryStore();
    store.read = () => {
      throw new Error('storage exploded');
    };
    await expect(fetchLatestRelease(REPO, store)).resolves.toBeNull();
  });

  it('refuses a prerelease even if the endpoint hands one over', async () => {
    // `/releases/latest` excludes them already; this is the second lock.
    answerWith(releaseBody({ prerelease: true }));
    expect(await fetchLatestRelease(REPO, memoryStore())).toBeNull();
  });
});

describe('polling rarely', () => {
  it('serves a fresh cached reading without spending a request', async () => {
    const store = memoryStore({
      checkedAt: Date.now() - 60_000,
      repo: REPO,
      release: {
        tag: 'v0.1.4',
        version: '0.1.4',
        url: 'https://example.invalid',
        name: null,
        publishedAt: null,
      },
    });

    const release = await fetchLatestRelease(REPO, store);

    expect(release?.version).toBe('0.1.4');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('asks again once the reading is older than the TTL', async () => {
    const store = memoryStore({
      checkedAt: Date.now() - CHECK_TTL_MS - 1,
      repo: REPO,
      release: null,
    });
    answerWith(releaseBody());

    expect((await fetchLatestRelease(REPO, store))?.version).toBe('0.1.4');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a cached reading that is about a different repo', async () => {
    // The user reinstalled from a fork; the old answer is not an answer to the
    // new question.
    const store = memoryStore({
      checkedAt: Date.now(),
      repo: 'someone-else/fork',
      release: null,
    });
    answerWith(releaseBody());

    expect((await fetchLatestRelease(REPO, store))?.version).toBe('0.1.4');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('holds the floor between calls even with no cache to hold it', async () => {
    // The guard that matters when storage is absent: a caller re-firing per
    // render would otherwise spend the whole hourly budget in seconds.
    const store = memoryStore();
    store.write = () => {};
    answerWith(releaseBody());

    for (let index = 0; index < 20; index += 1) {
      await fetchLatestRelease(REPO, store);
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    answerWith(releaseBody());
    const store = memoryStore();

    const results = await Promise.all([
      fetchLatestRelease(REPO, store),
      fetchLatestRelease(REPO, store),
      fetchLatestRelease(REPO, store),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result?.version === '0.1.4')).toBe(true);
  });

  it('does not mark a failed check as a completed one', async () => {
    // A failure that advanced `checkedAt` would read as a fresh "no update" and
    // suppress the next six hours of checks on the strength of an outage.
    const store = memoryStore();
    mockFetch.mockRejectedValue(new Error('offline'));

    await fetchLatestRelease(REPO, store);

    expect(store.writes).toBe(0);
    expect(store.value).toBeNull();
  });

  it('keeps showing a known update through an outage', async () => {
    const store = memoryStore({
      checkedAt: Date.now() - CHECK_TTL_MS - 1,
      repo: REPO,
      release: {
        tag: 'v0.1.4',
        version: '0.1.4',
        url: 'https://example.invalid',
        name: null,
        publishedAt: null,
      },
    });
    mockFetch.mockRejectedValue(new Error('offline'));

    // Once we know 0.1.4 exists, losing the network is no reason to stop
    // saying so.
    expect((await fetchLatestRelease(REPO, store))?.version).toBe('0.1.4');
  });
});

describe('what a successful check records', () => {
  it('persists the reading so a restart does not spend a request', async () => {
    answerWith(releaseBody());
    const store = memoryStore();

    await fetchLatestRelease(REPO, store);

    expect(store.writes).toBe(1);
    expect(store.value?.repo).toBe(REPO);
    expect(store.value?.release?.tag).toBe('v0.1.4');
  });

  it('keeps the published tag and the comparable version apart', async () => {
    answerWith(releaseBody());

    const release = await fetchLatestRelease(REPO, memoryStore());

    // `tag` is what the repo calls it and what a URL needs; `version` is what
    // compares against the manifest.
    expect(release?.tag).toBe('v0.1.4');
    expect(release?.version).toBe('0.1.4');
    expect(release?.url).toContain('/releases/tag/v0.1.4');
  });
});
