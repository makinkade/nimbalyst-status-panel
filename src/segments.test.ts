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

import { DEFAULT_CONFIG, SEGMENT_IDS, USAGE_GROUP_IDS, moveSegment, normalizeConfig } from './segments';

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

describe('GET-225 global usage preference migration', () => {
  it('preserves exact interleaved positions, hidden choices and disabled behavior flags', () => {
    const config = normalizeConfig({ order: ['usage7d', 'branch', 'usage5h', 'model', 'usageScoped', 'context',
      'effort', 'directory', 'permissionMode'], hidden: ['usage7d', 'usageScoped', 'directory'],
    autoOpen: false, checkForUpdates: false });
    expect(config).toEqual({ version: 2, order: ['usageSecondary', 'branch', 'usagePrimary', 'model',
      'usageAdditional', 'context', 'effort', 'directory', 'permissionMode'],
    hidden: ['usageSecondary', 'usageAdditional', 'directory'], autoOpen: false, checkForUpdates: false });
    expect(normalizeConfig(config)).toEqual(config);
  });

  it.each(['usage5h', 'usage7d', 'usageScoped'])('keeps legacy hidden %s hidden after migration', (legacy) => {
    const mapping = { usage5h: 'usagePrimary', usage7d: 'usageSecondary', usageScoped: 'usageAdditional' };
    expect(normalizeConfig({ hidden: [legacy] }).hidden).toEqual([mapping[legacy as keyof typeof mapping]]);
  });

  it('keeps all usage groups hidden and deduplicates mixed aliases at the first position', () => {
    const config = normalizeConfig({ order: ['usage7d', 'model', 'usageSecondary', 'model', 'usage5h',
      'usagePrimary', 'usageScoped', 'usageAdditional'], hidden: ['usage5h', 'usagePrimary', 'usage7d', 'usageScoped'] });
    expect(config.order.slice(0, 4)).toEqual(['usageSecondary', 'model', 'usagePrimary', 'usageAdditional']);
    expect(new Set(config.order).size).toBe(SEGMENT_IDS.length);
    expect(config.hidden).toEqual([...USAGE_GROUP_IDS]);
  });

  it.each([null, undefined, [], false, 42, 'bad', { order: [null, {}, 'toString', '__proto__'], hidden: 'bad' }])(
    'tolerates malformed config %j and appends every stable group exactly once', (stored) => {
      expect(normalizeConfig(stored)).toEqual(DEFAULT_CONFIG);
    },
  );

  it('moves and resets migrated groups without sharing mutable default arrays', () => {
    const config = normalizeConfig({ order: ['usage5h', 'model'], hidden: ['usageScoped'] });
    expect(moveSegment(config.order, 'usagePrimary', 1).slice(0, 2)).toEqual(['model', 'usagePrimary']);
    const reset = normalizeConfig(DEFAULT_CONFIG);
    reset.order.reverse();
    reset.hidden.push('usagePrimary');
    expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.hidden).toEqual([]);
  });
});
