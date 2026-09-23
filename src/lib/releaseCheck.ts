/**
 * Self-update check: is there a newer GitHub release than the build running?
 *
 * Nimbalyst never auto-updates a GitHub-installed extension. `checkForUpdates()`
 * walks every install record, including `source: 'github-url'` ones, but only
 * matches them against *registry* entries by id -- so an extension that is not
 * in the registry never matches and is skipped, silently, forever. The install
 * record persists `githubUrl` and `githubReleaseTag` against a feature that was
 * never built. This is that feature, on our side of the line (GET-99).
 *
 * Three rules shape everything below, and each is a constraint rather than a
 * preference:
 *
 *  - **Fail silent.** No network, rate-limited, malformed JSON, repo renamed,
 *    tag we cannot parse -- every one of them resolves to "no update to show".
 *    None of them may put an error or a spinner in the strip. A release is not
 *    urgent news, and the panel is not the place to report that GitHub is down.
 *  - **Poll rarely.** The unauthenticated GitHub API allows 60 requests an hour
 *    *per IP*, shared with every other tool on the machine. Six hours between
 *    checks is plenty, and the reading is persisted so restarting Nimbalyst
 *    does not spend a request.
 *  - **Never act on its own.** This module only ever reads. Installing is a
 *    separate call the user makes from the popover.
 *
 * The cache/throttle shape is deliberately the one `planUsage.ts` already uses
 * (GET-83): cache, then network, then whatever is cached however old, behind a
 * module-scope in-flight guard and a minimum interval. Two clients polling two
 * endpoints should not be two different patterns.
 */

export interface ReleaseInfo {
  /** `tag_name` exactly as published, e.g. `v0.1.4`. */
  tag: string;
  /** The same tag as a comparable version, e.g. `0.1.4`. */
  version: string;
  /** The release page, for "what changed". */
  url: string;
  name: string | null;
  publishedAt: string | null;
}

/**
 * The persisted reading.
 *
 * `checkedAt` is only advanced by a check that actually completed, so a run of
 * failures does not read as a fresh "no update" -- it keeps retrying, subject
 * to the interval floor. `repo` is stored with it because the repo can change
 * under the cache (the user reinstalls from a fork), and a reading about a
 * different repo is not a reading about this one.
 */
export interface ReleaseCheckCache {
  checkedAt: number;
  repo: string;
  release: ReleaseInfo | null;
}

export interface ReleaseCacheStore {
  read: () => ReleaseCheckCache | null;
  write: (value: ReleaseCheckCache) => void;
}

/** An update worth telling the user about: newer, parseable, and installable. */
export interface AvailableUpdate {
  release: ReleaseInfo;
  /** The version being replaced, so the popover can name both ends. */
  currentVersion: string;
  /** The repo URL to hand `extension-marketplace:install-from-github`. */
  repositoryUrl: string;
}

const REQUEST_TIMEOUT_MS = 5_000;

/** How long a completed reading stands before it is worth asking again. */
export const CHECK_TTL_MS = 6 * 60 * 60_000;

/**
 * Floor between calls, whatever the caller does.
 *
 * The TTL above is the intended cadence; this is what holds when the cache
 * cannot be written at all (no panel storage, a storage error) and the TTL
 * therefore never bites. Without it a caller that re-fires per render -- an
 * unstable effect dependency, or a stale component a hot reload left mounted --
 * would burn the hourly budget in seconds.
 */
const MIN_INTERVAL_MS = 30 * 60_000;

let inFlight: Promise<ReleaseInfo | null> | null = null;
let lastFinishedAt = 0;
let lastResult: ReleaseInfo | null = null;

/** Test seam: reopen the module-scope throttle without reloading the module. */
export function __resetThrottleForTests(): void {
  inFlight = null;
  lastFinishedAt = 0;
  lastResult = null;
}

/**
 * The latest stable release of `repo`, or null when there is nothing to say.
 *
 * Shares one in-flight promise between concurrent callers and returns the
 * previous answer inside the interval floor, exactly as the plan-usage client
 * does.
 */
export async function fetchLatestRelease(
  repo: string,
  store: ReleaseCacheStore,
): Promise<ReleaseInfo | null> {
  if (inFlight) return inFlight;
  if (Date.now() - lastFinishedAt < MIN_INTERVAL_MS) return lastResult;

  inFlight = runCheck(repo, store)
    // A throw would reject every caller sharing this promise, and the panel
    // polls with `void`, so it would surface as an unhandled rejection rather
    // than as nothing at all. Fail silent has to cover bugs as well as outages.
    .catch((error) => {
      console.debug('[status-panel] release check failed:', error);
      return lastResult;
    })
    .finally(() => {
      inFlight = null;
      lastFinishedAt = Date.now();
    });

  lastResult = await inFlight;
  return lastResult;
}

/**
 * Cache, then network, then whatever is cached however old.
 *
 * The last clause is what keeps a known update on screen through an outage:
 * once we have learned that 0.1.4 exists, losing the network is no reason to
 * stop saying so.
 */
async function runCheck(repo: string, store: ReleaseCacheStore): Promise<ReleaseInfo | null> {
  const cached = readCache(store, repo);
  if (cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.release;

  const release = await requestLatestRelease(repo);
  if (!release) return cached?.release ?? null;

  writeCache(store, { checkedAt: Date.now(), repo, release });
  return release;
}

function readCache(store: ReleaseCacheStore, repo: string): ReleaseCheckCache | null {
  let cached: ReleaseCheckCache | null;
  try {
    cached = store.read();
  } catch {
    return null;
  }

  if (!cached || typeof cached !== 'object') return null;
  if (!Number.isFinite(cached.checkedAt)) return null;
  // A reading about another repo is not a reading about this one.
  if (cached.repo !== repo) return null;
  return cached;
}

function writeCache(store: ReleaseCacheStore, value: ReleaseCheckCache): void {
  try {
    store.write(value);
  } catch (error) {
    // Losing the cache costs a request every half hour, not correctness.
    console.debug('[status-panel] could not persist release check:', error);
  }
}

/**
 * `/releases/latest` is the right endpoint rather than `/releases`: GitHub
 * already excludes drafts and prereleases from it, so the "stable releases
 * only" rule below is enforced twice over.
 */
async function requestLatestRelease(repo: string): Promise<ReleaseInfo | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });

    // 404 (no releases yet, or the repo was renamed) and 403 (rate limited)
    // both land here, and neither is worth a warning: the whole contract of
    // this module is that an unanswerable question shows nothing.
    if (!response.ok) {
      console.debug(`[status-panel] GitHub releases API returned ${response.status}`);
      return null;
    }

    return shapeRelease(await response.json());
  } catch (error) {
    // Offline, DNS, timeout, unparseable body.
    console.debug('[status-panel] release fetch failed:', error);
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

interface ReleaseResponse {
  tag_name?: unknown;
  html_url?: unknown;
  name?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

function shapeRelease(body: unknown): ReleaseInfo | null {
  if (!body || typeof body !== 'object') return null;
  const response = body as ReleaseResponse;

  if (response.draft === true || response.prerelease === true) return null;

  const tag = typeof response.tag_name === 'string' ? response.tag_name : null;
  if (!tag) return null;

  const parsed = parseVersion(tag);
  if (!parsed) return null;

  const url = typeof response.html_url === 'string' ? response.html_url : null;
  if (!url) return null;

  return {
    tag,
    version: parsed.join('.'),
    url,
    name: typeof response.name === 'string' && response.name ? response.name : null,
    publishedAt: typeof response.published_at === 'string' ? response.published_at : null,
  };
}

// -- Versions ---------------------------------------------------------------

/**
 * A plain dotted release version, with an optional `v`.
 *
 * Anchored on purpose, which is what rejects `v0.2.0-beta.1` and
 * `0.1.4+build7`. Stripping a prerelease suffix instead would let
 * `0.2.0-beta.1` compare as `0.2.0` and offer a beta build as an update to a
 * stable one -- a tag we cannot read confidently is a tag we say nothing about.
 */
const VERSION_PATTERN = /^[vV]?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?$/;

/** The numeric components of a version, or null when it is not one we read. */
export function parseVersion(value: string | null | undefined): number[] | null {
  if (typeof value !== 'string') return null;

  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;

  return match
    .slice(1)
    .filter((part): part is string => part !== undefined)
    .map(Number);
}

/** Negative, zero or positive, comparing component by component. */
export function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether `candidate` is a release newer than `current`.
 *
 * Either side being unreadable is false, not true: an unknown comparison must
 * resolve to "no update", never to offering one we cannot justify.
 */
export function isNewerVersion(
  candidate: string | null | undefined,
  current: string | null | undefined,
): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) return false;
  return compareVersions(left, right) > 0;
}

// -- Repository URLs --------------------------------------------------------

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * `owner/repo` from a GitHub URL, or null if it is not one.
 *
 * Tolerant of the shapes a repository URL actually turns up in -- a trailing
 * `.git`, a trailing slash, `www.` -- and closed to everything else, because
 * the result is interpolated into an API path.
 */
export function repoSlug(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.replace(/^www\./, '');
  if (host !== 'github.com') return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, '');
  if (!SEGMENT_PATTERN.test(owner) || !SEGMENT_PATTERN.test(repo)) return null;

  return `${owner}/${repo}`;
}

/** The canonical repo URL for a slug -- what the install channel is handed. */
export function repoUrl(slug: string): string {
  return `https://github.com/${slug}`;
}
