import { createPanelKeeper, PanelKeeper } from './panelKeeper';
import { StatusPanel } from './StatusPanel';

export const panels = {
  'status-line': { component: StatusPanel },
};

const EXTENSION_ID = 'com.mkinkade.status-panel';
const PANEL_ID = `${EXTENSION_ID}.status-line`;
const GUTTER_SELECTOR = `[data-testid="extension-bottom-panel-${PANEL_ID}"]`;
const TOGGLE_EVENT = 'nimbalyst:toggle-panel';

/** Our own strip, rendered by `StatusPanel`. */
const STRIP_SELECTOR = '.sp-strip';
/** The host's wrapper around whichever extension bottom panel is showing. */
const BOTTOM_PANEL_SELECTOR = '.bottom-panel-container';
/**
 * The terminal's bottom panel. Always in the document -- it hides itself with
 * `display: none` rather than unmounting -- so its visibility has to be read
 * off the element, not from whether it exists.
 */
const TERMINAL_SELECTOR = '.terminal-bottom-panel-container';

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

function isPanelOpen(): boolean {
  return !!document.querySelector(STRIP_SELECTOR);
}

/** Ask the host to show our panel. Only valid while it is closed. */
function requestOpen(): void {
  window.dispatchEvent(new CustomEvent(TOGGLE_EVENT, { detail: { panelId: PANEL_ID } }));
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
    if (isPanelOpen()) return;

    if (document.querySelector(GUTTER_SELECTOR)) {
      requestOpen();
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

/**
 * Is the bottom slot spoken for by something that isn't us?
 *
 * Both cases are the host's own arrangement rather than anything to correct:
 * opening the terminal closes whichever bottom panel was showing, and opening
 * Git Log replaces it. Reopening ours over either would stack two panels.
 */
function isSlotTaken(): boolean {
  const panel = document.querySelector(BOTTOM_PANEL_SELECTOR);
  if (panel && !panel.querySelector(STRIP_SELECTOR)) return true;

  const terminal = document.querySelector<HTMLElement>(TERMINAL_SELECTOR);
  return !!terminal && terminal.style.display !== 'none';
}

/**
 * How often to re-check the slot unprompted.
 *
 * The mutation observers below do the real work, and react within a frame so
 * the strip does not visibly blink on a mode switch. This is the backstop for
 * a layout that doesn't match what they look for -- and it retries attaching
 * them, since the elements they watch only exist once a workspace is open. Two
 * `querySelector` calls a second costs nothing.
 */
const BACKSTOP_INTERVAL_MS = 1_000;

/**
 * Watch the bottom slot and put our panel back when it is taken from us.
 *
 * Returns a function that stops watching. See `panelKeeper.ts` for why this is
 * needed at all, and how a host dismissal is told apart from the user closing
 * the panel.
 */
function keepPanelOpen(): () => void {
  const keeper: PanelKeeper = createPanelKeeper({
    isPanelOpen,
    isSlotTaken,
    requestOpen,
    now: () => Date.now(),
  });

  const check = () => keeper.check();

  // Ctrl+Shift+S, and anything else that runs the toggle command. Only a
  // closing gesture while the panel is open -- when it is closed this same
  // event is what opens it, our own `requestOpen` included.
  const onToggle = (event: Event) => {
    const panelId = (event as CustomEvent).detail?.panelId;
    if (panelId === PANEL_ID && isPanelOpen()) keeper.noteCloseGesture();
  };
  window.addEventListener(TOGGLE_EVENT, onToggle);

  // The panel's button in the bottom gutter. Captured, so it is recorded
  // before React's own handler closes the panel.
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(GUTTER_SELECTOR) && isPanelOpen()) keeper.noteCloseGesture();
  };
  document.addEventListener('click', onClick, true);

  let observers: MutationObserver[] = [];
  let watched: { terminal: HTMLElement; column: Element } | null = null;

  const disconnect = () => {
    observers.forEach((observer) => observer.disconnect());
    observers = [];
    watched = null;
  };

  /**
   * Observe the two elements that can change under us, and nothing else.
   *
   * The bottom panel mounts and unmounts as a direct child of the main column,
   * so a non-subtree `childList` observer there sees it come and go without
   * paying for every mutation the editor makes. The terminal is a sibling that
   * toggles its own inline `display`, so its style attribute is watched
   * separately.
   */
  const ensureObservers = () => {
    if (watched && document.contains(watched.terminal) && document.contains(watched.column)) {
      return;
    }
    disconnect();

    const terminal = document.querySelector<HTMLElement>(TERMINAL_SELECTOR);
    const column = terminal?.parentElement;
    if (!terminal || !column) return;

    const slot = new MutationObserver(check);
    slot.observe(column, { childList: true });
    const visibility = new MutationObserver(check);
    visibility.observe(terminal, { attributes: true, attributeFilter: ['style'] });

    observers = [slot, visibility];
    watched = { terminal, column };
  };

  const backstop = setInterval(() => {
    ensureObservers();
    check();
  }, BACKSTOP_INTERVAL_MS);

  return () => {
    clearInterval(backstop);
    disconnect();
    window.removeEventListener(TOGGLE_EVENT, onToggle);
    document.removeEventListener('click', onClick, true);
  };
}

let stopKeepingPanelOpen: (() => void) | null = null;

export async function activate() {
  console.log('[status-panel] activated');

  // A reload activates without deactivating first; don't leave the previous
  // watcher running beside the new one.
  stopKeepingPanelOpen?.();
  stopKeepingPanelOpen = keepPanelOpen();

  if (await readAutoOpenPreference()) {
    autoOpenPanel();
  }
}

export async function deactivate() {
  console.log('[status-panel] deactivated');
  stopKeepingPanelOpen?.();
  stopKeepingPanelOpen = null;
}
