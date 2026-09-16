/**
 * Plan usage via the shared PowerShell helper.
 *
 * `claude-usage:get` only maps five_hour / seven_day / seven_day_opus, so the
 * API's `limits[]` array -- the model-scoped caps, e.g. a separate weekly Fable
 * limit -- never reaches the renderer. ~/.claude/get-plan-usage.ps1 is the same
 * code the CLI status line uses, so running it here keeps the two identical and
 * shares its 60-second cache file.
 *
 * `extension:exec` is gated on `permissions.filesystem`, which this extension
 * declares. cmd.exe expands %USERPROFILE% for us.
 */

export interface ScopedLimit {
  label: string;
  pct: number;
  reset: string | null;
}

export interface PlanUsage {
  timestamp?: string;
  fiveHour?: number | null;
  fiveHourReset?: string | null;
  sevenDay?: number | null;
  sevenDayReset?: string | null;
  scoped?: ScopedLimit[];
}

export interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (
  command: string,
  options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

const COMMAND =
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\\.claude\\get-plan-usage.ps1"';

/**
 * Spawn guard.
 *
 * Every call here starts a cmd.exe and a PowerShell -- roughly 2.5s and a real
 * slice of CPU. A caller that re-fires per render (an unstable effect
 * dependency, or a stale component left mounted by a hot reload) can therefore
 * saturate the machine. The panel should only ever ask once a minute, so this
 * enforces that invariant here rather than trusting every call site to hold it:
 *
 *  - one in-flight run at a time; concurrent callers share its promise
 *  - a floor between runs; inside it the previous answer is returned
 *
 * The helper self-caches for 60s anyway, so a suppressed call would not have
 * produced a fresher number -- only another process.
 */
const MIN_INTERVAL_MS = 30_000;
let inFlight: Promise<PlanUsage | null> | null = null;
let lastFinishedAt = 0;
let lastResult: PlanUsage | null = null;

export async function fetchPlanUsage(exec: ExecFn | undefined): Promise<PlanUsage | null> {
  if (!exec) return null;

  if (inFlight) return inFlight;
  if (Date.now() - lastFinishedAt < MIN_INTERVAL_MS) return lastResult;

  inFlight = runPlanUsage(exec).finally(() => {
    inFlight = null;
    lastFinishedAt = Date.now();
  });

  lastResult = await inFlight;
  return lastResult;
}

async function runPlanUsage(exec: ExecFn): Promise<PlanUsage | null> {
  try {
    const result = await exec(COMMAND, { timeout: 15_000 });
    if (!result?.success) {
      if (result?.stderr) console.warn('[status-panel] get-plan-usage failed:', result.stderr);
      return null;
    }

    const output = result.stdout.trim();
    if (!output || output === '{}') return null;

    const parsed = JSON.parse(output) as PlanUsage;
    if (!parsed || typeof parsed !== 'object') return null;

    return { ...parsed, scoped: normalizeScoped(parsed.scoped) };
  } catch (error) {
    console.warn('[status-panel] get-plan-usage parse failed:', error);
    return null;
  }
}

/** PowerShell may emit a lone scoped entry as an object rather than an array. */
function normalizeScoped(value: unknown): ScopedLimit[] {
  if (Array.isArray(value)) return value as ScopedLimit[];
  if (value && typeof value === 'object') return [value as ScopedLimit];
  return [];
}
