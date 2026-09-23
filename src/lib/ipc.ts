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
 * Workspace state, as `workspace:get-state` hands it over.
 *
 * One read serves two questions -- which session is selected, and what the
 * permission mode is -- so the caller fetches it once and passes it to both
 * rather than spending two round trips on the same channel per refresh.
 */
export interface WorkspaceState {
  agenticCodingWindowState?: {
    selectedWorkstream?: { type?: string; id?: string } | null;
  } | null;
  workstreamStates?: Record<string, { activeChildId?: string | null } | undefined> | null;
  worktreeActiveSessions?: Record<string, string> | null;
  agentPermissions?: {
    permissionMode?: string | null;
    allowAllUsesClassifier?: boolean | null;
  };
  agentPermissionMode?: string | null;
}

export async function getWorkspaceState(workspacePath: string): Promise<WorkspaceState | null> {
  return invoke<WorkspaceState>('workspace:get-state', workspacePath);
}

/**
 * The session the sidebar has selected, read straight out of workspace state.
 *
 * GET-102: focus used to be approximated by "most recently updated in this
 * workspace", so switching sessions moved nothing until you prompted the new
 * one -- the strip kept describing the session that was still being written
 * to. The renderer keeps the truth in `activeSessionIdAtom`, which extensions
 * cannot read, but it does not keep it only there: `setSelectedWorkstreamAtom`
 * calls `persistSelectedWorkstream` on every selection change, which writes
 * `agenticCodingWindowState.selectedWorkstream` through
 * `workspace:update-state`. That is the selection itself rather than a proxy
 * for it, it is already scoped to this workspace, and it survives a restart --
 * so the session active at app start is the one the app restores.
 *
 * The ticket proposed ranking by `metadata.metadata.lastReadAt` instead. That
 * value is real, and is still the fallback below, but it is the weaker signal:
 * the tray's "clear all unread" stamps one identical `lastReadAt` onto every
 * unread session at once, and `sessions:sync-read-state` can import one from
 * another machine. Neither can disturb the persisted selection.
 *
 * A group selection names the group, so it is resolved down to the session
 * actually on screen: `worktreeActiveSessions` for a worktree, and
 * `workstreamStates[id].activeChildId` for a workstream. For an ordinary
 * single session `activeChildId` is that session's own id, so the same lookup
 * is harmless.
 */
export function selectedSessionId(state: WorkspaceState | null): string | null {
  const selection = state?.agenticCodingWindowState?.selectedWorkstream;
  const id = selection?.id;
  if (typeof id !== 'string' || !id) return null;

  if (selection?.type === 'worktree') {
    const active = state?.worktreeActiveSessions?.[id];
    if (typeof active === 'string' && active) return active;
  }

  const child = state?.workstreamStates?.[id]?.activeChildId;
  if (typeof child === 'string' && child) return child;

  return id;
}

/**
 * The session the panel describes.
 *
 * Prefers the selection above, falling back to the timestamp heuristic when
 * the workspace has no persisted selection yet or it names a workstream root
 * with no conversation in it.
 *
 * This used to prefer a raw `SELECT` against `ai_sessions` via the
 * `nimbalyst-database-read` catalog permission, with the IPC channels as a
 * fallback. Both are gone: the permission is risk tier HIGH, so every install
 * had to clear a consent prompt, and the SQL bound the panel to an internal
 * schema carrying no compatibility promise. GET-85 established that
 * `sessions:list` plus `sessions:get` answer the same question, so the fallback
 * is now the only path.
 */
export async function getFocusedSession(
  workspacePath: string,
  state: WorkspaceState | null = null,
): Promise<SessionRecord | null> {
  return listFocusedSession(workspacePath, selectedSessionId(state));
}

/**
 * How many list entries are worth resolving individually when the newest one
 * turns out to be a workstream root. Bounded because each costs a `sessions:get`
 * and the panel refreshes every five seconds.
 */
const MAX_CANDIDATES = 8;

/**
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
async function listFocusedSession(
  workspacePath: string,
  selectedId: string | null,
): Promise<SessionRecord | null> {
  const listed = await invoke<unknown>('sessions:list', workspacePath, { limit: 50 });
  const entries = normalizeSessionList(listed);
  if (entries.length === 0) return null;

  // The selection the app persisted, when it names something this workspace
  // still lists. A root the user selected before opening any of its children
  // has no conversation to describe, so it falls through to the ranking below
  // rather than blanking the strip.
  if (selectedId) {
    const entry = entries.find((candidate) => candidate.id === selectedId);
    if (entry) {
      const session = await resolveSession(entry);
      if (session && !(hasChildren(entry) && extractTokenUsage(session) === null)) {
        return session;
      }
    }
  }

  if (!hasChildren(entries[0])) return resolveSession(entries[0]);

  const resolved = (
    await Promise.all(entries.slice(0, MAX_CANDIDATES).map((entry) => resolveSession(entry)))
  ).filter((session): session is SessionRecord => session !== null);
  if (resolved.length === 0) return null;

  // Token usage is the only "has actually been talked to" signal that survives
  // IPC -- a workstream root that exists just to hold children has none.
  const conversed = resolved.filter((session) => extractTokenUsage(session) !== null);
  const pool = conversed.length > 0 ? conversed : resolved;

  return rankByFocus(pool);
}

/**
 * Pick the session most likely to be on screen, with no persisted selection to
 * go on.
 *
 * Sessions that have been read outrank ones that never have, rather than being
 * compared against them on a merged key: an unread session an agent is writing
 * to in the background carries a fresh `updatedAt`, and that is exactly the
 * session that must not take the strip away from the one being read. Only when
 * nothing has ever been read does `updatedAt` decide, which is the behaviour
 * this panel has always had.
 *
 * `updatedAt` still breaks ties, because the tray's "clear all unread" marks
 * every unread session with a single shared timestamp.
 */
function rankByFocus(pool: SessionRecord[]): SessionRecord | null {
  if (pool.length === 0) return null;

  const read = pool.filter((session) => extractLastReadAt(session) !== null);
  if (read.length > 0) {
    return read.reduce((best, session) =>
      compareRead(session, best) > 0 ? session : best,
    );
  }

  return pool.reduce((best, session) =>
    timestamp(session.updatedAt) > timestamp(best.updatedAt) ? session : best,
  );
}

function compareRead(a: SessionRecord, b: SessionRecord): number {
  const byRead = (extractLastReadAt(a) ?? 0) - (extractLastReadAt(b) ?? 0);
  if (byRead !== 0) return byRead;
  return timestamp(a.updatedAt) - timestamp(b.updatedAt);
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

/**
 * `invokeQuiet`, not `invoke`: this is polled every five seconds for as long as
 * the panel is open, and a host that cannot answer the channel at all rejects
 * every time -- a warning every five seconds, precisely in the situation the
 * user can do least about. The outcome is not lost, it just stops going to the
 * console: a missing reading now renders as the muted `5h -` / `7d -`
 * placeholder, whose tooltip says which link in the chain is missing.
 */
export async function getUsage(): Promise<ClaudeUsage | null> {
  return invokeQuiet<ClaudeUsage>('claude-usage:get');
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
export async function getPermissionMode(state: WorkspaceState | null): Promise<string | null> {
  // The real home of the value: workspace state -> agentPermissions.permissionMode.
  // (`agentPermissionMode` only exists as a flattened field in the settings
  // overview, not as a settings key.) The state itself is fetched once by the
  // caller and shared with `selectedSessionId`.
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

/**
 * When the session was last opened, in epoch ms.
 *
 * Written by `markSessionReadAtom` as `{ hasUnread: false, lastReadAt }`
 * through `ai:updateSessionMetadata`, which lands one level down in
 * `metadata.metadata` -- the same nesting `tokenUsage` has to be dug out of.
 * Note this moves on selection only; an agent writing into a background
 * session sets `hasUnread`, not this.
 */
export function extractLastReadAt(session: SessionRecord | null): number | null {
  if (!session) return null;

  const metadata = session.metadata as Record<string, unknown> | undefined;
  const candidates = [
    (metadata?.metadata as Record<string, unknown> | undefined)?.lastReadAt,
    metadata?.lastReadAt,
    (session as unknown as Record<string, unknown>).lastReadAt,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) return parsed;
    }
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
