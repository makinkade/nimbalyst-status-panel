import type { UsageCard } from '../lib/usagePresentation';
import { MUTED, NEUTRAL, usageColor } from '../lib/thresholds';
import { Bar, Chip } from './Chip';

/** GET-225: quantity-only cards carry no invented percentage or urgency. */
export function UsageChip({ card }: { card: UsageCard }) {
  const color = card.muted ? MUTED : card.percent !== null ? usageColor(card.percent) : NEUTRAL;
  return (
    <Chip icon={card.icon} accent={color} title={card.title} className="sp-usage-chip">
      <span className="sp-label">{card.label}</span>
      {card.percent !== null && <Bar percent={card.percent} color={color} label={`${Math.round(card.percent)} percent used`} />}
      {card.value !== null && <span className="sp-value">{card.value}{card.cached ? ' (cached)' : card.stale ? ' (stale)' : ''}</span>}
      {card.reset && <span className="sp-reset">↻ {card.reset}</span>}
    </Chip>
  );
}
