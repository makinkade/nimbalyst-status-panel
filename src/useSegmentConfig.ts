import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_CONFIG, SegmentConfig, normalizeConfig } from './segments';

const STORAGE_KEY = 'segments';
/** Storage hydrates asynchronously; the app announces it on the window. */
const HYDRATED_EVENT = 'nimbalyst:extension-storage-hydrated';

export interface PanelStorage {
  getGlobal: (key: string) => unknown;
  setGlobal: (key: string, value: unknown) => Promise<void>;
}

/**
 * Segment visibility and order, persisted globally -- a display preference
 * should follow the user across workspaces rather than reset per project.
 */
export function useSegmentConfig(storage: PanelStorage | undefined) {
  const [config, setConfig] = useState<SegmentConfig>(() =>
    storage ? normalizeConfig(storage.getGlobal(STORAGE_KEY)) : { ...DEFAULT_CONFIG },
  );

  // A panel that mounts before storage hydrates reads nothing; re-read when the
  // app says the cache is warm.
  useEffect(() => {
    if (!storage) return;
    const reread = () => setConfig(normalizeConfig(storage.getGlobal(STORAGE_KEY)));
    window.addEventListener(HYDRATED_EVENT, reread);
    return () => window.removeEventListener(HYDRATED_EVENT, reread);
  }, [storage]);

  const update = useCallback(
    (next: SegmentConfig) => {
      setConfig(next);
      void storage?.setGlobal(STORAGE_KEY, next).catch((error) => {
        console.warn('[status-panel] failed to persist segment config:', error);
      });
    },
    [storage],
  );

  const reset = useCallback(() => update({ ...DEFAULT_CONFIG }), [update]);

  return { config, update, reset };
}
