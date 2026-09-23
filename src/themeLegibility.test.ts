/**
 * GET-97: nothing the strip draws may be a colour picked for one theme.
 *
 * The bug this guards against has already happened once: a bar drawn in
 * `PALETTE.light` -- Night Owl's *foreground*, a near-white -- against the
 * light theme's near-white chip surface, which made a full bar read as an empty
 * one. MUTED fixed that instance by following the host theme. This locks the
 * rule in rather than the instance, because the same literal was still reachable
 * from `permissionModeColor`, where `Default` (the most common mode of all) got
 * an icon and accent border at 1.2:1 against the surface they sit on.
 *
 * The rule: a colour that has to stay legible on *both* themes cannot be a hex
 * literal, because a literal cannot know which theme it is on. It has to be a
 * `var(--nim-*)`, which by construction is whatever that theme made legible.
 * The chromatic palette entries are exempt -- green/yellow/red carry a meaning
 * ported from the terminal, they are distinguished by hue rather than by
 * luminance, and a green bar is a green bar on either theme.
 */

import { describe, expect, it } from 'vitest';

import { MUTED, NEUTRAL, PALETTE, contextColor, permissionModeColor, usageColor } from './lib/thresholds';
import { permissionModeLabel } from './lib/format';

/** Every theme variable the panel is allowed to reach for as an accent. */
const THEMED = [MUTED, NEUTRAL];

/** The light theme's own defaults, read out of the host's CSS. */
const LIGHT = { surface: '#f9fafb', cell: '#f3f4f6' };

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio; 3:1 is the floor for icons, borders and other non-text. */
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/**
 * How much colour a hex has, as the spread between its channels.
 *
 * The companion to `contrast`, and the reason this file does not simply assert
 * a contrast ratio everywhere. Contrast is luminance-only, so it scores a
 * saturated purple and a near-white grey about alike against white -- yet one
 * is obviously there and the other is not. A neutral colour has only luminance
 * to be seen by; a chromatic one also has hue.
 */
function chroma(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b);
}

describe('the permission-mode accent', () => {
  it('follows the theme for Default rather than using a near-white literal', () => {
    // The regression itself. `#d6deeb` on `#f9fafb` is 1.2:1 -- the chip reads
    // as having no accent at all while every chip beside it has one.
    expect(permissionModeColor('Default')).toBe(NEUTRAL);
    expect(contrast(PALETTE.light, LIGHT.surface)).toBeLessThan(3);
  });

  it('separates a known-but-unremarkable value from one it cannot vouch for', () => {
    // `Default` is a mode the panel actually read. If it shared MUTED with the
    // `Mode -` placeholder, a known mode and a missing one would look alike.
    expect(NEUTRAL).not.toBe(MUTED);
  });

  it('gives every mode Nimbalyst can be in a colour that survives both themes', () => {
    // Two ways to survive, and a colour needs exactly one of them: follow the
    // theme, or be chromatic enough that hue tells it apart where luminance
    // does not. `#c792ea` on white is only 2.2:1 and is still plainly purple;
    // `#d6deeb` is 1.2:1 and is plainly nothing. That difference -- not the
    // contrast ratio on its own -- is what the original bug turned on.
    for (const mode of ['ask', 'default', 'plan', 'auto', 'allow-all', 'bypass-all']) {
      const color = permissionModeColor(permissionModeLabel(mode));
      const survives = THEMED.includes(color) || chroma(color) > 60;
      expect(survives, `${mode} -> ${color} survives neither theme test`).toBe(true);
    }
  });

  it('rejects the literal that started this, by the same rule', () => {
    // The rule has to actually exclude something, or it is not a rule.
    expect(chroma(PALETTE.light)).toBeLessThan(60);
  });

  it('keeps the loud modes loud, in the palette they were ported in', () => {
    // Fixing the neutral case must not quietly neutralise the signalling ones.
    expect(permissionModeColor('Bypass')).toBe(PALETTE.red);
    expect(permissionModeColor('Plan')).toBe(PALETTE.purple);
    expect(permissionModeColor('Auto')).toBe(PALETTE.yellow);
  });
});

describe('the colours that stand in for missing or unvouched-for data', () => {
  it('are theme variables, not literals -- a literal cannot know its theme', () => {
    for (const color of THEMED) expect(color).toMatch(/^var\(--nim-[\w-]+\)$/);
  });
});

describe('the bar palette', () => {
  it('never draws a filled cell in a colour the unfilled cells are made of', () => {
    // The original bug in one line: the filled and unfilled halves of a bar
    // have to differ. `--nim-bg-tertiary` is the unfilled cell on both themes,
    // and a near-white accent against it is the failure.
    const fills = [0, 49, 50, 70, 71, 79, 80, 81, 100].flatMap((pct) => [
      contextColor(pct),
      usageColor(pct),
    ]);
    for (const fill of fills) {
      expect(fill, 'a bar fill must never be the near-white foreground').not.toBe(PALETTE.light);
      expect(fill).toMatch(/^#[0-9a-f]{6}$/i);
      // Chromatic, not neutral: the cell is told apart by hue where luminance
      // is close, which is exactly what `PALETTE.light` could not do.
      expect(chroma(fill)).toBeGreaterThan(60);
    }
  });

  it('keeps the muted bar readable against the light theme it broke on', () => {
    // The stale and foreign-provider bars render their *fill* in MUTED, so this
    // is the case the original bug actually hit. `--nim-text-muted` is `#6b7280`
    // on the light theme: 4.4:1 against the unfilled cell beside it.
    expect(contrast('#6b7280', LIGHT.cell)).toBeGreaterThan(3);
  });
});
