import { SEGMENT_DESCRIPTIONS, SEGMENT_LABELS, USAGE_GROUP_IDS, type UsageGroupId } from '../segments';
import { formatCountdown, formatResetTime } from './format';
import { selectedAccountUsage } from './providerAdapters';
import { ageReading, type AccountUsage, type Reading, type StatusModel, type UsageBucket, type UsageWindow } from './statusModel';

export interface UsageCard {
  key: string;
  icon: string;
  label: string;
  value: string | null;
  percent: number | null;
  muted: boolean;
  stale: boolean;
  cached?: boolean;
  reset: string;
  title: string;
}

export interface UsageGroup {
  label: string;
  description: string;
  cards: UsageCard[];
}

const GROUP_NAMES: Record<UsageGroupId, string> = {
  usagePrimary: 'Primary usage', usageSecondary: 'Secondary usage', usageAdditional: 'Additional limits',
};
const ICONS: Record<UsageGroupId, string> = {
  usagePrimary: 'schedule', usageSecondary: 'calendar_month', usageAdditional: 'speed',
};

function providerName(id: string | null): string {
  return id === 'claude-code' ? 'Claude' : id === 'openai-codex' ? 'Codex' : id ?? 'Unknown provider';
}

/** Keep units verbatim in meaning; a credit quantity has no implied currency. */
function windowValue(window: UsageWindow): { value: string | null; percent: number | null; note: string } {
  const { value, unit } = window.utilization;
  if (!Number.isFinite(value) || value < 0) return { value: null, percent: null, note: 'No usable utilization was reported.' };
  if (unit === 'percent-used' || unit === 'percent-remaining') {
    if (unit === 'percent-remaining' && value > 100) {
      return { value: null, percent: null, note: 'The reported remaining percentage is outside 0–100%.' };
    }
    const percent = unit === 'percent-remaining' ? 100 - value : value;
    return { value: `${Math.round(percent)}% used`, percent,
      note: `${value}% ${unit === 'percent-remaining' ? 'remaining' : 'used'} reported by the source.` };
  }
  if (unit === 'credits' || unit === 'tokens') {
    return { value: `${value.toLocaleString('en-US')} ${unit}`, percent: null,
      note: `Reported ${unit} quantity; no percentage or monetary spend is inferred.` };
  }
  return { value: null, percent: null, note: 'The reported utilization unit is unsupported.' };
}

function durationText(minutes: number | undefined): string | null {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function readingNotes(reading: Reading<AccountUsage>, model: StatusModel, stale: boolean): string[] {
  const { scope } = reading;
  const notes = [`Provider: ${providerName(scope.provider)} (${scope.provider ?? 'not reported'}).`,
    `Source: ${reading.source}.`, `Scope: ${scope.kind}.`];
  if (scope.accountId) notes.push(`Account: ${scope.accountId}.`);
  else notes.push('Account identity is not reported.');
  if (scope.workspacePath) notes.push(scope.provider === 'openai-codex' && scope.association !== 'verified'
    ? `Local workspace: ${scope.workspacePath}; account/workspace ownership is unverified.`
    : `Workspace scope: ${scope.workspacePath}.`);
  if (scope.configSource) notes.push(`Configuration source: ${scope.configSource}.`);
  notes.push(scope.association === 'verified'
    ? 'The source reports a verified scope association.'
    : 'This login/config-source reading has not been linked to the selected session’s account.');
  if (!model.session) notes.push('No session selected; this is a standalone account reading.');
  if (model.session && (scope.provider !== model.provider.id ||
    (!!scope.workspacePath && scope.workspacePath !== model.model.scope.workspacePath) ||
    (!!scope.sessionId && scope.sessionId !== model.session.id))) {
    notes.push(`This allowance is not this session’s quota; its provider or scope differs from the selection (${model.provider.id ?? 'unknown'}).`);
  }
  if (reading.observedAt !== null && Number.isFinite(reading.observedAt)) {
    notes.push(`Last observed: ${new Date(reading.observedAt).toLocaleString()}.`);
  } else notes.push('Observation time is unknown.');
  if (reading.lastSuccessfulFetchAt != null) notes.push(
    `Last successful fetch: ${new Date(reading.lastSuccessfulFetchAt).toLocaleString()}; this is not source observation time.`);
  if (reading.lastAttemptAt != null) notes.push(`Last attempt: ${new Date(reading.lastAttemptAt).toLocaleString()}.`);
  if (reading.cached) notes.push('Cached from the previous visit to this session; waiting for an account refresh.');
  if (reading.freshnessBasis === 'receipt') notes.push('Refresh age is measured from successful delivery; original source age remains unknown.');
  if (stale && !reading.cached) notes.push(reading.freshnessBasis === 'receipt'
    ? 'STALE — the latest refresh failed or no successful fetch has arrived within two minutes.'
    : 'STALE — showing the last successful cached reading, not current usage.');
  if (reading.reason) notes.push(reading.reason);
  if (reading.value?.plan) notes.push(`Plan: ${reading.value.plan}.`);
  const count = reading.value?.resetCredits?.availableCount;
  if (typeof count === 'number' && Number.isFinite(count) && count >= 0) notes.push(`Reset credits available: ${count}.`);
  return notes;
}

/**
 * GET-225: presentation works only from scoped normalized readings. Collection,
 * auth, cache epochs and refresh cadence remain the adapters' responsibility.
 * Supplying an explicit reading also keeps a retained foreign account honest.
 */
export function usagePresentation(model: StatusModel, explicit?: Reading<AccountUsage>, now = Date.now()): Record<UsageGroupId, UsageGroup> {
  const reading = ageReading(explicit ?? selectedAccountUsage(model), now);
  const provider = providerName(reading.scope.provider);
  const unknownTime = reading.observedAt === null || !Number.isFinite(reading.observedAt) || reading.observedAt > now;
  const stale = !!reading.value && (reading.state === 'stale' || (unknownTime && reading.freshnessBasis !== 'receipt'));
  const foreign = (model.session && reading.scope.provider !== model.provider.id) ||
    (!!reading.scope.workspacePath && reading.scope.workspacePath !== model.model.scope.workspacePath) ||
    (!!reading.scope.sessionId && reading.scope.sessionId !== model.session?.id);
  const notes = readingNotes(reading, model, stale);
  const group = (id: UsageGroupId): UsageGroup => ({
    label: SEGMENT_LABELS[id], description: `${SEGMENT_DESCRIPTIONS[id]}\n${notes.join('\n')}`, cards: [],
  });
  const groups: Record<UsageGroupId, UsageGroup> = {
    usagePrimary: group('usagePrimary'), usageSecondary: group('usageSecondary'), usageAdditional: group('usageAdditional'),
  };
  const keyPrefix = JSON.stringify([reading.scope.provider, reading.scope.kind, reading.scope.workspacePath,
    reading.scope.accountId, reading.scope.sessionId, reading.scope.configSource]);
  const seenWindows = new Set<string>();
  const seenCredits = new Set<string>();
  const seenEmpty = new Set<string>();
  const card = (key: string, group: UsageGroupId, label: string, value: string | null, percent: number | null,
    detail: string[], reset = ''): UsageCard => ({
    key: `${keyPrefix}:${key}`, icon: ICONS[group], label: `${provider} ${reading.scope.provider === 'openai-codex' ? label.replace(/^codex(?:\s*:\s*|\s+|$)/i, '') : label}`, value, percent,
    // Attribution/source-age uncertainty stays in the tooltip. A successful
    // Codex fetch uses the same thresholds as Claude (Mark's GET-227 preference).
    muted: stale || reading.cached === true || !!foreign || value === null, stale, cached: reading.cached, reset,
    title: [...new Set([...notes, ...detail])].join('\n'),
  });

  // Merge repeated buckets before rendering: an empty duplicate must not
  // manufacture a second placeholder beside that bucket's real cards.
  const buckets = new Map<string, UsageBucket>();
  for (const bucket of reading.value?.buckets ?? []) {
    const previous = buckets.get(bucket.id);
    buckets.set(bucket.id, previous ? { ...bucket, ...previous,
      windows: [...previous.windows, ...bucket.windows], credits: previous.credits ?? bucket.credits } : bucket);
  }
  for (const bucket of buckets.values()) {
    const bucketNotes = [`Bucket: ${bucket.label || bucket.id}.`,
      ...(bucket.modelScope ? [`Model scope: ${bucket.modelScope}.`] : []),
      ...(bucket.plan ? [`Bucket plan: ${bucket.plan}.`] : [])];
    for (const window of bucket.windows) {
      const key = JSON.stringify(['window', bucket.id, window.id]);
      if (seenWindows.has(key)) continue;
      seenWindows.add(key);
      const group = window.role === 'primary' ? 'usagePrimary'
        : window.role === 'secondary' ? 'usageSecondary' : 'usageAdditional';
      const value = windowValue(window);
      const reset = formatResetTime(window.resetsAt);
      const countdown = formatCountdown(window.resetsAt, now);
      const duration = durationText(window.durationMinutes);
      // Source labels are authoritative. Include bucket identity for additional
      // limits so two non-model buckets with the same window label stay clear.
      const label = group === 'usageAdditional' && bucket.label && !window.label.includes(bucket.label)
        ? `${bucket.label}: ${window.label || window.id}` : window.label || bucket.label || window.id;
      groups[group].cards.push(card(key, group, `${label}${value.value === null ? ' —' : ''}`, value.value, value.percent,
        [...bucketNotes, value.note, duration ? `Window duration: ${duration} (${window.durationMinutes} minutes).`
          : 'Window duration is not reported.',
        reset ? `Resets ${reset}${countdown ? ` (in ${countdown})` : ''}.`
          : window.resetsAt ? 'The reported reset time could not be read.' : 'Reset time is not reported.'], reset));
    }
    if (bucket.credits && !seenCredits.has(bucket.id)) {
      seenCredits.add(bucket.id);
      const credits = creditValue(bucket);
      groups.usageAdditional.cards.push(card(JSON.stringify(['credits', bucket.id]), 'usageAdditional',
        `${bucket.label || bucket.id} credits${credits.value === null ? ' —' : ''}`, credits.value, null, [...bucketNotes, credits.note]));
    }
    if (!bucket.windows.length && !bucket.credits && !seenEmpty.has(bucket.id)) {
      seenEmpty.add(bucket.id);
      groups.usageAdditional.cards.push(card(JSON.stringify(['empty', bucket.id]), 'usageAdditional',
        `${bucket.label || bucket.id} —`, null, null, [...bucketNotes, 'This bucket reported no usable window or credits.']));
    }
  }

  const resetCredits = reading.value?.resetCredits?.availableCount;
  if (typeof resetCredits === 'number' && Number.isFinite(resetCredits) && resetCredits >= 0) {
    groups.usageAdditional.cards.push(card('reset-credits', 'usageAdditional', 'Reset credits',
      `${resetCredits} available`, null, ['Reset-credit count reported by the source; this is not a monetary balance.']));
  }

  for (const id of USAGE_GROUP_IDS) {
    const group = groups[id];
    if (!group.cards.length) {
      // GET-97's invariant survives the migration: enabled groups say why they
      // are empty, rather than looking like something hidden in the gear.
      const state = reading.value ? 'not applicable' : reading.state === 'unauthenticated' ? 'sign in required'
        : reading.state === 'unsupported' ? 'unsupported' : 'unavailable';
      const explanation = reading.value ? id === 'usageAdditional'
        ? 'No additional limits or credits were reported.'
        : `No applicable ${id === 'usagePrimary' ? 'primary' : 'secondary'} window was reported.`
        : reading.reason ?? 'No usage reading is available.';
      group.cards.push(card(`empty:${id}`, id, `${GROUP_NAMES[id]} — ${state}`, null, null, [explanation]));
    }
    const measuredLabels = group.cards.filter((entry) => entry.value !== null).map((entry) => entry.label);
    if (measuredLabels.length) group.label += ` (${measuredLabels.join(', ')})`;
  }
  return groups;
}

function creditValue(bucket: UsageBucket): { value: string | null; note: string } {
  const credits = bucket.credits!;
  // Explicit flags only: an absent limit or balance is never "unlimited".
  if (credits.unlimited === true) return { value: 'Unlimited', note: 'The source explicitly reports unlimited credits.' };
  if ((typeof credits.balance === 'number' && Number.isFinite(credits.balance)) ||
    (typeof credits.balance === 'string' && credits.balance.trim())) {
    return { value: `Balance ${credits.balance}`, note: 'Credit balance reported by the source; currency and monetary spend are not inferred.' };
  }
  return { value: credits.hasCredits === true ? 'Available' : credits.hasCredits === false ? 'None available' : null,
    note: 'Credit balance and limits are not reported; no percentage is available.' };
}
