/**
 * Keep the bottom panel on screen across dismissals nobody asked for.
 *
 * GET-107: leaving Agent Mode for Files Mode or Settings and coming back
 * leaves the strip gone, and only Ctrl+Shift+S brings it back. The cause is in
 * the host, not here: `setWindowMode` calls `dismissExtensionPanels`, which
 * nulls the sidebar *and* bottom panel ids on every mode set -- including
 * setting the mode it is already in, which is how the history button and the
 * tracker-navigation handler can lose the panel without any mode changing.
 * Nothing restores it afterwards, and a bottom panel id is never persisted, so
 * there is no host-side setting that would keep ours up.
 *
 * That leaves noticing and reopening. The hard part is telling a dismissal
 * apart from the user closing the panel on purpose -- reopening the latter
 * would make the panel impossible to close. There are exactly two ways to
 * close ours: the `<panelId>.toggle` command behind Ctrl+Shift+S, and the
 * panel's button in the bottom gutter. (The `host.close()` a panel can call on
 * itself is the third, and `StatusPanel` never calls it.) Both are gestures we
 * can see in the DOM, so the caller reports them and every *other*
 * disappearance is one to undo.
 *
 * The slot can also be taken over without our panel being closed: the host
 * keeps the terminal and bottom panels mutually exclusive, and another bottom
 * panel -- Git Log -- replaces ours outright. While either holds the slot we
 * stay out of the way, and take it back once it is free.
 *
 * The state machine is separated from the DOM so it can be tested against a
 * plain fake; `index.ts` supplies the real selectors and events.
 */

export interface PanelKeeperEnv {
  /** Is our own strip on screen right now? */
  isPanelOpen(): boolean;
  /** Does something else -- another bottom panel, or the terminal -- hold the bottom slot? */
  isSlotTaken(): boolean;
  /** Ask the host to put our panel back. */
  requestOpen(): void;
  now(): number;
}

/**
 * How long after a closing gesture a disappearance still counts as that
 * gesture's doing. One React commit, with room to spare.
 */
export const CLOSE_GESTURE_WINDOW_MS = 1_000;

/**
 * Consecutive reopen attempts that change nothing before we stop asking.
 * A dismissal normally costs one attempt and the panel is back by the next
 * check, so a run of them means the host is declining -- during a workspace
 * swap, say, when there is no workspace path to render a panel for. Retrying
 * forever would be a loop; the user opening the panel again clears it.
 */
export const MAX_REOPEN_ATTEMPTS = 3;

export interface PanelKeeper {
  /** Record that the user just did something that closes the panel. */
  noteCloseGesture(): void;
  /** Re-examine the slot, and restore the panel if it was taken from us. */
  check(): void;
}

export function createPanelKeeper(env: PanelKeeperEnv): PanelKeeper {
  // Nothing to restore until the panel has actually been seen open: that is
  // what tells us the user wants it there. It also keeps us quiet when the
  // `autoOpen` preference is off and the panel was never opened at all.
  let wanted = false;
  let gestureAt: number | null = null;
  let attempts = 0;

  return {
    noteCloseGesture() {
      gestureAt = env.now();
    },

    check() {
      if (env.isPanelOpen()) {
        wanted = true;
        gestureAt = null;
        attempts = 0;
        return;
      }

      if (!wanted) return;
      if (env.isSlotTaken()) return;

      if (gestureAt !== null && env.now() - gestureAt < CLOSE_GESTURE_WINDOW_MS) {
        // The user closed it. Leave it closed until they open it again.
        wanted = false;
        gestureAt = null;
        return;
      }

      if (attempts >= MAX_REOPEN_ATTEMPTS) {
        wanted = false;
        attempts = 0;
        console.warn('[status-panel] gave up reopening the panel; the host kept it closed');
        return;
      }

      attempts += 1;
      env.requestOpen();
    },
  };
}
