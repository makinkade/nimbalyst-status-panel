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
  /**
   * Night Owl's foreground and background. Kept so the port is a complete
   * record of the script's palette, but neither is an accent: they are a
   * matched pair meant for each other, so against the *host's* surfaces they
   * have almost no contrast at all. Use NEUTRAL or MUTED instead.
   */
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
      // `Default` is a known value, not an unvouched-for one, so it takes the
      // theme's foreground rather than MUTED -- see NEUTRAL below.
      return NEUTRAL;
  }
}

/**
 * For values the panel cannot vouch for (stale readings, unavailable data).
 *
 * Deliberately not PALETTE.light: that is Night Owl's foreground, meant to sit
 * on dark navy, and it disappears against a light theme -- a filled bar drawn
 * in it reads as an empty one. This follows the host theme instead.
 */
export const MUTED = 'var(--nim-text-muted)';

/**
 * For values that are known and simply unremarkable -- the `Default` permission
 * mode being the only one so far.
 *
 * PALETTE.light is Night Owl's *foreground*, and using it as an accent is the
 * same mistake MUTED was introduced to fix one layer down: at 1.2:1 against the
 * light theme's chip surface the icon and accent border vanish, so the chip
 * reads as though it had no accent at all while every neighbour has one. The
 * themed foreground is what PALETTE.light was reaching for, and it stays legible
 * on both themes by construction.
 *
 * Deliberately not MUTED: that means "the panel cannot vouch for this", and a
 * known mode must not look like the `Mode -` placeholder standing in for a
 * missing one.
 */
export const NEUTRAL = 'var(--nim-text)';

export const BAR_LENGTH = 10;

/** Filled-cell count for a percentage, clamped to the bar. */
export function barFill(percent: number, length = BAR_LENGTH): number {
  const filled = Math.round((percent / 100) * length);
  return Math.min(Math.max(filled, 0), length);
}
