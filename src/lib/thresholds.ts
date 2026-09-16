/**
 * Colors and thresholds ported from statusline.ps1 so a bar that is red in the
 * terminal is red here too. The palette is the script's (Night Owl), kept
 * literal rather than themed for exactly that reason.
 */

export const PALETTE = {
  green: '#addb67',
  yellow: '#e4cf6a',
  red: '#ef5350',
  teal: '#21c7a8',
  blue: '#82AAFF',
  purple: '#c792ea',
  light: '#d6deeb',
  navy: '#011627',
} as const;

/** Context bar: green < 50 %, yellow 50-70 %, red > 70 %. */
export function contextColor(percent: number): string {
  if (percent > 70) return PALETTE.red;
  if (percent >= 50) return PALETTE.yellow;
  return PALETTE.green;
}

/** Plan usage bars: green < 50 %, yellow 50-80 %, red > 80 %. */
export function usageColor(percent: number): string {
  if (percent > 80) return PALETTE.red;
  if (percent >= 50) return PALETTE.yellow;
  return PALETTE.green;
}

export function permissionModeColor(label: string): string {
  switch (label) {
    case 'Plan':
      return PALETTE.purple;
    case 'Auto':
      return PALETTE.yellow;
    case 'Bypass':
      return PALETTE.red;
    default:
      return PALETTE.light;
  }
}

export const BAR_LENGTH = 10;

/** Filled-cell count for a percentage, clamped to the bar. */
export function barFill(percent: number, length = BAR_LENGTH): number {
  const filled = Math.round((percent / 100) * length);
  return Math.min(Math.max(filled, 0), length);
}
