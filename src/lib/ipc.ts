/**
 * Thin wrapper over the renderer bridge that panels run alongside.
 *
 * Panels execute in Nimbalyst's renderer, so `window.electronAPI` is the same
 * bridge the app's own components use -- the bundled Git panel reaches for it
 * the same way. Every call here is defensive: a channel that changes shape
 * between releases should degrade to a missing chip, never a broken panel.
 */

interface ElectronBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
}

function bridge(): ElectronBridge | null {
  const api = (window as unknown as { electronAPI?: ElectronBridge }).electronAPI;
  return api ?? null;
}

export async function invoke<T>(channel: string, ...args: unknown[]): Promise<T | null> {
  return request<T>(channel, args, 'warn');
}

/**
 * The same call, logged at debug.
 *
 * For callers that poll and already treat "no answer" as an ordinary outcome.
 * The plan usage client asks for two files a minute and falls back to its
 * cached reading when either is unreachable, so warning on each would turn an
 * unavailable reading into a console entry a minute. The failure still has to
 * be findable -- it just should not announce itself.
 */
export async function invokeQuiet<T>(channel: string, ...args: unknown[]): Promise<T | null> {
  return request<T>(channel, args, 'debug');
}

async function request<T>(
  channel: string,
  args: unknown[],
  level: 'warn' | 'debug',
): Promise<T | null> {
  const api = bridge();
  if (!api) return null;
  try {
    return (await api.invoke(channel, ...args)) as T;
  } catch (error) {
    console[level](`[status-panel] ${channel} failed:`, error);
    return null;
  }
}

export function on(channel: string, callback: (...args: unknown[]) => void): () => void {
  const api = bridge();
  if (!api) return () => {};
  try {
    return api.on(channel, callback);
  } catch {
    return () => {};
  }
}

/** Subscribe to a DOM CustomEvent the app dispatches on the window. */
export function onWindowEvent(name: string, callback: () => void): () => void {
  window.addEventListener(name, callback);
  return () => window.removeEventListener(name, callback);
}

// ── Domain types ────────────────────────────────────────────────────────────

/**
 * Shape confirmed against `ai_sessions.metadata`.
 *
 * `totalTokens` is cumulative billed input+output for the session; the context
 * bar must use `currentContext.tokens`, which is what actually occupies the
 * window right now. The two diverge widely -- 107K billed against 274K resident
 * in a live session.
 */
export interface TokenUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
  currentContext?: {
    tokens?: number;
    contextWindow?: number;
  };
}

export interface SessionRecord {
  id: string;
  title?: string;
  model?: string;
  provider?: string;
  updatedAt?: string | number;
  metadata?: {
    tokenUsage?: TokenUsage;
    effortLevel?: string;
    phase?: string;
    [key: string]: unknown;
  };
}

export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

export interface ClaudeUsage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  lastUpdated?: number;
  error?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
}

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * The session the panel describes.
 *
 * Nimbalyst keeps the focused session in a renderer atom that extensions cannot
 * read, so "focused" is approximated by "most recently updated in this
 * workspace" -- the session you are talking to is the one being written to.
 * Re-queried whenever the app broadcasts a session update.
 */
export interface DataAccess {
  query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}

/** SQLite string literal: the only escaping needed is doubling single quotes. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function getFocusedSession(
  workspacePath: string,
  data?: DataAccess,
): Promise<SessionRecord | null> {
  const fromDatabase = await queryFocusedSession(workspacePath, data);
  if (fromDatabase) return fromDatabase;
  return listFocusedSession(workspacePath);
}

/**
 * Preferred path: ask the database directly.
 *
 * `sessions:list` does not return a flat newest-first list of conversations --
 * it surfaced a workstream root with zero messages as "newest" -- and its
 * entries carry no metadata, so token usage was unreachable. One query settles
 * both: the most recently updated session in this workspace that actually has
 * messages, metadata included.
 *
 * Parameters are inlined because the placeholder dialect differs across the
 * app's stores; the only interpolated value is a local workspace path.
 */
async function queryFocusedSession(
  workspacePath: string,
  data?: DataAccess,
): Promise<SessionRecord | null> {
  if (!data?.query) return null;

  const sql = `
    SELECT s.id, s.title, s.model, s.provider, s.metadata, s.updated_at
    FROM ai_sessions s
    WHERE s.workspace_id = ${quote(workspacePath)}
      AND EXISTS (SELECT 1 FROM ai_agent_messages m WHERE m.session_id = s.id)
    ORDER BY s.updated_at DESC
    LIMIT 1`;

  try {
    const rows = await data.query(sql);
    const row = rows?.[0];
    if (!row) return null;

    return {
      id: String(row.id),
      title: row.title as string | undefined,
      model: row.model as string | undefined,
      provider: row.provider as string | undefined,
      updatedAt: row.updated_at as string | undefined,
      metadata: parseMetadata(row.metadata as string | undefined),
    };
  } catch (error) {
    console.warn('[status-panel] session query failed, falling back to sessions:list:', error);
    return null;
  }
}

/**
 * How many list entries are worth resolving individually when the newest one
 * turns out to be a workstream root. Bounded because each costs a `sessions:get`
 * and the panel refreshes every five seconds.
 */
const MAX_CANDIDATES = 8;

/**
 * Fallback when database access is unavailable.
 *
 * `sessions:list` is a poor oracle on its own, in two ways that both have to be
 * worked around here:
 *
 * - `messageCount` is **always 0**. The store's list query does not join the
 *   messages table ("Not computed in list query for performance"), and the
 *   handler's projection passes that zero straight through. Screening on it
 *   therefore discards every session rather than just the empty ones.
 * - `updatedAt` is not the session's own. The list orders by
 *   `GREATEST(s.updated_at, MAX(child.updated_at))` and reports that same
 *   bubbled value, so a workstream root floats to the top on its children's
 *   activity -- which is exactly how a root with no conversation in it came to
 *   look like the newest session.
 *
 * `sessions:get` has neither problem: it returns the row itself, so `updatedAt`
 * is the session's own and `metadata` is the parsed object holding `tokenUsage`.
 * So the list is used only to enumerate candidates, and the pick is made from
 * full records.
 *
 * A leaf's bubbled timestamp equals its own, so when the newest entry has no
 * children nothing can have overtaken it and one `sessions:get` settles it.
 * Only when a parent is in front do we resolve the rest.
 */
async function listFocusedSession(workspacePath: string): Promise<SessionRecord | null> {
  const listed = await invoke<unknown>('sessions:list', workspacePath, { limit: 50 });
  const entries = normalizeSessionList(listed);
  if (entries.length === 0) return null;

  if (!hasChildren(entries[0])) return resolveSession(entries[0]);

  const resolved = (
    await Promise.all(entries.slice(0, MAX_CANDIDATES).map((entry) => resolveSession(entry)))
  ).filter((session): session is SessionRecord => session !== null);
  if (resolved.length === 0) return null;

  // Token usage is the only "has actually been talked to" signal that survives
  // IPC -- a workstream root that exists just to hold children has none.
  const conversed = resolved.filter((session) => extractTokenUsage(session) !== null);
  const pool = conversed.length > 0 ? conversed : resolved;

  return pool.reduce((best, session) =>
    timestamp(session.updatedAt) > timestamp(best.updatedAt) ? session : best,
  );
}

/** List entries report a real `childCount`, unlike `messageCount`. */
function hasChildren(entry: SessionRecord): boolean {
  const count = (entry as unknown as { childCount?: number }).childCount;
  return typeof count === 'number' && count > 0;
}

/** Trade a list entry for the full record, keeping the entry if the call fails. */
async function resolveSession(entry: SessionRecord): Promise<SessionRecord | null> {
  const full = await invoke<{ success?: boolean; session?: SessionRecord }>(
    'sessions:get',
    entry.id,
  );
  const session = full?.session ?? entry;
  return { ...session, metadata: parseMetadata(session.metadata) };
}

/** `ai_sessions.metadata` is stored as JSON text; IPC may hand it back either way. */
function parseMetadata(
  value: SessionRecord['metadata'] | string | undefined,
): SessionRecord['metadata'] {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as SessionRecord['metadata'];
  } catch {
    return undefined;
  }
}

function normalizeSessionList(value: unknown): SessionRecord[] {
  if (Array.isArray(value)) return value as SessionRecord[];
  if (value && typeof value === 'object') {
    const record = value as { sessions?: unknown; entries?: unknown };
    if (Array.isArray(record.sessions)) return record.sessions as SessionRecord[];
    if (Array.isArray(record.entries)) return record.entries as SessionRecord[];
  }
  return [];
}

function timestamp(value: string | number | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export async function getModels(): Promise<ModelInfo[]> {
  const result = await invoke<unknown>('ai:getModels');
  if (Array.isArray(result)) return result as ModelInfo[];
  if (result && typeof result === 'object') {
    // Keyed by provider: { "claude-code": ModelInfo[], ... }
    return Object.values(result as Record<string, unknown>)
      .filter(Array.isArray)
      .flat() as ModelInfo[];
  }
  return [];
}

export async function getUsage(): Promise<ClaudeUsage | null> {
  return invoke<ClaudeUsage>('claude-usage:get');
}

/**
 * Workspace permission mode. `bypass-all` / `allow-all` / `ask`, which is the
 * setting Nimbalyst actually applies -- deliberately not the per-session
 * Shift+Tab mode the CLI status line reads out of the transcript.
 *
 * There is no stored `auto` value; auto mode is a combination. Nimbalyst keeps
 * `agentPermissions: { permissionMode, allowAllUsesClassifier }`, and
 * `bypass-all` with the classifier ON launches Claude Code in auto mode -- the
 * classifier screens every tool call. Reading `permissionMode` alone therefore
 * reports "Bypass" for a workspace that is really in Auto. `bypass-all` with
 * the classifier off is genuine bypass and stays "Bypass".
 */
export async function getPermissionMode(workspacePath: string): Promise<string | null> {
  // The real home of the value: workspace state -> agentPermissions.permissionMode.
  // (`agentPermissionMode` only exists as a flattened field in the settings
  // overview, not as a settings key.)
  const state = await invoke<{
    agentPermissions?: {
      permissionMode?: string | null;
      allowAllUsesClassifier?: boolean | null;
    };
    agentPermissionMode?: string | null;
  }>('workspace:get-state', workspacePath);

  const mode = state?.agentPermissions?.permissionMode ?? state?.agentPermissionMode;
  if (typeof mode === 'string' && mode) {
    if (mode === 'bypass-all' && state?.agentPermissions?.allowAllUsesClassifier === true) {
      return 'auto';
    }
    return mode;
  }

  const fallback = await invoke<string>('app-settings:get', 'agentPermissionMode');
  return typeof fallback === 'string' && fallback ? fallback : null;
}

/**
 * Pull token usage out of a session however the IPC layer hands it over: the
 * metadata column is JSON text containing a nested `metadata` key of its own,
 * and different call sites flatten it differently.
 */
export function extractTokenUsage(session: SessionRecord | null): TokenUsage | null {
  if (!session) return null;

  const metadata = session.metadata as Record<string, unknown> | undefined;
  const candidates = [
    metadata?.tokenUsage,
    (session as unknown as Record<string, unknown>).tokenUsage,
    (metadata?.metadata as Record<string, unknown> | undefined)?.tokenUsage,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') return candidate as TokenUsage;
  }
  return null;
}

/** Mirrors the host's DEFAULT_EFFORT_LEVEL. */
const DEFAULT_EFFORT_LEVEL = 'high';

/**
 * The app default, which is only set once the user has picked one.
 *
 * `getDefaultEffortLevel()` returns `undefined` when `defaultEffortLevel` was
 * never written to the app store, so an untouched install yields nothing here
 * and the session value below is what actually matters.
 *
 * Note this deliberately does not consult `ai:getEffectiveSettings`: that
 * channel answers `{ success, settings }` -- so the payload is a level deeper
 * than it looks -- and `settings` carries provider/API-key configuration with
 * no effort field at all.
 */
export async function getDefaultEffortLevel(): Promise<string | null> {
  const value = await invoke<string>('settings:get-default-effort-level');
  return typeof value === 'string' && value ? value : null;
}

/**
 * Effort for the session, resolved the way the host's `resolveEffortLevel`
 * does it: the session's own level wins, then the app default, then `high`.
 */
export type EffortSource = 'session' | 'app-default' | 'builtin';

export interface ResolvedEffort {
  level: string;
  source: EffortSource;
}

export function resolveEffortLevel(
  session: SessionRecord | null,
  appDefault: string | null,
): ResolvedEffort {
  const fromSession = session?.metadata?.effortLevel;
  if (typeof fromSession === 'string' && fromSession) {
    return { level: fromSession, source: 'session' };
  }
  if (appDefault) return { level: appDefault, source: 'app-default' };
  return { level: DEFAULT_EFFORT_LEVEL, source: 'builtin' };
}

export interface GitInfo {
  repoPath: string | null;
  branch: string | null;
  dirtyCount: number;
}

export async function getGitInfo(workspacePath: string): Promise<GitInfo> {
  const isRepo = await invoke<boolean>('git:is-repo', workspacePath);
  if (!isRepo) return { repoPath: null, branch: null, dirtyCount: 0 };

  const branches = await invoke<{ current?: string }>('git:branches', workspacePath);
  const uncommitted = await invoke<unknown>('git:get-uncommitted-files', workspacePath);

  return {
    repoPath: workspacePath,
    branch: branches?.current || null,
    dirtyCount: countFiles(uncommitted),
  };
}

function countFiles(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value instanceof Set) return value.size;
  if (value && typeof value === 'object') {
    const record = value as { files?: unknown };
    if (Array.isArray(record.files)) return record.files.length;
  }
  return 0;
}
