import { useEffect, useRef, useState } from 'react';

import { panelRepositoryUrl, panelVersion } from './lib/buildInfo';
import { getInstallRecord } from './lib/marketplace';
import {
  AvailableUpdate,
  ReleaseCacheStore,
  ReleaseCheckCache,
  fetchLatestRelease,
  isNewerVersion,
  repoSlug,
  repoUrl,
} from './lib/releaseCheck';
import { PanelStorage } from './useSegmentConfig';

export const EXTENSION_ID = 'com.mkinkade.status-panel';

/** Its own storage key, kept clear of the user's `segments` config. */
const STORAGE_KEY = 'releaseCheck';

/**
 * How often the timer looks.
 *
 * Not the poll rate -- `fetchLatestRelease` holds its own six-hour TTL and
 * half-hour floor, and a tick inside either is answered from the cache without
 * touching the network. This is only how promptly the panel notices that the
 * TTL has expired while it has been left open, which for a release is a
 * question of hours, not minutes.
 */
const TICK_MS = 30 * 60_000;

/**
 * Delay before the first check.
 *
 * Panel storage hydrates asynchronously, and `getGlobal` before that lands
 * reads nothing -- which here would mean discarding a perfectly good cached
 * reading and spending a GitHub request on it, once per app start. The cache is
 * read at check time rather than at mount, so waiting a few seconds is all it
 * takes for the read to be a real one. It also keeps the network off the
 * startup path entirely, which is where it least belongs.
 */
const FIRST_CHECK_DELAY_MS = 8_000;

/**
 * Is there a newer release than the build running?
 *
 * Returns null for every negative outcome there is -- up to date, check
 * disabled, no repo to ask about, offline, rate-limited, a tag that will not
 * parse. The caller renders nothing for null, which is the whole of GET-99's
 * "fail silent": the strip gains a chip when there is genuinely an update and
 * is otherwise exactly as it was.
 */
export function useUpdateCheck(
  storage: PanelStorage | undefined,
  enabled: boolean,
): AvailableUpdate | null {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);

  // Read inside the interval callback rather than captured into it, so turning
  // the setting off takes effect on the next tick instead of on a remount.
  const storageRef = useRef(storage);
  storageRef.current = storage;

  useEffect(() => {
    if (!enabled) {
      // Switching the check off should also take the chip down, not just stop
      // asking -- otherwise the last reading sits there with no way to refresh
      // it and no setting that appears to govern it.
      setUpdate(null);
      return;
    }

    let cancelled = false;

    const check = async () => {
      const found = await findUpdate(storageRef.current);
      if (!cancelled) setUpdate(found);
    };

    const first = window.setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
    const timer = window.setInterval(() => void check(), TICK_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [enabled]);

  return update;
}

/**
 * One check, start to finish.
 *
 * Exported for the tests, which drive it with a fake store and a stubbed fetch
 * rather than through a React timer.
 */
export async function findUpdate(
  storage: PanelStorage | undefined,
  currentVersion: string | null = panelVersion(),
): Promise<AvailableUpdate | null> {
  // A build that does not know its own version cannot say anything is newer
  // than it. Only reachable outside a real `vite build`, but the comparison
  // would be meaningless rather than merely unavailable, so it stops here.
  if (!currentVersion) return null;

  const slug = await resolveRepoSlug();
  if (!slug) return null;

  const release = await fetchLatestRelease(slug, cacheStore(storage));
  if (!release) return null;
  if (!isNewerVersion(release.version, currentVersion)) return null;

  return { release, currentVersion, repositoryUrl: repoUrl(slug) };
}

/**
 * Which repo to ask about.
 *
 * The install record first, because that is where this copy actually came from
 * -- someone running a fork should be offered their fork's releases, not ours.
 * The manifest's `repositoryUrl` is the fallback, and it is the only answer for
 * a symlinked dev install, which has no install record at all.
 */
async function resolveRepoSlug(): Promise<string | null> {
  const record = await getInstallRecord(EXTENSION_ID);
  return repoSlug(record?.githubUrl) ?? repoSlug(panelRepositoryUrl());
}

/**
 * The cache, in global extension storage so it survives a restart.
 *
 * Global rather than per-workspace on purpose: the question "is there a newer
 * release" has one answer per machine, and scoping it per workspace would
 * multiply the GitHub requests by however many projects are open.
 *
 * With no storage at hand the reads and writes go nowhere, which is a supported
 * state rather than a broken one -- the check falls back to the module-scope
 * throttle and asks at most once every half hour.
 */
function cacheStore(storage: PanelStorage | undefined): ReleaseCacheStore {
  return {
    read: () => (storage?.getGlobal(STORAGE_KEY) as ReleaseCheckCache | undefined) ?? null,
    write: (value) => {
      void storage?.setGlobal(STORAGE_KEY, value).catch((error) => {
        console.debug('[status-panel] failed to persist release check:', error);
      });
    },
  };
}
