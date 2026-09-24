import { describe, expect, it } from 'vitest';
import {
  CLOSE_GESTURE_WINDOW_MS,
  MAX_REOPEN_ATTEMPTS,
  createPanelKeeper,
} from './panelKeeper';

/**
 * GET-107: the host dismisses every bottom panel on each mode set, so the
 * strip goes when you leave Agent Mode and does not come back when you return.
 * The keeper restores it -- without fighting a user who closed it on purpose,
 * and without stacking itself on top of whatever else holds the bottom slot.
 *
 * The state machine takes its whole view of the world through `PanelKeeperEnv`,
 * so a fake slot is the entire fixture: `open` is our strip being on screen,
 * `taken` is the terminal or another bottom panel holding the slot, and
 * `requestOpen` is what the real one turns into a toggle event.
 */
function fakeSlot({ open = false, taken = false } = {}) {
  const slot = {
    open,
    taken,
    /** Reopen requests the keeper has made. */
    opens: 0,
    /** Does a reopen request actually put the panel back? */
    hostHonoursOpen: true,
    time: 1_000,
  };

  const keeper = createPanelKeeper({
    isPanelOpen: () => slot.open,
    isSlotTaken: () => slot.taken,
    requestOpen: () => {
      slot.opens += 1;
      if (slot.hostHonoursOpen) slot.open = true;
    },
    now: () => slot.time,
  });

  return { slot, keeper };
}

describe('panel keeper', () => {
  it('puts the panel back when the host dismisses it', () => {
    const { slot, keeper } = fakeSlot({ open: true });
    keeper.check();

    // A mode switch: the host nulls the bottom panel id, nobody asked it to.
    slot.open = false;
    keeper.check();

    expect(slot.opens).toBe(1);
    expect(slot.open).toBe(true);
  });

  it('leaves it closed when the user closes it', () => {
    const { slot, keeper } = fakeSlot({ open: true });
    keeper.check();

    // Ctrl+Shift+S, or the gutter button.
    keeper.noteCloseGesture();
    slot.open = false;
    keeper.check();

    expect(slot.opens).toBe(0);

    // And stays closed through everything that follows, including the mode
    // switches that would otherwise be a dismissal to undo.
    slot.time += 10_000;
    keeper.check();
    keeper.check();
    expect(slot.opens).toBe(0);
  });

  it('starts restoring again once the user reopens it', () => {
    const { slot, keeper } = fakeSlot({ open: true });
    keeper.check();
    keeper.noteCloseGesture();
    slot.open = false;
    keeper.check();
    expect(slot.opens).toBe(0);

    // The user opens it again -- that is a fresh statement of intent.
    slot.open = true;
    slot.time += 5_000;
    keeper.check();

    slot.open = false;
    keeper.check();
    expect(slot.opens).toBe(1);
  });

  it('treats a disappearance long after a gesture as a dismissal', () => {
    const { slot, keeper } = fakeSlot({ open: true });
    keeper.check();

    // A gesture that did not close the panel: the panel is still there on the
    // next check, so the gesture is spent and a later dismissal is restored.
    keeper.noteCloseGesture();
    slot.time += CLOSE_GESTURE_WINDOW_MS + 1;
    keeper.check();

    slot.open = false;
    keeper.check();
    expect(slot.opens).toBe(1);
  });

  it('does nothing until the panel has been open once', () => {
    // `autoOpen` off, panel never opened: there is nothing to restore.
    const { slot, keeper } = fakeSlot({ open: false });
    keeper.check();
    keeper.check();

    expect(slot.opens).toBe(0);
  });

  it('stays out of the way while something else holds the slot', () => {
    const { slot, keeper } = fakeSlot({ open: true });
    keeper.check();

    // The terminal opens, or Git Log replaces us; the host closed our panel to
    // make room, and reopening would stack two panels.
    slot.open = false;
    slot.taken = true;
    keeper.check();
    keeper.check();
    expect(slot.opens).toBe(0);

    // Once the slot is free again, the strip comes back.
    slot.taken = false;
    keeper.check();
    expect(slot.opens).toBe(1);
    expect(slot.open).toBe(true);
  });

  it('gives up rather than asking forever when the host will not open it', () => {
    const { slot, keeper } = fakeSlot({ open: true });
    keeper.check();

    slot.hostHonoursOpen = false;
    slot.open = false;
    for (let i = 0; i < MAX_REOPEN_ATTEMPTS + 5; i += 1) keeper.check();

    expect(slot.opens).toBe(MAX_REOPEN_ATTEMPTS);
  });
});
