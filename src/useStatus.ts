import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClaudeUsage,
  DataAccess,
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
  on,
  onWindowEvent,
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
 * Event subscriptions drive the refresh; the timer is the backstop for the
 * values nothing broadcasts (git branch, effort, permission mode).
 */
export function useStatus(workspacePath: string, data?: DataAccess): Status {
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

  // `data` arrives from the host and may be a fresh object on every render.
  // Holding it in a ref keeps it out of the effect dependency lists: an
  // identity change must not tear down the subscriptions.
  const dataRef = useRef(data);
  dataRef.current = data;

  const refresh = useCallback(async () => {
    // Still clear `loading` with no workspace, or the panel renders its
    // placeholder forever and the config chip stays unreachable.
    if (!workspacePath) {
      setStatus((previous) => ({ ...previous, loading: false }));
      return;
    }
    const current = ++generation.current;

    const [session, models, defaultEffort, permissionMode, git, usage] = await Promise.all([
      getFocusedSession(workspacePath, dataRef.current),
      getModels(),
      getDefaultEffortLevel(),
      getPermissionMode(workspacePath),
      getGitInfo(workspacePath),
      getUsage(),
    ]);

    if (current !== generation.current) return;

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
    void refreshPlanUsage();
    const timer = window.setInterval(() => void refreshPlanUsage(), PLAN_USAGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshPlanUsage]);

  return status;
}
