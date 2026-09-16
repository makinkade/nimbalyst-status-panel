/** The strip's configurable segments, in default order. */
export const SEGMENT_IDS = [
  'model',
  'effort',
  'permissionMode',
  'directory',
  'branch',
  'context',
  'usage5h',
  'usage7d',
  'usageScoped',
] as const;

export type SegmentId = (typeof SEGMENT_IDS)[number];

export const SEGMENT_LABELS: Record<SegmentId, string> = {
  model: 'Model',
  effort: 'Effort',
  permissionMode: 'Permission mode',
  directory: 'Directory',
  branch: 'Git branch',
  context: 'Context usage',
  usage5h: '5h limit',
  usage7d: '7d limit',
  usageScoped: 'Model-scoped limits',
};

/** Popover tooltips: what each segment actually reports. */
export const SEGMENT_DESCRIPTIONS: Record<SegmentId, string> = {
  model: 'The model backing the active session, named from the model catalog.',
  effort: 'Reasoning effort for the session -- how much thinking the model spends per turn.',
  permissionMode: "The workspace's agent permission mode: Bypass, Auto, Plan or Default.",
  directory: 'The repo root folder when the workspace is a git repo, otherwise the workspace folder.',
  branch: 'Current git branch, with a count of uncommitted files.',
  context:
    "How much of the model's context window the session occupies right now, with input and output token counts.",
  usage5h: 'Your rolling 5-hour plan utilization, and when it resets.',
  usage7d: 'Your rolling 7-day plan utilization, and when it resets.',
  usageScoped:
    'Model-scoped plan caps reported by the usage API, such as a separate weekly limit for one model.',
};

export interface SegmentConfig {
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
}

export const DEFAULT_CONFIG: SegmentConfig = {
  order: [...SEGMENT_IDS],
  hidden: [],
  autoOpen: true,
};

/**
 * Reconcile a stored config with the current segment set: drop ids that no
 * longer exist and append ones added since it was saved, so a new segment in a
 * later version shows up instead of silently vanishing.
 */
export function normalizeConfig(stored: unknown): SegmentConfig {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_CONFIG, order: [...SEGMENT_IDS] };

  const candidate = stored as Partial<SegmentConfig>;
  const known = new Set<string>(SEGMENT_IDS);

  const order = (Array.isArray(candidate.order) ? candidate.order : [])
    .filter((id): id is SegmentId => known.has(id));
  for (const id of SEGMENT_IDS) {
    if (!order.includes(id)) order.push(id);
  }

  const hidden = (Array.isArray(candidate.hidden) ? candidate.hidden : [])
    .filter((id): id is SegmentId => known.has(id));

  // Absent in configs saved before the option existed -- fall back to the
  // default rather than reading `undefined` as "off".
  const autoOpen =
    typeof candidate.autoOpen === 'boolean' ? candidate.autoOpen : DEFAULT_CONFIG.autoOpen;

  return { order, hidden, autoOpen };
}

export function moveSegment(order: SegmentId[], id: SegmentId, delta: number): SegmentId[] {
  const index = order.indexOf(id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= order.length) return order;

  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
