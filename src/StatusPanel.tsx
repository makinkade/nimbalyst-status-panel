import { Fragment, ReactNode, useMemo } from 'react';
import { Bar, Chip } from './components/Chip';
import { ConfigChip } from './components/ConfigChip';
import {
  folderName,
  formatCountdown,
  formatResetTime,
  formatTokens,
  permissionModeLabel,
  titleCase,
} from './lib/format';
import { DataAccess, EffortSource, extractTokenUsage } from './lib/ipc';
import { friendlyModelName } from './lib/modelNames';
import { SEGMENT_DESCRIPTIONS, SEGMENT_LABELS } from './segments';
import { ExecFn } from './lib/planUsage';
import { MUTED, PALETTE, contextColor, permissionModeColor, usageColor } from './lib/thresholds';
import { SegmentId } from './segments';
import { PanelStorage, useSegmentConfig } from './useSegmentConfig';
import { Status, useStatus } from './useStatus';
import './styles.css';

interface PanelHost {
  workspacePath: string;
  getPrimaryFolderPath: () => string;
  exec?: ExecFn;
  storage?: PanelStorage;
  data?: DataAccess;
}

/**
 * The helper self-caches for 60s and the panel polls it every 60s, so a reading
 * older than this means the fetch itself is failing -- almost always because
 * the usage API is rate-limiting, which it does exactly when you are near a cap.
 */
const USAGE_STALE_AFTER_MS = 5 * 60_000;

interface UsageBar {
  key: string;
  icon: string;
  label: string;
  percent: number;
  reset: string | null;
  /** Age of the reading, when it is old enough to be worth saying so. */
  staleSince?: string | null;
}

export function StatusPanel({ host }: { host: PanelHost }) {
  const workspacePath = host.getPrimaryFolderPath?.() ?? host.workspacePath;
  // `.bind()` returns a new function every call, so binding inline made the
  // plan-usage effect re-run on every render -- each one spawning a shell to
  // run get-plan-usage.ps1.
  const exec = useMemo(() => host.exec?.bind(host), [host]);
  const status = useStatus(workspacePath, exec, host.data);
  const { config, update, reset } = useSegmentConfig(host.storage);

  // Name the scoped-caps row after the caps actually in force, so the config
  // list says "Model caps (7d Fable)" rather than something abstract.
  const scopedLabels = (status.planUsage?.scoped ?? []).map((entry) => entry.label);
  const labels = {
    ...SEGMENT_LABELS,
    usageScoped: scopedLabels.length
      ? `Model caps (${scopedLabels.join(', ')})`
      : SEGMENT_LABELS.usageScoped,
  };

  const segments = buildSegments(status, workspacePath);
  const hidden = new Set(config.hidden);

  // The config chip renders unconditionally: it must stay reachable even when
  // no data has arrived, so the panel is never a dead rectangle.
  return (
    <div className="sp-strip">
      {status.loading ? (
        <span className="sp-loading">Reading session status...</span>
      ) : (
        config.order
          .filter((id) => !hidden.has(id))
          .map((id) => <Fragment key={id}>{segments[id]}</Fragment>)
      )}

      {!status.planUsage && status.usage?.error && (
        <Chip icon="error" accent={PALETTE.red} title={status.usage.error}>
          Usage unavailable
        </Chip>
      )}

      <ConfigChip
        config={config}
        labels={labels}
        descriptions={SEGMENT_DESCRIPTIONS}
        onChange={update}
        onReset={reset}
      />
    </div>
  );
}

function buildSegments(status: Status, workspacePath: string): Record<SegmentId, ReactNode> {
  const { session, model, effort, effortSource, permissionMode, git, planUsage, usage } = status;

  const tokens = extractTokenUsage(session);
  // What currently occupies the window, not what the session has billed.
  const contextTokens = tokens?.currentContext?.tokens;
  const contextWindow =
    tokens?.currentContext?.contextWindow ?? tokens?.contextWindow ?? model?.contextWindow;
  const contextPercent =
    contextTokens && contextWindow ? Math.min((contextTokens / contextWindow) * 100, 100) : null;

  // Repo root name when in a git repo, else the folder name -- as in the script.
  const displayPath = folderName(git.repoPath ?? workspacePath);
  const bars = buildUsageBars(planUsage, usage);

  return {
    model: (
      <Chip
        icon="smart_toy"
        accent={PALETTE.teal}
        title={session ? `${session.title ?? 'Untitled'} — ${session.model ?? 'unknown model'}` : undefined}
      >
        {model?.name ?? friendlyModelName(session?.model) ?? 'No session'}
      </Chip>
    ),

    effort: effort ? (
      <Chip icon="bolt" accent={PALETTE.green} title={describeEffort(effort, effortSource)}>
        {titleCase(effort)}
      </Chip>
    ) : null,

    permissionMode: permissionMode ? (
      <Chip
        icon="shield"
        accent={permissionModeColor(permissionModeLabel(permissionMode))}
        title={`Workspace permission mode: ${permissionMode}`}
      >
        {permissionModeLabel(permissionMode)}
      </Chip>
    ) : (
      // Visible placeholder rather than a vanished chip: a missing value should
      // say why instead of looking like the segment was never configured.
      <Chip
        icon="shield"
        accent={MUTED}
        title="workspace:get-state returned no agentPermissions.permissionMode"
      >
        <span className="sp-label">Mode —</span>
      </Chip>
    ),

    directory: (
      <Chip icon="folder" accent={PALETTE.blue} title={workspacePath}>
        {displayPath}
      </Chip>
    ),

    branch: git.branch ? (
      <Chip
        icon="call_split"
        accent={PALETTE.purple}
        title={git.dirtyCount > 0 ? `${git.dirtyCount} uncommitted file(s)` : 'Clean'}
      >
        {git.branch}
        {git.dirtyCount > 0 && <span className="sp-dirty">±{git.dirtyCount}</span>}
      </Chip>
    ) : (
      <Chip
        icon="call_split"
        accent={MUTED}
        title={
          git.repoPath
            ? 'git:branches returned no current branch'
            : `${workspacePath} is not a git repository`
        }
      >
        <span className="sp-label">{git.repoPath ? 'Branch —' : 'No repo'}</span>
      </Chip>
    ),

    context:
      contextPercent !== null ? (
        <Chip
          icon="database"
          accent={contextColor(contextPercent)}
          title={`${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} tokens in context`}
        >
          <span className="sp-label">Context</span>
          <Bar percent={contextPercent} color={contextColor(contextPercent)} />
          <span className="sp-value">{Math.round(contextPercent)}%</span>
          {(tokens?.inputTokens !== undefined || tokens?.outputTokens !== undefined) && (
            <span className="sp-tokens">
              ↑{formatTokens(tokens?.inputTokens)} ↓{formatTokens(tokens?.outputTokens)}
            </span>
          )}
        </Chip>
      ) : (
        <Chip icon="database" accent={MUTED} title={describeMissingContext(status, tokens, contextWindow)}>
          <span className="sp-label">Context —</span>
        </Chip>
      ),

    usage5h: renderBar(bars.fiveHour),
    usage7d: renderBar(bars.sevenDay),
    usageScoped: bars.scoped.length ? (
      bars.scoped.map((bar) => <UsageChip key={bar.key} bar={bar} />)
    ) : (
      // An empty `limits[]` is the API saying there are no model-scoped caps
      // right now -- distinct from the helper script being unavailable, which
      // is the case worth flagging.
      <Chip
        icon="speed"
        accent={MUTED}
        title={
          planUsage
            ? 'No model-scoped caps in the usage API right now'
            : 'get-plan-usage.ps1 unavailable; claude-usage:get does not expose scoped caps'
        }
      >
        <span className="sp-label">{planUsage ? 'No scoped caps' : 'Scoped —'}</span>
      </Chip>
    ),
  };
}

/** Reasoning effort, plus where the value was resolved from. */
function describeEffort(effort: string, source: EffortSource | null): string {
  const origin =
    source === 'session'
      ? "this session's own setting"
      : source === 'app-default'
        ? 'the app default effort level'
        : 'the built-in default (no session or app value set)';
  return `Reasoning effort: ${titleCase(effort)}, from ${origin}.`;
}

/** Says which link in the chain is missing, so the tooltip is a diagnosis. */
function describeMissingContext(
  status: Status,
  tokens: ReturnType<typeof extractTokenUsage>,
  contextWindow: number | undefined,
): string {
  if (!status.session) return 'No session resolved for this workspace';
  if (!tokens) return `Session ${status.session.id}: no tokenUsage in metadata`;
  if (tokens.currentContext?.tokens === undefined) {
    return `Session ${status.session.id}: tokenUsage has no currentContext.tokens`;
  }
  if (!contextWindow) return `Session ${status.session.id}: no context window known`;
  return 'Context unavailable';
}

function renderBar(bar: UsageBar | null): ReactNode {
  return bar ? <UsageChip bar={bar} /> : null;
}

/**
 * The helper script is authoritative when present: it carries the scoped model
 * caps (e.g. `7d Fable`) that `claude-usage:get` drops.
 */
function buildUsageBars(
  planUsage: Status['planUsage'],
  usage: Status['usage'],
): { fiveHour: UsageBar | null; sevenDay: UsageBar | null; scoped: UsageBar[] } {
  if (planUsage) {
    const readAt = planUsage.timestamp ? Date.parse(planUsage.timestamp) : NaN;
    const staleSince =
      Number.isFinite(readAt) && Date.now() - readAt > USAGE_STALE_AFTER_MS
        ? planUsage.timestamp ?? null
        : null;

    return {
      fiveHour:
        typeof planUsage.fiveHour === 'number'
          ? {
              key: '5h',
              icon: 'schedule',
              label: '5h',
              percent: planUsage.fiveHour,
              reset: planUsage.fiveHourReset ?? null,
              staleSince,
            }
          : null,
      sevenDay:
        typeof planUsage.sevenDay === 'number'
          ? {
              key: '7d',
              icon: 'calendar_month',
              label: '7d',
              percent: planUsage.sevenDay,
              reset: planUsage.sevenDayReset ?? null,
              staleSince,
            }
          : null,
      scoped: (planUsage.scoped ?? []).map((scoped) => ({
        key: scoped.label,
        icon: scoped.label.startsWith('5h') ? 'schedule' : 'calendar_month',
        label: scoped.label,
        percent: scoped.pct,
        reset: scoped.reset,
        staleSince,
      })),
    };
  }

  return {
    fiveHour: usage?.fiveHour
      ? {
          key: '5h',
          icon: 'schedule',
          label: '5h',
          percent: usage.fiveHour.utilization,
          reset: usage.fiveHour.resetsAt,
        }
      : null,
    sevenDay: usage?.sevenDay
      ? {
          key: '7d',
          icon: 'calendar_month',
          label: '7d',
          percent: usage.sevenDay.utilization,
          reset: usage.sevenDay.resetsAt,
        }
      : null,
    // seven_day_opus is the host's only scoped window.
    scoped: usage?.sevenDayOpus
      ? [
          {
            key: '7d-opus',
            icon: 'calendar_month',
            label: '7d Opus',
            percent: usage.sevenDayOpus.utilization,
            reset: usage.sevenDayOpus.resetsAt,
          },
        ]
      : [],
  };
}

function UsageChip({ bar }: { bar: UsageBar }) {
  const stale = !!bar.staleSince;
  // A stale number must not keep its red/green authority -- the colour is a
  // claim about right now.
  const color = stale ? MUTED : usageColor(bar.percent);
  const reset = formatResetTime(bar.reset);
  const countdown = formatCountdown(bar.reset);

  // The strip re-renders on the 5s status tick, so the countdown stays current.
  const live = reset
    ? `${bar.label} at ${Math.round(bar.percent)}% — resets ${reset}${countdown ? ` (in ${countdown})` : ''}`
    : `${bar.label} at ${Math.round(bar.percent)}%`;

  const title = stale
    ? `${live}

STALE — last reading that actually came back: ${formatResetTime(bar.staleSince)}. ` +
      'The usage API rate-limits too, and it does so precisely when you are near a cap, ' +
      'so this is the last value received rather than your current usage.'
    : live;

  return (
    <Chip icon={bar.icon} accent={color} title={title}>
      <span className="sp-label">{bar.label}</span>
      <Bar percent={bar.percent} color={color} />
      <span className="sp-value">
        {Math.round(bar.percent)}%{stale ? '?' : ''}
      </span>
      {reset && <span className="sp-reset">↻ {reset}</span>}
    </Chip>
  );
}
