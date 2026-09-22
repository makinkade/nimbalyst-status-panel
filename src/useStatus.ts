import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClaudeUsage,
  GitInfo,
  ModelInfo,
  SessionRecord,
  EffortSource,
  getDefaultEffortLevel,
  resolveEffortLevel,
  getFocusedSession,
  getGitInfo,
  getModels,
  getPermissionMode,
  getUsage,
  getWorkspaceState,
  on,
  onWindowEvent,
  selectedSessionId,
} from './lib/ipc';
import { PlanUsage, fetchPlanUsage } from './lib/planUsage';

export interface Status {
  session: SessionRecord | null;
  model: ModelInfo | null;
  effort: string | null;
  effortSource: EffortSource | null;
  permissionMode: string | null;
  git: GitInfo;
  /** Preferred: full parity with the CLI status line, including scoped caps. */
  planUsage: PlanUsage | null;
  /** Fallback when there is no token, or the usage endpoint will not answer. */
  usage: ClaudeUsage | null;
  loading: boolean;
}

const EMPTY_GIT: GitInfo = { repoPath: null, branch: null, dirtyCount: 0 };
const POLL_MS = 5_000;
/** The cache shared with the CLI status line has a 60 s TTL; asking faster buys nothing. */
const PLAN_USAGE_POLL_MS = 60_000;
/**
 * How often to check *only* which session is selected.
 *
 * Switching sessions in the sidebar announces itself to nobody: it dispatches
 * no DOM event, and the `workspace:update-state` that records it sends renderer
 * windows nothing (there is no `workspace:state-changed` channel at all). So a
 * switch can only be noticed by asking, and on the 5 s refresh alone the strip
 * trailed the switch by up to five seconds.
 *
 * Asking this often is affordable only because the question is cheap in
 * isolation: one `workspace:get-state`, which the main process answers from an
 * in-memory object. A full refresh is not -- it lists sessions, resolves up to
 * eight of them, and shells out to git three times -- so the two are on
 * separate timers, and the cheap one triggers the expensive one only when the
 * selection has actually moved.
 */
const SELECTION_POLL_MS = 1_000;

/**
 * Whether an observed selection means the strip is now describing the wrong
 * session.
 *
 * The three-way state is the whole of it. `acted` is `undefined` until the
 * first full refresh lands, and that is not a change -- treating it as one
 * fires a redundant refresh on mount, racing the one already in flight.
 * `null` is a real observation (nothing is selected in this workspace) and has
 * to compare as a value, which is why this cannot be a truthiness check.
 */
export function shouldRefreshForSelection(
  observed: string | null,
  acted: string | null | undefined,
): boolean {
  if (acted === undefined) return false;
  return observed !== acted;
}

/**
 * Event subscriptions drive the refresh; the timer is the backstop for the
 * values nothing broadcasts (git branch, effort, permission mode), and a
 * second, faster timer watches the one value that changes in response to the
 * user rather than to work happening.
 */
export function useStatus(workspacePath: string): Status {
  const [status, setStatus] = useState<Status>({
    session: null,
    model: null,
    effort: null,
    effortSource: null,
    permissionMode: null,
    git: EMPTY_GIT,
    planUsage: null,
    usage: null,
    loading: true,
  });

  // Guards against a slow response from a previous workspace landing after a
  // faster one for the current workspace.
  const generation = useRef(0);

  // The selection the last full refresh acted on. `undefined` means no refresh
  // has landed yet, which is distinct from "nothing is selected" (null) and
  // must not be read as a change.
  const selection = useRef<string | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    // Still clear `loading` with no workspace, or the panel renders its
    // placeholder forever and the config chip stays unreachable.
    if (!workspacePath) {
      setStatus((previous) => ({ ...previous, loading: false }));
      return;
    }
    const current = ++generation.current;

    // One `workspace:get-state` answers both which session is selected and
    // what the permission mode is. Chaining the two consumers off the same
    // promise keeps every fetch below in flight together.
    const workspaceState = getWorkspaceState(workspacePath);

    const [session, models, defaultEffort, permissionMode, git, usage] = await Promise.all([
      workspaceState.then((state) => getFocusedSession(workspacePath, state)),
      getModels(),
      getDefaultEffortLevel(),
      workspaceState.then((state) => getPermissionMode(state)),
      getGitInfo(workspacePath),
      getUsage(),
    ]);

    if (current !== generation.current) return;

    // Already resolved; this just names what the refresh settled on.
    selection.current = selectedSessionId(await workspaceState);

    // Resolved after the fetch because the session's own level takes
    // precedence over the app default.
    const { level: effort, source: effortSource } = resolveEffortLevel(session, defaultEffort);

    const model = session?.model
      ? models.find((entry) => entry.id === session.model) ?? null
      : null;

    setStatus((previous) => ({
      ...previous,
      session,
      model,
      effort,
      effortSource,
      permissionMode,
      git,
      usage,
      loading: false,
    }));
  }, [workspacePath]);

  const refreshPlanUsage = useCallback(async () => {
    const planUsage = await fetchPlanUsage();
    if (planUsage) setStatus((previous) => ({ ...previous, planUsage }));
  }, []);

  useEffect(() => {
    // The remembered selection belongs to the previous workspace.
    selection.current = undefined;
    void refresh();

    const unsubscribers = [
      on('sessions:session-updated', () => void refresh()),
      on('sessions:session-created', () => void refresh()),
      on('sessions:refresh-list', () => void refresh()),
      on('claude-usage:update', () => void refresh()),
      onWindowEvent('open-ai-session', () => void refresh()),
    ];

    const timer = window.setInterval(() => void refresh(), POLL_MS);

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      window.clearInterval(timer);
    };
  }, [refresh, workspacePath]);

  useEffect(() => {
    if (!workspacePath) return;

    // A switch is the one change worth catching quickly, and it is the one
    // change nothing reports. Claim the new id before the refresh is awaited so
    // the next tick does not fire a second one for the same switch.
    const timer = window.setInterval(() => {
      void (async () => {
        const selected = selectedSessionId(await getWorkspaceState(workspacePath));
        if (!shouldRefreshForSelection(selected, selection.current)) return;
        selection.current = selected;
        void refresh();
      })();
    }, SELECTION_POLL_MS);

    return () => window.clearInterval(timer);
  }, [refresh, workspacePath]);

  useEffect(() => {
    void refreshPlanUsage();
    const timer = window.setInterval(() => void refreshPlanUsage(), PLAN_USAGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshPlanUsage]);

  return status;
}
