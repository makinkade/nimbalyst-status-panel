import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type SegmentConfig } from './segments';
import { observeSegmentConfig } from './useSegmentConfig';

describe('production segment storage hydration', () => {
  it('migrates the hydrated preferences without writing defaults and detaches on cleanup', () => {
    let stored: unknown;
    const storage = { getGlobal: vi.fn(() => stored), setGlobal: vi.fn(async () => {}) };
    const events = new EventTarget();
    const changed = vi.fn<(config: SegmentConfig) => void>();
    const stop = observeSegmentConfig(storage, changed, events);
    expect(changed).toHaveBeenLastCalledWith(DEFAULT_CONFIG);
    expect(storage.setGlobal).not.toHaveBeenCalled();
    stored = { order: ['usage7d', 'model', 'usage5h', 'usageScoped'], hidden: ['usage5h'],
      autoOpen: false, checkForUpdates: false };
    events.dispatchEvent(new Event('nimbalyst:extension-storage-hydrated'));
    expect(changed.mock.lastCall?.[0]).toMatchObject({ version: 2, hidden: ['usagePrimary'],
      autoOpen: false, checkForUpdates: false });
    expect(changed.mock.lastCall?.[0].order.slice(0, 4)).toEqual(['usageSecondary', 'model', 'usagePrimary', 'usageAdditional']);
    expect(storage.getGlobal).toHaveBeenLastCalledWith('segments');
    expect(storage.setGlobal).not.toHaveBeenCalled();
    stop();
    events.dispatchEvent(new Event('nimbalyst:extension-storage-hydrated'));
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
