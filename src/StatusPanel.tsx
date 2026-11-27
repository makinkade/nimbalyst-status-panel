import { Fragment, ReactNode } from 'react';
import { Bar, Chip } from './components/Chip';
import { ConfigChip } from './components/ConfigChip';
import { UpdateChip } from './components/UpdateChip';
import { UsageChip } from './components/UsageChip';
import { folderName } from './lib/format';
import { contextPresentation, effortPresentation, modelPresentation, permissionPresentation } from './lib/statusPresentation';
import { usagePresentation } from './lib/usagePresentation';
import { SEGMENT_DESCRIPTIONS, SEGMENT_LABELS, USAGE_GROUP_IDS } from './segments';
import { MUTED, PALETTE, contextColor, permissionModeColor } from './lib/thresholds';
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

  // Live labels explain what the stable groups contain. Bucket churn never
  // changes the saved control IDs, visibility or position (GET-225).
  const usage = usagePresentation(status.readings);
  const labels = { ...SEGMENT_LABELS };
  const descriptions = { ...SEGMENT_DESCRIPTIONS };
  for (const id of USAGE_GROUP_IDS) {
    labels[id] = usage[id].label;
    descriptions[id] = usage[id].description;
  }

  const segments = buildSegments(status, workspacePath, usage);
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
        descriptions={descriptions}
        onChange={update}
        onReset={reset}
        updateVersion={availableUpdate?.release.version ?? null}
      />
    </div>
  );
}

/** Exported for the segment tests, which render the strip without a DOM. */
export function buildSegments(status: Status, workspacePath: string,
  usage = usagePresentation(status.readings)): Record<SegmentId, ReactNode> {
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

    usagePrimary: usage.usagePrimary.cards.map((card) => <UsageChip key={card.key} card={card} />),
    usageSecondary: usage.usageSecondary.cards.map((card) => <UsageChip key={card.key} card={card} />),
    usageAdditional: usage.usageAdditional.cards.map((card) => <UsageChip key={card.key} card={card} />),
  };
}
