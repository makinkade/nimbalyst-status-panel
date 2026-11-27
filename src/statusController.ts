import {
  getDefaultEffortLevel, getFocusedSession, getGitInfo, getModels, getWorkspacePolicy,
  getWorkspaceState, on, onWindowEvent, selectedSessionId,
  type GitInfo, type WorkspaceState,
} from './lib/ipc';
import { AccountMonitor } from './lib/accountMonitor';
import { AccountUsageCache } from './lib/accountUsageCache';
import { adapterFor, normalizeSessionStatus, providerRegistry, type AccountAdapter } from './lib/providerAdapters';
import { providerIdentity } from './lib/provider';
import { claudeAccountAdapter } from './lib/providers/claude';
import { ageReading, measured, missing, type Reading, type AccountUsage, type StatusModel } from './lib/statusModel';

export interface Status {
  workspacePath: string;
  readings: StatusModel;
  git: GitInfo;
  loading: boolean;
  /** Restored session facts are visible while the selected session refreshes. */
  cached?: boolean;
}

const EMPTY_GIT: GitInfo = { isRepo: null, repoPath: null, branch: null, dirtyCount: null };
export const SELECTION_POLL_MS = 1_000;
export const STATUS_POLL_MS = 5_000;
export const SESSION_SNAPSHOT_LIMIT = 50;

function cachedReading<T>(reading: Reading<T>): Reading<T> {
  return reading.value === null ? reading : { ...reading, state: 'stale', value: reading.value, cached: true,
    reason: reading.cached ? reading.reason : `Showing cached data for this session while refreshing.${reading.reason ? ` ${reading.reason}` : ''}` };
}

export function emptyStatus(workspacePath: string): Status {
  return { workspacePath, git: EMPTY_GIT, loading: !!workspacePath,
    readings: normalizeSessionStatus({ workspacePath, session: null, models: [],
      defaultEffort: null, permissionMode: null }) };
}

export function shouldRefreshForSelection(observed: string | null, acted: string | null | undefined): boolean {
  return acted !== undefined && observed !== acted;
}

const defaults = { getWorkspaceState, getFocusedSession, getGitInfo, getModels,
  getDefaultEffortLevel, getWorkspacePolicy, on, onWindowEvent,
  registry: providerRegistry, relatedAccounts: [claudeAccountAdapter] as AccountAdapter[] };
export type StatusDependencies = typeof defaults;

/**
 * GET-223: the hook delegates its actual timers, subscriptions and async state
 * transitions here so lifecycle tests exercise production orchestration. The
 * selection poll only reads memory; full refresh retains its 5 s git budget.
 */
export class StatusController {
  private active = false;
  private generation = 0;
  private selection: string | null | undefined;
  private observation = 0;
  private acceptedObservation = 0;
  private inFlight: Promise<void> | undefined;
  private resolvedKey: string | null = null;
  private served = new Map<string, Reading<string>>();
  private cache = new AccountUsageCache();
  private monitors = new Map<string, AccountMonitor>();
  private accounts = new Map<string, Reading<AccountUsage>>();
  private accountGeneration = -1;
  private snapshots = new Map<string, { key: string; status: Status; accounts: Map<string, Reading<AccountUsage>> }>();
  private invalidationWatchers = new Map<string, () => void>();
  private unsubscribers: (() => void)[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private state: Status;
  private deps: StatusDependencies;

  constructor(private workspacePath: string, private publish: (status: Status) => void,
    deps: Partial<StatusDependencies> = {}) {
    this.deps = { ...defaults, ...deps };
    this.state = emptyStatus(workspacePath);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.emit(this.state);
    if (!this.workspacePath) return;
    this.unsubscribers = [
      ...['sessions:session-updated', 'sessions:session-created', 'sessions:refresh-list']
        .map((channel) => this.deps.on(channel, () => void this.refresh())),
      this.deps.onWindowEvent('open-ai-session', () => void this.refresh()),
    ];
    this.timers = [
      setInterval(() => void this.refresh(), STATUS_POLL_MS),
      setInterval(() => void this.pollSelection(), SELECTION_POLL_MS),
    ];
    void this.refresh();
  }

  private emit(state: Status): void {
    if (!this.active) return;
    this.state = state;
    const id = state.readings.session?.id;
    if (id && this.resolvedKey && !state.cached) {
      this.snapshots.delete(id);
      this.snapshots.set(id, { key: this.resolvedKey, status: state, accounts: new Map(this.accounts) });
      if (this.snapshots.size > SESSION_SNAPSHOT_LIMIT) this.snapshots.delete(this.snapshots.keys().next().value!);
    }
    this.publish(state);
  }

  /** Ignore a slow older workspace read after a later observation has landed. */
  private async readWorkspace(): Promise<{ state: WorkspaceState | null } | null> {
    const request = ++this.observation;
    let state: WorkspaceState | null;
    try { state = await this.deps.getWorkspaceState(this.workspacePath); }
    catch { state = null; }
    if (!this.active || request < this.acceptedObservation) return null;
    this.acceptedObservation = request;
    return { state };
  }

  private observe(state: WorkspaceState | null): boolean {
    const selected = selectedSessionId(state);
    const first = this.selection === undefined;
    const changed = shouldRefreshForSelection(selected, this.selection);
    this.selection = selected;
    if (changed) this.boundary(selected);
    return first || changed;
  }

  /** Never show the session being left. A returning selection may show only its
   * own explicitly cached snapshot until fresh facts arrive (GET-227). */
  private boundary(restoreId: string | null = null): void {
    this.generation += 1;
    this.inFlight = undefined;
    this.resolvedKey = null;
    for (const monitor of this.monitors.values()) monitor.stop();
    this.cache.clear();
    this.accounts.clear();
    this.accountGeneration = -1;
    const snapshot = restoreId ? this.snapshots.get(restoreId) : undefined;
    if (snapshot) {
      this.resolvedKey = snapshot.key;
      const readings = { ...snapshot.status.readings };
      for (const key of ['model', 'servedModel', 'effort', 'workspacePolicy', 'execution', 'context', 'tokens'] as const) {
        Object.assign(readings, { [key]: cachedReading<unknown>(readings[key]) });
      }
      for (const [id, reading] of snapshot.accounts) this.accounts.set(id, cachedReading(reading));
      readings.accounts = [...this.accounts.values()];
      this.emit({ ...snapshot.status, git: this.state.git, readings, cached: true, loading: false });
    } else this.emit({ ...emptyStatus(this.workspacePath), git: this.state.git, loading: false });
  }

  async pollSelection(): Promise<void> {
    const read = await this.readWorkspace();
    if (read && this.observe(read.state)) await this.refreshFromState(read.state);
  }

  async refresh(): Promise<void> {
    if (!this.active || !this.workspacePath) return;
    const read = await this.readWorkspace();
    if (!read) return;
    this.observe(read.state);
    await this.refreshFromState(read.state);
  }

  private refreshFromState(workspace: WorkspaceState | null): Promise<void> {
    if (this.inFlight) return this.inFlight;
    let generation = this.generation;
    const valid = () => this.active && generation === this.generation;
    let work!: Promise<void>;
    work = (async () => {
      const [session, models, defaultEffort, policy, git] = await Promise.all([
        this.deps.getFocusedSession(this.workspacePath, workspace), this.deps.getModels(),
        this.deps.getDefaultEffortLevel(), this.deps.getWorkspacePolicy(workspace),
        this.deps.getGitInfo(this.workspacePath),
      ]);
      if (!valid()) return;
      const identity = providerIdentity(session, models);
      const adapter = adapterFor(identity.id, this.deps.registry);
      const key = JSON.stringify([this.workspacePath, session?.id, identity.id, session?.model]);
      // Provider/model can change without the sidebar selecting a different ID.
      if (this.resolvedKey !== null && this.resolvedKey !== key) {
        const previousId = this.state.readings.session?.id;
        if (previousId) this.snapshots.delete(previousId);
        this.boundary();
        generation = this.generation;
        this.inFlight = work;
      }
      this.resolvedKey = key;
      const publishSession = (servedModel?: Reading<string>) => this.emit({
        workspacePath: this.workspacePath, git, loading: false,
        readings: normalizeSessionStatus({ workspacePath: this.workspacePath, session, models,
          defaultEffort, permissionMode: null, workspacePolicy: policy?.policy ?? null,
          workspacePolicySource: policy?.source, servedModel,
          accounts: [...this.accounts.values()].map((entry) => ageReading(entry)) }, this.deps.registry),
      });
      // Common status and quota work must not wait on an optional transcript
      // channel. A provider-specific failure cannot blank workspace/session facts.
      publishSession(this.served.get(key));
      this.startAccounts(adapter.account);
      let servedModel: Reading<string> | undefined;
      if (session && adapter.readServedModel) {
        let served: string | null = null;
        try { served = await adapter.readServedModel(session.id); } catch { /* optional source */ }
        if (!valid()) return;
        if (served) {
          servedModel = measured(served, 'transcript:get-tail-messages:last-observed',
            { kind: 'session', provider: identity.id, workspacePath: this.workspacePath, sessionId: session.id }, null);
          this.served.set(key, servedModel);
        } else {
          const previous = this.served.get(key);
          if (previous?.value) {
            servedModel = { ...previous, state: 'stale', value: previous.value,
              reason: 'Last observed served model; the latest transcript tail has no model' };
            this.served.set(key, servedModel);
          }
        }
      }
      if (!valid()) return;
      if (session && adapter.readServedModel) publishSession(servedModel);
    })().catch(() => {
      if (!valid()) return;
      const readings = { ...this.state.readings };
      for (const key of ['model', 'servedModel', 'effort', 'workspacePolicy', 'execution', 'context', 'tokens'] as const) {
        const reading = readings[key];
        if (reading.value !== null) Object.assign(readings, { [key]: { ...reading, state: 'stale',
          reason: 'Session status could not be refreshed' } });
      }
      this.emit({ ...this.state, readings, loading: false });
    }).finally(() => { if (this.inFlight === work) this.inFlight = undefined; });
    this.inFlight = work;
    return work;
  }

  private startAccounts(selected?: AccountAdapter): void {
    if (this.accountGeneration === this.generation) return;
    this.accountGeneration = this.generation;
    const generation = this.generation;
    const adapters = new Map(this.deps.relatedAccounts.map((adapter) => [adapter.id, adapter]));
    if (selected) adapters.set(selected.id, selected);
    for (const adapter of adapters.values()) {
      let monitor = this.monitors.get(adapter.id);
      if (!monitor) { monitor = new AccountMonitor(adapter, this.cache); this.monitors.set(adapter.id, monitor); }
      if (!this.invalidationWatchers.has(adapter.id) && adapter.subscribeInvalidation) {
        this.invalidationWatchers.set(adapter.id, adapter.subscribeInvalidation(() => this.invalidateAccountSnapshots(adapter.id)));
      }
      if (!this.accounts.has(adapter.id)) this.accounts.set(adapter.id,
        missing('unavailable', adapter.id, adapter.scope(this.workspacePath), 'Waiting for account usage'));
      monitor.start(this.workspacePath, `${generation}`, (reading) => {
        if (!this.active || generation !== this.generation) return;
        const previous = this.accounts.get(adapter.id);
        if (reading.value === null && reading.retryAt !== undefined && previous?.value) {
          // A throttled attempt has not refreshed anything. Keep only this
          // session's explicitly cached value, with its original timestamps.
          reading = { ...cachedReading(previous), retryAt: reading.retryAt };
        } else if (reading.value === null) this.invalidateAccountSnapshots(adapter.id);
        this.accounts.set(adapter.id, reading);
        this.emit({ ...this.state, readings: { ...this.state.readings, accounts: [...this.accounts.values()] } });
      }, () => this.invalidateAccountSnapshots(adapter.id));
    }
  }

  /** Detected auth changes also clear snapshots for sessions not on screen. */
  private invalidateAccountSnapshots(adapterId: string): void {
    for (const snapshot of this.snapshots.values()) {
      snapshot.accounts.delete(adapterId);
      snapshot.status = { ...snapshot.status, readings: { ...snapshot.status.readings,
        accounts: [...snapshot.accounts.values()] } };
    }
    if (this.accounts.delete(adapterId) && this.active) {
      this.emit({ ...this.state, readings: { ...this.state.readings, accounts: [...this.accounts.values()] } });
    }
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const timer of this.timers) clearInterval(timer);
    for (const monitor of this.monitors.values()) monitor.stop();
    this.cache.clear();
    this.served.clear();
    this.snapshots.clear();
    this.accounts.clear();
    for (const stop of this.invalidationWatchers.values()) stop();
    this.invalidationWatchers.clear();
    this.unsubscribers = [];
    this.timers = [];
  }
}
