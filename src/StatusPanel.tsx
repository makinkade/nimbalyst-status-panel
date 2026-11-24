import { Fragment, ReactNode } from 'react';
import { Bar, Chip } from './components/Chip';
import { ConfigChip } from './components/ConfigChip';
import { UpdateChip } from './components/UpdateChip';
import {
  folderName,
  formatCountdown,
  formatResetTime,
} from './lib/format';
import { contextPresentation, effortPresentation, modelPresentation, permissionPresentation,
  fixedClaudeUsage, type UsageBar } from './lib/statusPresentation';
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

export function StatusPanel({ host }: { host: PanelHost }) {
  const workspacePath = host.getPrimaryFolderPath?.() ?? host.workspacePath;
  const status = useStatus(workspacePath);
  const { config, update, reset } = useSegmentConfig(host.storage);
  const availableUpdate = useUpdateCheck(host.storage, config.checkForUpdates);

  // Name the scoped-caps row after the caps actually in force, so the config
  // list says "Model caps (7d Fable)" rather than something abstract.
  const scopedLabels = fixedClaudeUsage(status.readings).scoped.map((entry) => entry.label);
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
  const { readings, git } = status;
  const model = modelPresentation(readings);
  const effort = effortPresentation(readings);
  const permission = permissionPresentation(readings);
  const context = contextPresentation(readings);
  // What currently occupies the window, not what the session has billed.
  const contextPercent = readings.context.value?.percent ?? null;
  const contextAccent = readings.context.state === 'stale' || contextPercent === null ? MUTED : contextColor(contextPercent);

  // Repo root name when in a git repo, else the folder name -- as in the status line.
  const displayPath = folderName(git.repoPath ?? workspacePath);

  // The plan chips report your Claude plan whatever the session is, so beside a
  // session from another provider they have to say whose plan they mean.
  const bars = fixedClaudeUsage(readings);
  const foreign = bars.foreign;

  return {
    model: (
      <Chip
        icon="smart_toy"
        accent={model.muted ? MUTED : PALETTE.teal}
        title={model.title}
      >
        {model.label}
      </Chip>
    ),

    effort: (
      <Chip icon="bolt" accent={effort.muted ? MUTED : PALETTE.green} title={effort.title}>
        {effort.label}
      </Chip>
    ),

    permissionMode: permission.label ? (
      <Chip
        icon="shield"
        accent={permission.muted ? MUTED : permissionModeColor(permission.label)}
        title={permission.title}
      >
        Workspace: {permission.label}
      </Chip>
    ) : (
      // Visible placeholder rather than a vanished chip: a missing value should
      // say why instead of looking like the segment was never configured.
      <Chip
        icon="shield"
        accent={MUTED}
        title={permission.title}
      >
        <span className="sp-label">Workspace —</span>
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
            ? 'The current branch is not available'
            : workspacePath ? `${workspacePath} is not a git repository` : 'No workspace folder open'
        }
      >
        <span className="sp-label">{git.repoPath ? 'Branch —' : 'No repo'}</span>
      </Chip>
    ),

    context: (
      <Chip
        icon="database"
        accent={contextAccent}
        title={context.title}
      >
        <span className="sp-label">{contextPercent !== null || context.occupancy ? 'Context' : 'Context —'}</span>
        {contextPercent !== null ? (
          <>
            <Bar percent={contextPercent} color={contextAccent} />
            <span className="sp-value">{Math.round(contextPercent)}%</span>
          </>
        ) : context.occupancy && <span className="sp-value">{context.occupancy}</span>}
        {context.tokenSummary && (
          <span className="sp-tokens">{context.tokenSummary}{context.tokenStale ? ' (stale)' : ''}</span>
        )}
      </Chip>
    ),

    usage5h: bars.fiveHour ? (
      <UsageChip bar={bars.fiveHour} />
    ) : (
      <MissingBar label="5h" icon="schedule" reason={bars.hasReading ? 'The last plan-usage reading carried no 5h window.' : bars.reason} />
    ),
    usage7d: bars.sevenDay ? (
      <UsageChip bar={bars.sevenDay} />
    ) : (
      <MissingBar label="7d" icon="calendar_month" reason={bars.hasReading ? 'The last plan-usage reading carried no 7d window.' : bars.reason} />
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
          bars.hasReading && !bars.hasUnmeasuredScopedLimit
            ? `No model-scoped caps on your Claude plan right now${
                foreign ? ` (this is a ${foreign} session; the caps are not about it)` : ''
              }`
            : bars.hasUnmeasuredScopedLimit ? 'A model-scoped limit was reported without a usable reading' : bars.reason
        }
      >
        <span className="sp-label">{bars.hasReading && !bars.hasUnmeasuredScopedLimit ? 'No scoped caps' : 'Scoped —'}</span>
      </Chip>
    ),
  };
}

/**
 * GET-97: keep configured usage segments visible when no reading is available.
 * A vanished chip looks like one hidden in the config popover; a placeholder
 * explains that it is enabled but its reading is missing.
 */
function MissingBar({ label, icon, reason }: { label: string; icon: string; reason: string }) {
  return (
    <Chip icon={icon} accent={MUTED} title={reason}>
      <span className="sp-label">{label} —</span>
    </Chip>
  );
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
  const stale = bar.stale;
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

  const notes = [live, 'Usage comes from your Claude sign-in. It has not been linked to the selected session’s account.'];

  if (stale) {
    notes.push(
      `STALE — last reading that actually came back: ${formatResetTime(bar.staleSince) || 'unknown observation time'}. ` +
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
