/**
 * The selection fast path.
 *
 * Switching sessions announces itself to nobody -- no DOM event, and the
 * `workspace:update-state` that records it sends renderer windows nothing -- so
 * the panel notices a switch only by asking. Asking on the 5 s refresh alone
 * left the strip trailing a switch by up to five seconds, which is what this
 * second, much cheaper timer exists to fix.
 *
 * The timer itself is not covered here: the suite runs in a node environment
 * with no DOM, and the hook's effects need one. What is covered is the decision
 * the timer makes on every tick, which is where the behaviour actually lives.
 */

import { describe, expect, it } from 'vitest';

import { shouldRefreshForSelection } from './useStatus';

describe('shouldRefreshForSelection', () => {
  it('refreshes when the selection has moved to another session', () => {
    expect(shouldRefreshForSelection('b', 'a')).toBe(true);
  });

  it('stays put while the selection is unchanged', () => {
    // The common case, once a second, for as long as the panel is open.
    expect(shouldRefreshForSelection('a', 'a')).toBe(false);
  });

  it('does not fire before the first full refresh has landed', () => {
    // `undefined` means "not known yet", not "nothing selected" -- firing here
    // would race the refresh already in flight from mount.
    expect(shouldRefreshForSelection('a', undefined)).toBe(false);
    expect(shouldRefreshForSelection(null, undefined)).toBe(false);
  });

  it('treats losing the selection as a change', () => {
    // A workspace whose selection was cleared still needs the strip re-resolved.
    expect(shouldRefreshForSelection(null, 'a')).toBe(true);
  });

  it('treats gaining a selection as a change', () => {
    expect(shouldRefreshForSelection('a', null)).toBe(true);
  });

  it('stays put when there is still nothing selected', () => {
    // Both null: a real observation that matches what the refresh acted on.
    // A truthiness check would misread this as a change and poll in a loop.
    expect(shouldRefreshForSelection(null, null)).toBe(false);
  });
});
