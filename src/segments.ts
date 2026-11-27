/** The strip's configurable segments, in default order. */
export const SEGMENT_IDS = [
  'model',
  'effort',
  'permissionMode',
  'directory',
  'branch',
  'context',
  'usagePrimary',
  'usageSecondary',
  'usageAdditional',
] as const;

export type SegmentId = (typeof SEGMENT_IDS)[number];
export const USAGE_GROUP_IDS = ['usagePrimary', 'usageSecondary', 'usageAdditional'] as const;
export type UsageGroupId = (typeof USAGE_GROUP_IDS)[number];

export const SEGMENT_LABELS: Record<SegmentId, string> = {
  model: 'Model',
  effort: 'Effort',
  permissionMode: 'Workspace policy',
  directory: 'Directory',
  branch: 'Git branch',
  context: 'Context usage',
  usagePrimary: 'Primary window',
  usageSecondary: 'Secondary window',
  usageAdditional: 'Additional limits / credits',
};

/** Popover tooltips: what each segment actually reports. */
export const SEGMENT_DESCRIPTIONS: Record<SegmentId, string> = {
  model: 'The requested model and last observed served identity, using catalog names or readable IDs.',
  effort: 'Configured reasoning effort, with session settings and applicable defaults distinguished. Effective effort is not reported.',
  permissionMode: 'Workspace policy: Ask, Allow all, Bypass or Agent-verified. Provider approval, sandbox and network access are separate readings.',
  directory: 'The workspace folder. The host git channels do not report a repository root.',
  branch: 'Current git branch, with a count of uncommitted files.',
  context:
    'Reported current context occupancy and window, with separate session token counters even when no percentage is available.',
  usagePrimary: 'The selected provider’s primary usage window, with its reported duration and reset.',
  usageSecondary: 'The selected provider’s secondary usage window, when one applies.',
  usageAdditional: 'Additional usage buckets, model caps and credits reported by the selected provider.',
};

export interface SegmentConfig {
  /** GET-225: v2 migrates the fixed Claude controls to stable usage groups. */
  version: 2;
  order: SegmentId[];
  hidden: SegmentId[];
  /**
   * Open the panel automatically on startup.
   *
   * Nimbalyst only restores `placement: "sidebar"` extension panels across
   * restarts, so a bottom panel always comes back closed unless the extension
   * opens it itself. See `autoOpenPanel` in index.ts.
   */
  autoOpen: boolean;
  /**
   * Ask github.com whether a newer release of this extension exists.
   *
   * On by default, because Nimbalyst never updates a GitHub-installed
   * extension on its own and the alternative is staying on whatever version you
   * first installed forever. Off is a real preference rather than a courtesy
   * one: this is the only thing the panel does that reaches an address the user
   * did not open, and some people will not want an extension doing that. When
   * it is off no request is made at all -- the chip is not merely hidden.
   */
  checkForUpdates: boolean;
}

export const DEFAULT_CONFIG: SegmentConfig = {
  version: 2,
  order: [...SEGMENT_IDS],
  hidden: [],
  autoOpen: true,
  checkForUpdates: true,
};

/**
 * Reconcile a stored config with the current segment set: drop ids that no
 * longer exist and append ones added since it was saved, so a new segment in a
 * later version shows up instead of silently vanishing.
 */
export function normalizeConfig(stored: unknown): SegmentConfig {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_CONFIG, order: [...SEGMENT_IDS], hidden: [] };

  const candidate = stored as Partial<SegmentConfig>;
  const known = new Set<string>(SEGMENT_IDS);

  // Map before filtering: dropping old IDs first would reset both their exact
  // position among other cards and every hidden Claude control (GET-225).
  const aliases: Record<string, SegmentId> = {
    usage5h: 'usagePrimary', usage7d: 'usageSecondary', usageScoped: 'usageAdditional',
  };
  const reconcile = (value: unknown): SegmentId[] => [...new Set(
    (Array.isArray(value) ? value : [])
      .filter((id): id is string => typeof id === 'string')
      .map((id) => Object.prototype.hasOwnProperty.call(aliases, id) ? aliases[id] : id)
      .filter((id): id is SegmentId => known.has(id)),
  )];
  const order = reconcile(candidate.order);
  for (const id of SEGMENT_IDS) {
    if (!order.includes(id)) order.push(id);
  }

  const hidden = reconcile(candidate.hidden);

  // Absent in configs saved before the option existed -- fall back to the
  // default rather than reading `undefined` as "off".
  const autoOpen =
    typeof candidate.autoOpen === 'boolean' ? candidate.autoOpen : DEFAULT_CONFIG.autoOpen;
  const checkForUpdates =
    typeof candidate.checkForUpdates === 'boolean'
      ? candidate.checkForUpdates
      : DEFAULT_CONFIG.checkForUpdates;

  return { version: 2, order, hidden, autoOpen, checkForUpdates };
}

export function moveSegment(order: SegmentId[], id: SegmentId, delta: number): SegmentId[] {
  const index = order.indexOf(id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= order.length) return order;

  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
