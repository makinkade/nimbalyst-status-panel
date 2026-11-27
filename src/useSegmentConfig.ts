import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_CONFIG, SegmentConfig, normalizeConfig } from './segments';

const STORAGE_KEY = 'segments';
/** Storage hydrates asynchronously; the app announces it on the window. */
const HYDRATED_EVENT = 'nimbalyst:extension-storage-hydrated';

export interface PanelStorage {
  getGlobal: (key: string) => unknown;
  setGlobal: (key: string, value: unknown) => Promise<void>;
}

/** GET-225: hydration reads migrate in memory; only an explicit edit writes. */
export function observeSegmentConfig(storage: PanelStorage, changed: (config: SegmentConfig) => void,
  events: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const reread = () => changed(normalizeConfig(storage.getGlobal(STORAGE_KEY)));
  events.addEventListener(HYDRATED_EVENT, reread);
  // Also handles replacing the panel's storage prop after its initial render.
  reread();
  return () => events.removeEventListener(HYDRATED_EVENT, reread);
}

/**
 * Segment visibility and order, persisted globally -- a display preference
 * should follow the user across workspaces rather than reset per project.
 */
export function useSegmentConfig(storage: PanelStorage | undefined) {
  const [config, setConfig] = useState<SegmentConfig>(() =>
    normalizeConfig(storage?.getGlobal(STORAGE_KEY)),
  );

  // A panel that mounts before storage hydrates reads nothing; re-read when the
  // app says the cache is warm.
  useEffect(() => {
    if (!storage) return;
    return observeSegmentConfig(storage, setConfig);
  }, [storage]);

  const update = useCallback(
    (next: SegmentConfig) => {
      const normalized = normalizeConfig(next);
      setConfig(normalized);
      void storage?.setGlobal(STORAGE_KEY, normalized).catch((error) => {
        console.warn('[status-panel] failed to persist segment config:', error);
      });
    },
    [storage],
  );

  const reset = useCallback(() => update(normalizeConfig(DEFAULT_CONFIG)), [update]);

  return { config, update, reset };
}
