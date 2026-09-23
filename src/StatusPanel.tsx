import { Fragment, ReactNode } from 'react';
import { Bar, Chip } from './components/Chip';
import { ConfigChip } from './components/ConfigChip';
import { UpdateChip } from './components/UpdateChip';
import {
  folderName,
  formatCountdown,
  formatResetTime,
  formatTokens,
  permissionModeLabel,
  titleCase,
} from './lib/format';
import { EffortSource, extractTokenUsage } from './lib/ipc';
import { friendlyModelName } from './lib/modelNames';
import { foreignProvider } from './lib/provider';
import { SEGMENT_DESCRIPTIONS, SEGMENT_LABELS } from './segments';
import { MUTED, PALETTE, contextColor, permissionModeColor, usageColor } from './lib/thresholds';
import { SegmentId } from './segments';
import { PanelStorage, useSegmentConfig } from './useSegmentConfig';
import { Status, useStatus } from './useStatus';
import { useUpdateCheck } from './useUpdateCheck';
import './styles.css';

interface PanelHost {
  workspacePath: string;
  getPrimaryFolderPath: () => string;
  storage?: PanelStorage;
}

/**
 * The cache holds for 60s and the panel refreshes every 60s, so a reading older
 * than this means the fetch itself is failing -- almost always because the
 * usage API is rate-limiting, which it does exactly when you are near a cap.
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
  /**
   * The non-Claude provider of the session on screen, when there is one. The
   * bar is about your Claude plan either way; this is what makes it say so.
   */
  foreign?: string | null;
}

export function StatusPanel({ host }: { host: PanelHost }) {
  const workspacePath = host.getPrimaryFolderPath?.() ?? host.workspacePath;
  const status = useStatus(workspacePath);
  const { config, update, reset } = useSegmentConfig(host.storage);
  const availableUpdate = useUpdateCheck(host.storage, config.checkForUpdates);

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

      {/*
        Outside the configurable segment list on purpose. The segments describe
        the focused session and are ordered against each other; this describes
        the extension itself, appears on the handful of days a release lands,
        and is governed by its own Behavior setting rather than by a visibility
        checkbox. Putting it in `order` would also break the invariant the
        empty-state tests hold every segment to -- that a configured segment
        always renders something saying why it is empty -- which this one
        deliberately does not. It sits beside the gear for the same reason the
        gear does: it is about the panel, not about the session.
      */}
      {availableUpdate && <UpdateChip update={availableUpdate} />}

      <ConfigChip
        config={config}
        labels={labels}
        descriptions={SEGMENT_DESCRIPTIONS}
        onChange={update}
        onReset={reset}
        updateVersion={availableUpdate?.release.version ?? null}
      />
    </div>
  );
}

/** Exported for the segment tests, which render the strip without a DOM. */
export function buildSegments(status: Status, workspacePath: string): Record<SegmentId, ReactNode> {
  const { session, model, effort, effortSource, permissionMode, git, planUsage, usage } = status;

  const tokens = extractTokenUsage(session);
  // What currently occupies the window, not what the session has billed.
  const contextTokens = tokens?.currentContext?.tokens;
  const contextWindow =
    tokens?.currentContext?.contextWindow ?? tokens?.contextWindow ?? model?.contextWindow;
  const contextPercent =
    contextTokens && contextWindow ? Math.min((contextTokens / contextWindow) * 100, 100) : null;

  // Repo root name when in a git repo, else the folder name -- as in the status line.
  const displayPath = folderName(git.repoPath ?? workspacePath);

  // The plan chips report your Claude plan whatever the session is, so beside a
  // session from another provider they have to say whose plan they mean.
  const foreign = foreignProvider(session);
  const bars = buildUsageBars(planUsage, usage, foreign);

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

    directory: displayPath ? (
      <Chip icon="folder" accent={PALETTE.blue} title={workspacePath}>
        {displayPath}
      </Chip>
    ) : (
      // No workspace path at all -- `folderName('')` is `''`, which rendered a
      // chip holding nothing but its icon. Say what is missing instead.
      <Chip icon="folder" accent={MUTED} title="No workspace folder open">
        <span className="sp-label">No folder</span>
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

    usage5h: bars.fiveHour ? (
      <UsageChip bar={bars.fiveHour} />
    ) : (
      <MissingBar label="5h" icon="schedule" planUsage={planUsage} usage={usage} />
    ),
    usage7d: bars.sevenDay ? (
      <UsageChip bar={bars.sevenDay} />
    ) : (
      <MissingBar label="7d" icon="calendar_month" planUsage={planUsage} usage={usage} />
    ),
    usageScoped: bars.scoped.length ? (
      bars.scoped.map((bar) => <UsageChip key={bar.key} bar={bar} />)
    ) : (
      // An empty `limits[]` is the API saying there are no model-scoped caps
      // right now -- distinct from the usage endpoint being unreachable, which
      // is the case worth flagging.
      <Chip
        icon="speed"
        accent={MUTED}
        title={
          planUsage
            ? `No model-scoped caps on your Claude plan right now${
                foreign ? ` (this is a ${foreign} session; the caps are not about it)` : ''
              }`
            : 'Usage endpoint unreachable; claude-usage:get does not expose scoped caps'
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

/**
 * A usage window with no reading behind it.
 *
 * These two segments used to render `null`, so a segment the user had switched
 * *on* simply was not there -- indistinguishable from one hidden in the config
 * popover, and the only segments to behave that way: mode, branch, context and
 * scoped caps all degrade to a muted placeholder that says why. This gives 5h
 * and 7d the same one.
 */
function MissingBar({
  label,
  icon,
  planUsage,
  usage,
}: {
  label: string;
  icon: string;
  planUsage: Status['planUsage'];
  usage: Status['usage'];
}) {
  return (
    <Chip icon={icon} accent={MUTED} title={describeMissingUsage(label, planUsage, usage)}>
      <span className="sp-label">{label} —</span>
    </Chip>
  );
}

/** Which link in the usage chain is missing, so the tooltip is a diagnosis. */
function describeMissingUsage(
  label: string,
  planUsage: Status['planUsage'],
  usage: Status['usage'],
): string {
  if (planUsage) return `The last plan-usage reading carried no ${label} window.`;
  if (usage?.error) return `Usage unavailable: ${usage.error}`;
  if (usage) return `claude-usage:get returned no ${label} window.`;
  return (
    `No ${label} reading: the Anthropic usage endpoint is unreachable and claude-usage:get ` +
    'returned nothing either. Reading your plan directly needs the Claude credentials file, ' +
    "so this is also what it looks like when the extension's filesystem permission is denied."
  );
}

/**
 * The usage endpoint is authoritative when it answers: it carries the scoped
 * model caps (e.g. `7d Fable`) that `claude-usage:get` drops.
 *
 * `foreign` rides along on every bar rather than being applied here: the
 * numbers are the same numbers whoever is on screen, and it is only their
 * presentation -- label and colour -- that has to change.
 */
function buildUsageBars(
  planUsage: Status['planUsage'],
  usage: Status['usage'],
  foreign: string | null = null,
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
              foreign,
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
              foreign,
            }
          : null,
      scoped: (planUsage.scoped ?? []).map((scoped) => ({
        key: scoped.label,
        icon: scoped.label.startsWith('5h') ? 'schedule' : 'calendar_month',
        label: scoped.label,
        percent: scoped.pct,
        reset: scoped.reset,
        staleSince,
        foreign,
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
          foreign,
        }
      : null,
    sevenDay: usage?.sevenDay
      ? {
          key: '7d',
          icon: 'calendar_month',
          label: '7d',
          percent: usage.sevenDay.utilization,
          reset: usage.sevenDay.resetsAt,
          foreign,
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
            foreign,
          },
        ]
      : [],
  };
}

/**
 * What the chip calls itself: `Claude 5h` beside a session from another
 * provider, `5h` beside a Claude one.
 *
 * The qualifier is only worth its width when there is something on screen it
 * could be confused with.
 */
function usageBarLabel(bar: UsageBar): string {
  return bar.foreign ? `Claude ${bar.label}` : bar.label;
}

function UsageChip({ bar }: { bar: UsageBar }) {
  const stale = !!bar.staleSince;
  const label = usageBarLabel(bar);

  // A reading the panel cannot vouch for loses its red/green authority: the
  // colour is a claim about urgency right now, for the session in front of you.
  // A stale number fails the "right now" half; a Claude plan bar beside a Codex
  // session fails the "for this session" half. Both demote to muted.
  const color = stale || bar.foreign ? MUTED : usageColor(bar.percent);
  const reset = formatResetTime(bar.reset);
  const countdown = formatCountdown(bar.reset);

  // The strip re-renders on the 5s status tick, so the countdown stays current.
  const live = reset
    ? `${label} at ${Math.round(bar.percent)}% — resets ${reset}${countdown ? ` (in ${countdown})` : ''}`
    : `${label} at ${Math.round(bar.percent)}%`;

  const notes = [live];

  if (stale) {
    notes.push(
      `STALE — last reading that actually came back: ${formatResetTime(bar.staleSince)}. ` +
        'The usage API rate-limits too, and it does so precisely when you are near a cap, ' +
        'so this is the last value received rather than your current usage.',
    );
  }

  if (bar.foreign) {
    notes.push(
      'This bar describes your Claude plan, not this session — the focused session runs on ' +
        `${bar.foreign}. Plan usage is read from Anthropic with your Claude credentials, so it ` +
        'is the same number whichever session is in front of you.',
    );
  }

  return (
    <Chip icon={bar.icon} accent={color} title={notes.join('\n\n')}>
      <span className="sp-label">{label}</span>
      <Bar percent={bar.percent} color={color} />
      <span className="sp-value">
        {Math.round(bar.percent)}%{stale ? '?' : ''}
      </span>
      {reset && <span className="sp-reset">↻ {reset}</span>}
    </Chip>
  );
}
