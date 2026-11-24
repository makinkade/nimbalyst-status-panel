import type { StatusModel, UsageWindow } from './statusModel';
import { ageReading } from './statusModel';

export interface UsageBar {
  key: string;
  icon: string;
  label: string;
  percent: number;
  reset: string | null;
  stale: boolean;
  staleSince: string | null;
  foreign: string | null;
}

/**
 * Temporary projection for the existing fixed segment IDs (GET-225 owns their
 * migration). Collection, source precedence, errors and freshness are already
 * resolved by the adapter. The renderer never sees Claude host/cache payloads.
 */
export function fixedClaudeUsage(model: StatusModel) {
  const found = model.accounts.find((reading) => reading.scope.provider === 'claude-code');
  const reading = found ? ageReading(found) : null;
  const foreign = model.session && model.provider.id !== 'claude-code'
    ? model.provider.id ?? 'unknown provider' : null;
  const bar = (window: UsageWindow, bucket: string): UsageBar | null =>
    window.utilization.unit === 'percent-used' ? {
      key: `${bucket}/${window.id}`, label: window.label, percent: window.utilization.value,
      icon: window.durationMinutes === 300 ? 'schedule' : 'calendar_month', reset: window.resetsAt,
      stale: reading?.state === 'stale',
      staleSince: reading?.observedAt != null ? new Date(reading.observedAt).toISOString() : null,
      foreign,
    } : null;
  const plan = reading?.value?.buckets.find((bucket) => bucket.id === 'plan');
  const fiveHour = plan?.windows.find((window) => window.id === 'five-hour');
  const sevenDay = plan?.windows.find((window) => window.id === 'seven-day');
  return {
    fiveHour: fiveHour ? bar(fiveHour, 'plan') : null,
    sevenDay: sevenDay ? bar(sevenDay, 'plan') : null,
    scoped: (reading?.value?.buckets ?? []).filter((bucket) => bucket.modelScope)
      .flatMap((bucket) => bucket.windows.map((window) => bar(window, bucket.id)))
      .filter((entry): entry is UsageBar => entry !== null),
    hasReading: !!reading?.value,
    hasUnmeasuredScopedLimit: (reading?.value?.buckets ?? []).some((bucket) => bucket.modelScope && !bucket.windows.length),
    foreign,
    reason: reading?.reason ?? 'Claude plan usage is unavailable. The credentials file or filesystem permission may be unavailable.',
  };
}
