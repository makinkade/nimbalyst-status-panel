/**
 * Cover for GET-84's second half: with the usage data unavailable, the panel
 * has to degrade quietly rather than narrate.
 *
 * `invoke` warns, because a channel failing under a one-shot caller is worth
 * seeing. The plan usage client is not that caller -- it asks for two files a
 * minute forever -- so it uses `invokeQuiet`, and a host that cannot answer
 * must not produce a warning per poll.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  extractLastReadAt,
  extractTokenUsage,
  getFocusedSession,
  invoke,
  invokeQuiet,
  selectedSessionId,
} from './ipc';

const WS = 'C:' + String.fromCharCode(92) + 'ws';

const bridgeInvoke = vi.fn();
let warn: ReturnType<typeof vi.spyOn>;
let debug: ReturnType<typeof vi.spyOn>;

function installBridge(): void {
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: { invoke: bridgeInvoke, on: vi.fn() },
  };
}

beforeEach(() => {
  bridgeInvoke.mockReset();
  installBridge();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('invoke', () => {
  it('passes the channel and arguments through and returns the answer', async () => {
    bridgeInvoke.mockResolvedValue({ success: true });

    await expect(invoke('read-global-claude-file', '.credentials.json')).resolves.toEqual({
      success: true,
    });
    expect(bridgeInvoke).toHaveBeenCalledWith('read-global-claude-file', '.credentials.json');
  });

  it('warns and returns null when the channel throws', async () => {
    bridgeInvoke.mockRejectedValue(new Error('No handler registered'));

    await expect(invoke('sessions:list')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('invokeQuiet', () => {
  it('logs a failing channel at debug rather than warning', async () => {
    bridgeInvoke.mockRejectedValue(new Error('No handler registered'));

    await expect(invokeQuiet('read-global-claude-file', '.credentials.json')).resolves.toBeNull();
    // A poller hitting a host that cannot answer would otherwise leave a
    // warning a minute in the console for as long as the panel is open.
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledOnce();
  });
});

describe('no bridge', () => {
  // A renderer always has a `window`; what it may not have is `electronAPI`,
  // on a host that loaded the panel without the preload bridge.
  it('returns null without logging, either way', async () => {
    (globalThis as unknown as { window: unknown }).window = {};

    await expect(invoke('sessions:list')).resolves.toBeNull();
    await expect(invokeQuiet('read-global-claude-file', '.credentials.json')).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });
});

/**
 * Session resolution over IPC -- since GET-86 dropped the database permission,
 * `sessions:list` + `sessions:get` is the only path there is.
 *
 * The shapes below are the host's, not invented: `sessions:list` answers
 * `{ success, sessions }` whose entries always carry `messageCount: 0` and
 * `metadata: {}`, and whose `updatedAt` is `GREATEST(own, newest child)`.
 * `sessions:get` answers `{ success, session }` with the row itself.
 */
describe('getFocusedSession', () => {
  const CONTEXT = { currentContext: { tokens: 60_435, contextWindow: 200_000 } };

  /** A `sessions:list` entry exactly as the host projects one. */
  function entry(over: Record<string, unknown>) {
    return {
      id: 'x',
      title: 'Untitled Session',
      provider: 'claude-code',
      messageCount: 0, // never computed by the list query
      childCount: 0,
      metadata: {}, // hardcoded empty by the handler's projection
      ...over,
    };
  }

  function route(sessions: unknown[], records: Record<string, unknown>) {
    bridgeInvoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'sessions:list') return { success: true, sessions };
      if (channel === 'sessions:get') {
        const session = records[args[0] as string];
        return session ? { success: true, session } : { success: false, session: null };
      }
      return null;
    });
  }

  it('still finds a session even though every entry reports zero messages', async () => {
    // The old screen was `messageCount !== 0`, which discarded the whole list.
    route([entry({ id: 'a', updatedAt: 200 })], {
      a: { id: 'a', model: 'claude-opus-5', updatedAt: 200, metadata: { tokenUsage: CONTEXT } },
    });

    const session = await getFocusedSession('C:\ws');

    expect(session?.id).toBe('a');
  });

  it('carries currentContext.tokens through the round trip', async () => {
    route([entry({ id: 'a', updatedAt: 200 })], {
      a: { id: 'a', updatedAt: 200, metadata: { tokenUsage: CONTEXT } },
    });

    const session = await getFocusedSession('C:\ws');

    // The context bar reads this, not the cumulative `totalTokens`.
    expect(extractTokenUsage(session)?.currentContext?.tokens).toBe(60_435);
  });

  it('settles a leaf at the top of the list with a single lookup', async () => {
    // Nothing can have bubbled past an entry with no children, so the rest of
    // the list does not need resolving.
    route(
      [entry({ id: 'a', updatedAt: 200 }), entry({ id: 'b', updatedAt: 100 })],
      {
        a: { id: 'a', updatedAt: 200, metadata: { tokenUsage: CONTEXT } },
        b: { id: 'b', updatedAt: 100, metadata: { tokenUsage: CONTEXT } },
      },
    );

    const session = await getFocusedSession('C:\ws');

    expect(session?.id).toBe('a');
    const gets = bridgeInvoke.mock.calls.filter(([channel]) => channel === 'sessions:get');
    expect(gets).toHaveLength(1);
  });

  it('skips a workstream root that its children floated to the top', async () => {
    // `root` sorts first because the list reports the newest child's timestamp
    // as its own. Its real row is older and has no token usage at all.
    route(
      [
        entry({ id: 'root', updatedAt: 300, childCount: 2 }),
        entry({ id: 'child', updatedAt: 300 }),
        entry({ id: 'other', updatedAt: 120 }),
      ],
      {
        root: { id: 'root', updatedAt: 10, metadata: {} },
        child: { id: 'child', updatedAt: 300, metadata: { tokenUsage: CONTEXT } },
        other: { id: 'other', updatedAt: 120, metadata: { tokenUsage: CONTEXT } },
      },
    );

    const session = await getFocusedSession('C:\ws');

    expect(session?.id).toBe('child');
  });

  it('falls back to the newest record when nothing has token usage yet', async () => {
    // A workspace whose only sessions are brand new still has to name one.
    route(
      [
        entry({ id: 'root', updatedAt: 300, childCount: 1 }),
        entry({ id: 'fresh', updatedAt: 250 }),
      ],
      {
        root: { id: 'root', updatedAt: 10, metadata: {} },
        fresh: { id: 'fresh', updatedAt: 250, metadata: {} },
      },
    );

    const session = await getFocusedSession('C:\ws');

    expect(session?.id).toBe('fresh');
  });

  it('keeps the list entry when the record lookup fails', async () => {
    route([entry({ id: 'a', title: 'Only the list answered', updatedAt: 200 })], {});

    const session = await getFocusedSession('C:\ws');

    expect(session?.title).toBe('Only the list answered');
  });

  it('returns nothing when the workspace has no sessions', async () => {
    route([], {});

    await expect(getFocusedSession('C:\ws')).resolves.toBeNull();
  });
});

/**
 * GET-102: the panel has to describe the session you switched to, not whichever
 * one is being written to hardest.
 *
 * `selectedWorkstream` is what `persistSelectedWorkstream` writes through
 * `workspace:update-state` on every selection change, and `workstreamStates` /
 * `worktreeActiveSessions` are the maps that resolve a group selection down to
 * the session actually on screen. The shapes below are copied from a real
 * `workspace:get-state` answer.
 */
describe('selectedSessionId', () => {
  it('returns nothing when the workspace has never had a selection', () => {
    expect(selectedSessionId(null)).toBeNull();
    expect(selectedSessionId({})).toBeNull();
    expect(selectedSessionId({ agenticCodingWindowState: { selectedWorkstream: null } })).toBeNull();
  });

  it('takes a plain session selection at face value', () => {
    expect(
      selectedSessionId({
        agenticCodingWindowState: { selectedWorkstream: { type: 'session', id: 'a' } },
      }),
    ).toBe('a');
  });

  it('resolves a workstream selection to the child on screen', () => {
    // Selecting a workstream names the root; the transcript shows a child.
    expect(
      selectedSessionId({
        agenticCodingWindowState: { selectedWorkstream: { type: 'session', id: 'root' } },
        workstreamStates: { root: { activeChildId: 'child' } },
      }),
    ).toBe('child');
  });

  it('leaves a single session alone, whose activeChildId is its own id', () => {
    expect(
      selectedSessionId({
        agenticCodingWindowState: { selectedWorkstream: { type: 'session', id: 'a' } },
        workstreamStates: { a: { activeChildId: 'a' } },
      }),
    ).toBe('a');
  });

  it('resolves a worktree selection through worktreeActiveSessions', () => {
    expect(
      selectedSessionId({
        agenticCodingWindowState: { selectedWorkstream: { type: 'worktree', id: 'wt' } },
        worktreeActiveSessions: { wt: 'session-in-worktree' },
      }),
    ).toBe('session-in-worktree');
  });

  it('falls back to the group id when nothing resolves it further', () => {
    expect(
      selectedSessionId({
        agenticCodingWindowState: { selectedWorkstream: { type: 'worktree', id: 'wt' } },
      }),
    ).toBe('wt');
  });
});

describe('extractLastReadAt', () => {
  it('digs the value out of the nested metadata the host writes', () => {
    // `ai:updateSessionMetadata` lands { hasUnread, lastReadAt } one level down.
    const session = {
      id: 'a',
      metadata: { metadata: { hasUnread: false, lastReadAt: 1_790_106_673_359 } },
    };

    expect(extractLastReadAt(session)).toBe(1_790_106_673_359);
  });

  it('reads a session that has never been opened as unread', () => {
    expect(extractLastReadAt({ id: 'a', metadata: {} })).toBeNull();
    expect(extractLastReadAt(null)).toBeNull();
  });
});

describe('getFocusedSession with a selection', () => {
  const CONTEXT = { currentContext: { tokens: 60_435, contextWindow: 200_000 } };

  function entry(over: Record<string, unknown>) {
    return { id: 'x', provider: 'claude-code', messageCount: 0, childCount: 0, metadata: {}, ...over };
  }

  function route(sessions: unknown[], records: Record<string, unknown>) {
    bridgeInvoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'sessions:list') return { success: true, sessions };
      if (channel === 'sessions:get') {
        const session = records[args[0] as string];
        return session ? { success: true, session } : { success: false, session: null };
      }
      return null;
    });
  }

  /** A workspace state carrying nothing but a plain session selection. */
  function selecting(id: string) {
    return { agenticCodingWindowState: { selectedWorkstream: { type: 'session', id } } };
  }

  it('describes the selected session, not the one being written to', async () => {
    // The bug: 'busy' has the newest timestamp because an agent is working in
    // it, but the user is looking at 'reading'.
    route(
      [entry({ id: 'busy', updatedAt: 500 }), entry({ id: 'reading', updatedAt: 100 })],
      {
        busy: { id: 'busy', updatedAt: 500, metadata: { tokenUsage: CONTEXT } },
        reading: { id: 'reading', updatedAt: 100, metadata: { tokenUsage: CONTEXT } },
      },
    );

    const session = await getFocusedSession(WS, selecting('reading'));

    expect(session?.id).toBe('reading');
  });

  it('settles the selected session without resolving the rest of the list', async () => {
    // A root in front is what forces the fallback to resolve every candidate;
    // knowing the selection means one lookup settles it instead.
    route(
      [
        entry({ id: 'root', updatedAt: 500, childCount: 2 }),
        entry({ id: 'busy', updatedAt: 500 }),
        entry({ id: 'reading', updatedAt: 100 }),
      ],
      {
        root: { id: 'root', updatedAt: 10, metadata: {} },
        busy: { id: 'busy', updatedAt: 500, metadata: { tokenUsage: CONTEXT } },
        reading: { id: 'reading', updatedAt: 100, metadata: { tokenUsage: CONTEXT } },
      },
    );

    const session = await getFocusedSession(WS, selecting('reading'));

    expect(session?.id).toBe('reading');
    const gets = bridgeInvoke.mock.calls.filter(([channel]) => channel === 'sessions:get');
    expect(gets).toHaveLength(1);
  });

  it('falls back to the heuristic when the selection names an unlisted session', async () => {
    // Stale selection, or one pointing outside the listed window.
    route([entry({ id: 'a', updatedAt: 200 })], {
      a: { id: 'a', updatedAt: 200, metadata: { tokenUsage: CONTEXT } },
    });

    const session = await getFocusedSession(WS, selecting('long-gone'));

    expect(session?.id).toBe('a');
  });

  it('falls through a selected workstream root with no conversation in it', async () => {
    // Selecting a root before opening any of its children would otherwise put
    // a session with no token usage on the strip.
    route(
      [entry({ id: 'root', updatedAt: 300, childCount: 2 }), entry({ id: 'child', updatedAt: 300 })],
      {
        root: { id: 'root', updatedAt: 10, metadata: {} },
        child: { id: 'child', updatedAt: 300, metadata: { tokenUsage: CONTEXT } },
      },
    );

    const session = await getFocusedSession(WS, selecting('root'));

    expect(session?.id).toBe('child');
  });

  it('keeps a selected leaf that simply has not been talked to yet', async () => {
    // No children, so the root screen does not apply -- a session you just
    // opened is exactly the one to describe.
    route([entry({ id: 'old', updatedAt: 900 }), entry({ id: 'fresh', updatedAt: 10 })], {
      old: { id: 'old', updatedAt: 900, metadata: { tokenUsage: CONTEXT } },
      fresh: { id: 'fresh', updatedAt: 10, metadata: {} },
    });

    const session = await getFocusedSession(WS, selecting('fresh'));

    expect(session?.id).toBe('fresh');
  });
});

/**
 * With no selection persisted, read state is the next best proxy -- but only as
 * a group, so background writes cannot take the strip.
 */
describe('getFocusedSession read-state fallback', () => {
  const CONTEXT = { currentContext: { tokens: 60_435, contextWindow: 200_000 } };

  function entry(over: Record<string, unknown>) {
    return { id: 'x', provider: 'claude-code', messageCount: 0, childCount: 0, metadata: {}, ...over };
  }

  function route(sessions: unknown[], records: Record<string, unknown>) {
    bridgeInvoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'sessions:list') return { success: true, sessions };
      if (channel === 'sessions:get') {
        const session = records[args[0] as string];
        return session ? { success: true, session } : { success: false, session: null };
      }
      return null;
    });
  }

  it('prefers the session last opened over one an agent is writing to', async () => {
    // 'background' has never been opened, so its fresh updatedAt must not
    // outrank the session that was actually read.
    route(
      [
        entry({ id: 'root', updatedAt: 900, childCount: 2 }),
        entry({ id: 'background', updatedAt: 900 }),
        entry({ id: 'read', updatedAt: 100 }),
      ],
      {
        root: { id: 'root', updatedAt: 10, metadata: {} },
        background: { id: 'background', updatedAt: 900, metadata: { tokenUsage: CONTEXT } },
        read: {
          id: 'read',
          updatedAt: 100,
          metadata: { tokenUsage: CONTEXT, metadata: { lastReadAt: 500 } },
        },
      },
    );

    const session = await getFocusedSession(WS, null);

    expect(session?.id).toBe('read');
  });

  it('takes the most recently opened of several read sessions', async () => {
    route(
      [
        entry({ id: 'root', updatedAt: 900, childCount: 2 }),
        entry({ id: 'earlier', updatedAt: 900 }),
        entry({ id: 'later', updatedAt: 100 }),
      ],
      {
        root: { id: 'root', updatedAt: 10, metadata: {} },
        earlier: {
          id: 'earlier',
          updatedAt: 900,
          metadata: { tokenUsage: CONTEXT, metadata: { lastReadAt: 300 } },
        },
        later: {
          id: 'later',
          updatedAt: 100,
          metadata: { tokenUsage: CONTEXT, metadata: { lastReadAt: 700 } },
        },
      },
    );

    const session = await getFocusedSession(WS, null);

    expect(session?.id).toBe('later');
  });

  // The tray's clear-all-unread stamps one timestamp across every session, so
  // the tie has to be settled on merit rather than on whichever entry the list
  // happened to put first. Running both orderings is what distinguishes the
  // two -- a reduce with no tie-break just keeps the one it saw first.
  it.each([
    ['busier first', ['busier', 'quieter']],
    ['quieter first', ['quieter', 'busier']],
  ])('breaks a shared lastReadAt on updatedAt (%s)', async (_label, order) => {
    const rows: Record<string, unknown> = {
      root: { id: 'root', updatedAt: 10, metadata: {} },
      busier: {
        id: 'busier',
        updatedAt: 900,
        metadata: { tokenUsage: CONTEXT, metadata: { lastReadAt: 400 } },
      },
      quieter: {
        id: 'quieter',
        updatedAt: 100,
        metadata: { tokenUsage: CONTEXT, metadata: { lastReadAt: 400 } },
      },
    };

    route(
      [
        entry({ id: 'root', updatedAt: 900, childCount: 2 }),
        ...order.map((id) => entry({ id, updatedAt: 900 })),
      ],
      rows,
    );

    const session = await getFocusedSession(WS, null);

    expect(session?.id).toBe('busier');
  });
});
