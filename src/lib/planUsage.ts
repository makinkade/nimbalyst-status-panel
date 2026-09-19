/**
 * Plan usage, read straight from the Anthropic OAuth usage endpoint.
 *
 * `claude-usage:get` only maps five_hour / seven_day / seven_day_opus, so the
 * API's `limits[]` array -- the model-scoped caps, e.g. a separate weekly Fable
 * limit -- never reaches the renderer. This module therefore does the whole job
 * itself: read the OAuth token out of the Claude credentials file, call the
 * endpoint, and shape the response exactly as `~/.claude/get-plan-usage.ps1`
 * did, so the panel and the CLI status line stay identical and keep sharing one
 * cache file.
 *
 * Nothing is spawned. The previous implementation ran that .ps1 through
 * `host.exec` with a command that hardcoded the `powershell` binary and
 * cmd-style `%USERPROFILE%` expansion -- Windows-only twice over. The host
 * resolves the Claude config directory for us (honouring `CLAUDE_CONFIG_DIR`),
 * so there is no path or shell left to make portable.
 *
 * `permissions.filesystem` is still required: it is what gates reading the
 * credentials file.
 */

import { invoke } from './ipc';

export interface ScopedLimit {
  label: string;
  pct: number;
  reset: string | null;
}

/**
 * Every entry in `limits[]`, including the ones `scoped` skips for having no
 * model scope. A cap can bind while the top-level five_hour/seven_day numbers
 * read lower, and without this there is no way to see that after the fact.
 */
export interface RawLimit {
  group: string | null;
  percent: number | null;
  model: string | null;
  resets: string | null;
}

export interface PlanUsage {
  timestamp?: string;
  fiveHour?: number | null;
  fiveHourReset?: string | null;
  sevenDay?: number | null;
  sevenDayReset?: string | null;
  scoped?: ScopedLimit[];
  allLimits?: RawLimit[];
}

// ── The usage endpoint ──────────────────────────────────────────────────────

interface UsageWindowResponse {
  utilization?: number | null;
  resets_at?: string | null;
}

interface LimitResponse {
  group?: string | null;
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

interface UsageResponse {
  five_hour?: UsageWindowResponse | null;
  seven_day?: UsageWindowResponse | null;
  limits?: LimitResponse[] | null;
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 3_000;

/** Both files live in the Claude config directory, which the host resolves. */
const CREDENTIALS_FILE = '.credentials.json';
const CACHE_FILE = 'statusline-usage-cache.json';

/** Shared with the CLI status line, so whichever renders first pays for the call. */
const CACHE_TTL_MS = 60_000;

/**
 * Call guard.
 *
 * Far cheaper than it was -- there is no process to spawn any more -- but still
 * the thing standing between a render loop and the usage API. A caller that
 * re-fires per render (an unstable effect dependency, or a stale component left
 * mounted by a hot reload) would otherwise hammer an endpoint that answers 429
 * exactly when you are near a cap. The panel should only ever ask once a
 * minute, so the invariant is enforced here rather than trusted to every call
 * site:
 *
 *  - one in-flight call at a time; concurrent callers share its promise
 *  - a floor between calls; inside it the previous answer is returned
 */
const MIN_INTERVAL_MS = 30_000;
let inFlight: Promise<PlanUsage | null> | null = null;
let lastFinishedAt = 0;
let lastResult: PlanUsage | null = null;

export async function fetchPlanUsage(): Promise<PlanUsage | null> {
  if (inFlight) return inFlight;
  if (Date.now() - lastFinishedAt < MIN_INTERVAL_MS) return lastResult;

  inFlight = runPlanUsage().finally(() => {
    inFlight = null;
    lastFinishedAt = Date.now();
  });

  lastResult = await inFlight;
  return lastResult;
}

/**
 * Cache, then network, then whatever is cached however old.
 *
 * Stale is better than nothing, and the caller can tell the difference: a
 * fallback keeps the cached `timestamp`, so a reading that stops advancing
 * renders as stale rather than passing for current.
 */
async function runPlanUsage(): Promise<PlanUsage | null> {
  const cached = await readCache();
  if (cached && Date.now() - readingTime(cached) < CACHE_TTL_MS) return cached;

  const token = await readAccessToken();
  if (!token) return cached;

  const usage = await requestUsage(token);
  if (!usage) return cached;

  await writeCache(usage);
  return usage;
}

async function requestUsage(token: string): Promise<PlanUsage | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      // 401 (token expired) and 429 (rate limited, which this endpoint does
      // precisely when you are near a cap) both land here. Neither deserves a
      // warning: the caller falls back to the cached reading, and the older
      // timestamp it carries is what makes the chips render as stale.
      console.debug(`[status-panel] usage API returned ${response.status}`);
      return null;
    }

    return shapeUsage((await response.json()) as UsageResponse);
  } catch (error) {
    // Offline, DNS, timeout. Degrade quietly to the cached reading.
    console.debug('[status-panel] usage fetch failed:', error);
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

function shapeUsage(response: UsageResponse): PlanUsage {
  const limits = toArray<LimitResponse>(response.limits);

  return {
    timestamp: localTimestamp(new Date()),
    fiveHour: response.five_hour?.utilization ?? null,
    fiveHourReset: response.five_hour?.resets_at ?? null,
    sevenDay: response.seven_day?.utilization ?? null,
    sevenDayReset: response.seven_day?.resets_at ?? null,
    scoped: scopedLimits(limits),
    allLimits: limits.map((limit) => ({
      group: limit.group ?? null,
      percent: limit.percent ?? null,
      model: limit.scope?.model?.display_name ?? null,
      resets: limit.resets_at ?? null,
    })),
  };
}

/**
 * Model-scoped limits (e.g. a separate weekly Fable cap) only appear in the
 * `limits` array, not in the top-level five_hour/seven_day fields.
 */
function scopedLimits(limits: LimitResponse[]): ScopedLimit[] {
  const scoped: ScopedLimit[] = [];

  for (const limit of limits) {
    const model = limit.scope?.model?.display_name;
    if (!model) continue;
    scoped.push({
      label: `${windowLabel(limit.group)} ${model}`,
      pct: limit.percent ?? 0,
      reset: limit.resets_at ?? null,
    });
  }

  return scoped;
}

function windowLabel(group: string | null | undefined): string {
  if (group === 'session') return '5h';
  if (group === 'weekly') return '7d';
  return group ?? '';
}

// ── Credentials ─────────────────────────────────────────────────────────────

/**
 * The OAuth token Claude Code stores after login.
 *
 * On macOS the host prefers the Keychain and only falls back to this file; the
 * renderer cannot reach the Keychain, so a Keychain-only login yields no token
 * here and the chips fall back to `claude-usage:get`. That matches what the
 * .ps1 did (file only) rather than regressing it, but it is the first thing to
 * look at if the macOS install test comes back with empty scoped caps.
 */
async function readAccessToken(): Promise<string | null> {
  const file = await readClaudeFile(CREDENTIALS_FILE);
  if (!file) return null;

  try {
    const parsed = JSON.parse(file.content.trim()) as { claudeAiOauth?: { accessToken?: string } };
    const token = parsed?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

// ── The shared cache file ───────────────────────────────────────────────────

/**
 * A zero-byte or half-written cache is not a cache.
 *
 * The writers truncate before writing, so a reader can catch a competing one
 * mid-write -- which is how this file used to come back empty. Anything that
 * does not parse into an object with a readable timestamp is treated as absent,
 * and the fetch rebuilds it.
 */
async function readCache(): Promise<PlanUsage | null> {
  const file = await readClaudeFile(CACHE_FILE);
  if (!file) return null;

  // The trim is load-bearing, not tidiness: Windows PowerShell's
  // `Set-Content -Encoding utf8` writes a UTF-8 BOM, and `JSON.parse` rejects
  // one outright. Without this every .ps1-written cache reads as absent and the
  // panel fetches on every tick.
  const raw = file.content.trim();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const usage = parsed as PlanUsage;
  if (!Number.isFinite(readingTime(usage))) return null;

  return {
    ...usage,
    scoped: toArray<ScopedLimit>(usage.scoped),
    allLimits: toArray<RawLimit>(usage.allLimits),
  };
}

/**
 * Distinguishes this renderer's temp file from any other writer's.
 *
 * Stable for the life of the renderer rather than per write: a rename that
 * fails leaves the temp file behind, and a stable name means at most one stray
 * rather than one a minute.
 */
const WRITER_ID = Math.random().toString(36).slice(2, 10);

/**
 * Write to a temp file, then rename it in.
 *
 * A reader -- the CLI status line, or another Nimbalyst window -- sees either
 * the old file or the new one, never a truncated one.
 * `write-global-claude-file` is a plain `writeFileSync`, so writing the cache
 * path directly would be exactly the truncate-then-write that used to leave it
 * at zero bytes. `move-file` is `fs.rename`; it broadcasts `file-moved`, which
 * the app only acts on for paths that are open editor tabs, so a temp file in
 * the Claude config directory is inert.
 */
async function writeCache(usage: PlanUsage): Promise<void> {
  const suffix = `.${WRITER_ID}.tmp`;
  const written = await invoke<GlobalFileResult>(
    'write-global-claude-file',
    `${CACHE_FILE}${suffix}`,
    JSON.stringify(usage),
  );

  // The absolute temp path is the only handle we get on the Claude config
  // directory; the cache sits beside it, so strip the suffix rather than
  // guessing a path separator.
  const tempPath = written?.success ? written.filePath : undefined;
  if (!tempPath || !tempPath.endsWith(suffix)) return;

  await invoke('move-file', tempPath, tempPath.slice(0, -suffix.length));
}

interface GlobalFileResult {
  success?: boolean;
  content?: string;
  filePath?: string;
  error?: string;
}

/**
 * Read a file from the Claude config directory.
 *
 * The host resolves that directory itself, honouring `CLAUDE_CONFIG_DIR` --
 * which is what makes this work off Windows, where the old exec command baked
 * in `%USERPROFILE%\.claude`. A missing file comes back as `success: false`
 * rather than throwing, so no credentials is silently no usage.
 */
async function readClaudeFile(
  relativePath: string,
): Promise<{ content: string; filePath: string } | null> {
  const result = await invoke<GlobalFileResult>('read-global-claude-file', relativePath);
  if (!result?.success) return null;
  if (typeof result.content !== 'string' || !result.filePath) return null;
  return { content: result.content, filePath: result.filePath };
}

/**
 * Local time with a UTC offset, e.g. `2026-09-18T17:56:57.983-04:00` -- the
 * shape `$now.ToString('o')` produces, deliberately not `toISOString()`.
 *
 * The status line ages the shared cache with
 * `(Get-Date) - [DateTime]::Parse($cache.timestamp)`, and `ConvertFrom-Json`
 * has already coerced that field into a `[DateTime]` by then. A trailing `Z`
 * yields `Kind=Utc`, which that re-parse reads back as a local wall clock -- so
 * a UTC timestamp looks hours into the future, the age goes negative, `-lt 60`
 * holds, and the CLI serves the reading as fresh until local time catches up.
 * An offset yields `Kind=Local` and ages correctly. Same instant either way;
 * only this spelling survives the other reader.
 */
function localTimestamp(date: Date): string {
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

/** When the reading was actually taken; `NaN` if the cache cannot say. */
function readingTime(usage: PlanUsage): number {
  return usage.timestamp ? Date.parse(usage.timestamp) : NaN;
}

/**
 * A cache written by the .ps1 may hold a lone `scoped` or `allLimits` entry as
 * an object rather than an array -- `ConvertTo-Json` unwraps single-element
 * arrays. The file is shared, so that shape still has to be read.
 */
function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') return [value as T];
  return [];
}
