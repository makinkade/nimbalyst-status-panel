/**
 * Reconciling a stored config with the one this version knows about.
 *
 * `normalizeConfig` is the only thing standing between a config written by an
 * older build and the current segment set, and every failure mode it has is
 * silent: a dropped segment looks like one the user switched off, and a
 * behaviour flag read as `undefined` looks like one they switched off too. The
 * `checkForUpdates` flag GET-99 adds is the second of those and the sharper
 * one, because "off" for it means the panel quietly stops doing the thing it
 * was installed to start doing.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, SEGMENT_IDS, normalizeConfig } from './segments';

describe('a config saved before an option existed', () => {
  it('defaults the update check on rather than reading absent as off', () => {
    // The exact shape a 0.1.3 install has on disk: order and hidden, plus the
    // one behaviour flag that existed then.
    const stored = { order: [...SEGMENT_IDS], hidden: [], autoOpen: true };

    expect(normalizeConfig(stored).checkForUpdates).toBe(true);
  });

  it('keeps the flag off once the user has actually turned it off', () => {
    const stored = { order: [...SEGMENT_IDS], hidden: [], checkForUpdates: false };

    expect(normalizeConfig(stored).checkForUpdates).toBe(false);
  });

  it('defaults both behaviour flags on with nothing stored at all', () => {
    expect(normalizeConfig(undefined)).toMatchObject({
      autoOpen: DEFAULT_CONFIG.autoOpen,
      checkForUpdates: DEFAULT_CONFIG.checkForUpdates,
    });
  });

  it('ignores a non-boolean flag rather than coercing it', () => {
    // A hand-edited settings file, or a shape from some future version.
    expect(normalizeConfig({ checkForUpdates: 'yes' }).checkForUpdates).toBe(true);
  });

  it('still appends segments added since the config was written', () => {
    const stored = { order: ['model', 'branch'], hidden: [], autoOpen: false };

    const config = normalizeConfig(stored);

    expect(config.order.slice(0, 2)).toEqual(['model', 'branch']);
    expect(new Set(config.order)).toEqual(new Set(SEGMENT_IDS));
    expect(config.autoOpen).toBe(false);
  });
});
