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

import { extractTokenUsage, getFocusedSession, invoke, invokeQuiet } from './ipc';

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
 * GET-85: the panel with the database path off, running on `sessions:list` +
 * `sessions:get` alone.
 *
 * The shapes below are the host's, not invented: `sessions:list` answers
 * `{ success, sessions }` whose entries always carry `messageCount: 0` and
 * `metadata: {}`, and whose `updatedAt` is `GREATEST(own, newest child)`.
 * `sessions:get` answers `{ success, session }` with the row itself.
 */
describe('getFocusedSession without database access', () => {
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
