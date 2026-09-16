import { StatusPanel } from './StatusPanel';

export const panels = {
  'status-line': { component: StatusPanel },
};

const EXTENSION_ID = 'com.mkinkade.status-panel';
const PANEL_ID = `${EXTENSION_ID}.status-line`;
const GUTTER_SELECTOR = `[data-testid="extension-bottom-panel-${PANEL_ID}"]`;

/**
 * Read the `autoOpen` preference the config popover writes.
 *
 * `activate()` gets an `ExtensionContext`, whose `services` are filesystem /
 * ui / ai / configuration -- storage is a panel-only prop, so the host object
 * the popover uses isn't reachable here. Global extension storage is persisted
 * in app-settings under `extensionStorage`, keyed `ext:<extensionId>:<key>`
 * (see `createExtensionStorage`), so read it directly over IPC instead. That
 * also sidesteps the hydration race `getGlobal` has.
 */
async function readAutoOpenPreference(): Promise<boolean> {
  const invoke = (window as any).electronAPI?.invoke;
  if (typeof invoke !== 'function') return true;

  try {
    const store = await invoke('app-settings:get', 'extensionStorage');
    const config = store?.[`ext:${EXTENSION_ID}:segments`];
    const value = config?.autoOpen;
    // Absent until the user touches the setting -- default to opening.
    return typeof value === 'boolean' ? value : true;
  } catch (error) {
    console.warn('[status-panel] could not read autoOpen preference:', error);
    return true;
  }
}

/**
 * Open the panel on startup.
 *
 * Nimbalyst only restores `placement: "sidebar"` extension panels across
 * restarts -- `loadActiveExtensionPanel` filters the persisted id through
 * `isSidebarPanel`, and the bottom-panel id is never persisted at all. So a
 * bottom panel always comes back closed and there is no manifest flag to
 * change that. The host registers `${panelId}.toggle` as a command whose only
 * action is dispatching a DOM event, which we can dispatch ourselves.
 *
 * The listener is mounted by a React effect in the app shell, so firing too
 * early silently does nothing. Waiting for our own gutter button to appear
 * proves the panel registry synced and the shell is mounted.
 */
function autoOpenPanel(timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;

  const attempt = () => {
    // Already open (reactivation, or the user beat us to it) -- toggling now
    // would close it.
    if (document.querySelector('.sp-strip')) return;

    if (document.querySelector(GUTTER_SELECTOR)) {
      window.dispatchEvent(
        new CustomEvent('nimbalyst:toggle-panel', { detail: { panelId: PANEL_ID } }),
      );
      return;
    }

    if (Date.now() < deadline) {
      requestAnimationFrame(attempt);
    } else {
      console.warn('[status-panel] gutter button never appeared; skipping auto-open');
    }
  };

  requestAnimationFrame(attempt);
}

export async function activate() {
  console.log('[status-panel] activated');

  if (await readAutoOpenPreference()) {
    autoOpenPanel();
  }
}

export async function deactivate() {
  console.log('[status-panel] deactivated');
}
