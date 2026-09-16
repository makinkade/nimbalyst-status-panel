import type { ReactNode } from 'react';
import { BAR_LENGTH, barFill } from '../lib/thresholds';

interface ChipProps {
  icon: string;
  accent: string;
  children: ReactNode;
  title?: string;
}

/**
 * One status-line segment. The accent color carries the same meaning as the
 * segment background in the terminal; the chip itself stays on the app's
 * surface colors so it themes with Nimbalyst.
 */
export function Chip({ icon, accent, children, title }: ChipProps) {
  return (
    <div className="sp-chip" style={{ borderColor: accent }} title={title}>
      <span className="material-symbols-outlined sp-chip-icon" style={{ color: accent }}>
        {icon}
      </span>
      <span className="sp-chip-body">{children}</span>
    </div>
  );
}

interface BarProps {
  percent: number;
  color: string;
}

/** The 10-cell block bar, rendered as elements rather than U+2588/U+2591. */
export function Bar({ percent, color }: BarProps) {
  const filled = barFill(percent);
  return (
    <span className="sp-bar" role="img" aria-label={`${Math.round(percent)} percent`}>
      {Array.from({ length: BAR_LENGTH }, (_, index) => (
        <span
          key={index}
          className="sp-bar-cell"
          style={{ background: index < filled ? color : 'var(--nim-bg-tertiary)' }}
        />
      ))}
    </span>
  );
}
