/**
 * Regression cover for the three behaviours GET-83 asks to survive the port to
 * TypeScript, plus the staleness marking that depends on them. Each was added
 * to `get-plan-usage.ps1` after a real failure, so each gets a test naming the
 * failure rather than the mechanism.
 *
 * The module keeps its throttle in module scope, so every test loads a fresh
 * copy through `loadClient()`; `vi.resetModules()` is what makes the 30s floor
 * and the in-flight guard start closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
const mockFetch = vi.fn();

vi.mock('./ipc', () => ({ invoke: mockInvoke, invokeQuiet: mockInvoke }));

const CACHE_FILE = 'statusline-usage-cache.json';
const CREDENTIALS_FILE = '.credentials.json';
/** Stands in for whatever the host resolves `CLAUDE_CONFIG_DIR` to. */
const CONFIG_DIR = '/claude/';

/** The Claude config directory, as a flat map of relative path to contents. */
let files: Record<string, string>;

async function loadClient() {
  vi.resetModules();
  return import('./planUsage');
}

/**
 * The three channels the client uses, behaving as the host does: a missing file
 * answers `success: false` rather than throwing, and `move-file` is a rename.
 */
function installBridge() {
  mockInvoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'read-global-claude-file') {
      const relative = args[0] as string;
      if (!(relative in files)) return { success: false };
      return { success: true, content: files[relative], filePath: CONFIG_DIR + relative };
    }
    if (channel === 'write-global-claude-file') {
      const [relative, content] = args as [string, string];
      files[relative] = content;
      return { success: true, filePath: CONFIG_DIR + relative };
    }
    if (channel === 'move-file') {
      const [from, to] = args as [string, string];
      const fromRelative = from.slice(CONFIG_DIR.length);
      const toRelative = to.slice(CONFIG_DIR.length);
      files[toRelative] = files[fromRelative];
      delete files[fromRelative];
      return { success: true };
    }
    return null;
  });
}

function calls(channel: string): unknown[][] {
  return mockInvoke.mock.calls.filter(([name]) => name === channel);
}

/** `$now.ToString('o')` with `Kind=Local`: local wall clock plus a UTC offset. */
function stamp(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const magnitude = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`
  );
}

function seedCache(overrides: Record<string, unknown> = {}, ageMs = 0) {
  const reading = {
    timestamp: stamp(new Date(Date.now() - ageMs)),
    fiveHour: 11,
    fiveHourReset: null,
    sevenDay: 3,
    sevenDayReset: null,
    scoped: [],
    allLimits: [],
    ...overrides,
  };
  files[CACHE_FILE] = JSON.stringify(reading);
  return reading;
}

function seedCredentials() {
  files[CREDENTIALS_FILE] = JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } });
}

function usagePayload(fiveHour: number) {
  return {
    five_hour: { utilization: fiveHour, resets_at: '2026-09-19T14:40:00+00:00' },
    seven_day: { utilization: 13, resets_at: '2026-09-25T09:00:00+00:00' },
    limits: [
      {
        group: 'weekly',
        percent: 42,
        resets_at: '2026-09-25T09:00:00+00:00',
        scope: { model: { display_name: 'Fable 5.1' } },
      },
    ],
  };
}

function respondOk(body: unknown) {
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

function respondStatus(status: number) {
  mockFetch.mockResolvedValue({ ok: false, status });
}

beforeEach(() => {
  files = {};
  // Only `Date` is faked: the client's 3s abort timer stays on real timers, so
  // advancing the clock to test the TTL and the floor cannot fire it.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-19T12:00:00'));
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { fetch: unknown }).fetch = mockFetch;
  mockInvoke.mockReset();
  mockFetch.mockReset();
  installBridge();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cache TTL', () => {
  it('serves a cache younger than 60s without calling the usage API', async () => {
    seedCredentials();
    const cached = seedCache({ fiveHour: 55 }, 59_000);

    const { fetchPlanUsage } = await loadClient();
    const usage = await fetchPlanUsage();

    // The panel and the CLI status line share this file precisely so that
    // whichever renders first pays for the call and the other does not.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(usage?.fiveHour).toBe(55);
    expect(usage?.timestamp).toBe(cached.timestamp);
  });

  it('calls the usage API once the cache passes 60s', async () => {
    seedCredentials();
    seedCache({ fiveHour: 55 }, 61_000);
    respondOk(usagePayload(63));

    const { fetchPlanUsage } = await loadClient();
    const usage = await fetchPlanUsage();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(usage?.fiveHour).toBe(63);
  });
});

describe('atomic cache write', () => {
  it('writes a temp file and renames it in, never the cache path directly', async () => {
    seedCredentials();
    respondOk(usagePayload(63));

    const { fetchPlanUsage } = await loadClient();
    await fetchPlanUsage();

    // Writing the cache path directly is the truncate-then-write that used to
    // leave the shared file at zero bytes for a concurrent reader.
    const writes = calls('write-global-claude-file');
    expect(writes).toHaveLength(1);
    const written = writes[0][1] as string;
    expect(written).not.toBe(CACHE_FILE);
    expect(written).toMatch(/^statusline-usage-cache\.json\.[^.]+\.tmp$/);

    const moves = calls('move-file');
    expect(moves).toHaveLength(1);
    expect(moves[0][1]).toBe(CONFIG_DIR + written);
    expect(moves[0][2]).toBe(CONFIG_DIR + CACHE_FILE);

    expect(JSON.parse(files[CACHE_FILE]).fiveHour).toBe(63);
    expect(Object.keys(files).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
  });

  it('reuses one temp name, so a failed rename leaves at most one stray', async () => {
    seedCredentials();
    respondOk(usagePayload(63));

    const { fetchPlanUsage } = await loadClient();
    await fetchPlanUsage();
    // Past the floor, and with no cache to serve, so the second call writes too.
    delete files[CACHE_FILE];
    vi.setSystemTime(Date.now() + 31_000);
    await fetchPlanUsage();

    const names = calls('write-global-claude-file').map(([, path]) => path);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe(names[1]);
  });

  it('stamps the cache in local time with a UTC offset, never a trailing Z', async () => {
    seedCredentials();
    respondOk(usagePayload(63));

    const { fetchPlanUsage } = await loadClient();
    await fetchPlanUsage();

    // The status line re-parses this field after ConvertFrom-Json has already
    // coerced it to [DateTime]. A `Z` reads back as a local wall clock, so the
    // age goes negative and the CLI serves the reading as fresh for hours.
    const timestamp = JSON.parse(files[CACHE_FILE]).timestamp as string;
    expect(timestamp).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(timestamp.endsWith('Z')).toBe(false);
  });
});

const UNREADABLE_CACHES: [string, string][] = [
  ['empty', ''],
  ['whitespace only', '   \n'],
  ['truncated mid-write', '{"timestamp":"2026-09-19T11:5'],
  ['valid JSON but not an object', '"nope"'],
  ['an object with no timestamp', '{"fiveHour":55}'],
  ['an unparseable timestamp', '{"timestamp":"not a date","fiveHour":55}'],
];

describe('unreadable cache', () => {
  it.each(UNREADABLE_CACHES)('treats a cache that is %s as absent and rebuilds it', async (_label, content) => {
    seedCredentials();
    files[CACHE_FILE] = content;
    respondOk(usagePayload(63));

    const { fetchPlanUsage } = await loadClient();
    const usage = await fetchPlanUsage();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(usage?.fiveHour).toBe(63);
    expect(JSON.parse(files[CACHE_FILE]).fiveHour).toBe(63);
  });

  it.each(UNREADABLE_CACHES)(
    'reports nothing rather than falling back to a cache that is %s',
    async (_label, content) => {
      seedCredentials();
      files[CACHE_FILE] = content;
      respondStatus(429);

      const { fetchPlanUsage } = await loadClient();
      const usage = await fetchPlanUsage();

      // This is the path where the timestamp check earns its keep. The panel
      // marks a reading stale by how old its timestamp is, so handing back a
      // reading without one would render whatever number survived the damage
      // as current usage. Nothing at all is the honest answer.
      expect(usage).toBeNull();
    },
  );

  it('reads a BOM-prefixed cache, as Windows PowerShell writes it', async () => {
    seedCredentials();
    seedCache({ fiveHour: 55 }, 10_000);
    // Set-Content -Encoding utf8 writes a BOM, and JSON.parse rejects one.
    files[CACHE_FILE] = `﻿${files[CACHE_FILE]}`;

    const { fetchPlanUsage } = await loadClient();
    const usage = await fetchPlanUsage();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(usage?.fiveHour).toBe(55);
  });

  it('reads a lone scoped entry that ConvertTo-Json unwrapped to an object', async () => {
    seedCredentials();
    seedCache({ scoped: { label: '7d Fable', pct: 42, reset: null } }, 10_000);

    const { fetchPlanUsage } = await loadClient();
    const usage = await fetchPlanUsage();

    expect(usage?.scoped).toEqual([{ label: '7d Fable', pct: 42, reset: null }]);
  });
});

describe('throttle', () => {
  it('shares one in-flight call between concurrent callers', async () => {
    seedCredentials();
    respondOk(usagePayload(63));

    const { fetchPlanUsage } = await loadClient();
    // Both issued before either can settle -- a render loop, or React 18's
    // double-mount in development.
    const [first, second] = await Promise.all([fetchPlanUsage(), fetchPlanUsage()]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(first?.fiveHour).toBe(63);
    expect(second).toEqual(first);
  });

  it('returns the previous reading inside the 30s floor', async () => {
    seedCredentials();
    respondOk(usagePayload(63));

    const { fetchPlanUsage } = await loadClient();
    const first = await fetchPlanUsage();

    // Drop the cache so only the floor can stop a second call: this proves the
    // throttle, not the TTL, is what is holding.
    delete files[CACHE_FILE];
    vi.setSystemTime(Date.now() + 29_000);
    const second = await fetchPlanUsage();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('calls again once the floor has passed', async () => {
    seedCredentials();
    respondOk(usagePayload(63));

    const { fetchPlanUsage } = await loadClient();
    await fetchPlanUsage();

    delete files[CACHE_FILE];
    vi.setSystemTime(Date.now() + 31_000);
    respondOk(usagePayload(70));
    const second = await fetchPlanUsage();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(second?.fiveHour).toBe(70);
  });
});

describe('staleness', () => {
  it('keeps the cached reading, and its timestamp, when the API answers 429', async () => {
    seedCredentials();
    const cached = seedCache({ fiveHour: 55 }, 10 * 60_000);
    respondStatus(429);

    const { fetchPlanUsage } = await loadClient();
    const usage = await fetchPlanUsage();

    // The endpoint rate-limits exactly when you are near a cap, so this is the
    // case that matters most. Holding the old timestamp is the whole mechanism:
    // it is what the panel reads to render the chip stale rather than current.
    expect(usage?.fiveHour).toBe(55);
    expect(usage?.timestamp).toBe(cached.timestamp);
    expect(calls('write-global-claude-file')).toHaveLength(0);
  });

  it('keeps the cached reading when the token has expired', async () => {
    seedCredentials();
    const cached = seedCache({ fiveHour: 55 }, 10 * 60_000);
    respondStatus(401);

    const { fetchPlanUsage } = await loadClient();
    const usage = await fetchPlanUsage();

    expect(usage?.timestamp).toBe(cached.timestamp);
  });

  it('keeps the cached reading when the request never completes', async () => {
    seedCredentials();
    const cached = seedCache({ fiveHour: 55 }, 10 * 60_000);
    mockFetch.mockRejectedValue(new Error('offline'));

    const { fetchPlanUsage } = await loadClient();
    const usage = await fetchPlanUsage();

    expect(usage?.timestamp).toBe(cached.timestamp);
  });

  it('keeps the cached reading when there is no OAuth token to read', async () => {
    const cached = seedCache({ fiveHour: 55 }, 10 * 60_000);

    const { fetchPlanUsage } = await loadClient();
    const usage = await fetchPlanUsage();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(usage?.timestamp).toBe(cached.timestamp);
  });

  it('falls back to the last reading rather than rejecting when the bridge throws', async () => {
    seedCredentials();
    respondOk(usagePayload(63));

    const { fetchPlanUsage } = await loadClient();
    const first = await fetchPlanUsage();

    // The panel polls with `void`, so a rejection here would be an unhandled
    // one and the chips would keep their value with no way to know.
    vi.setSystemTime(Date.now() + 31_000);
    mockInvoke.mockRejectedValue(new Error('bridge gone'));
    const second = await fetchPlanUsage();

    expect(second).toEqual(first);
  });
});
