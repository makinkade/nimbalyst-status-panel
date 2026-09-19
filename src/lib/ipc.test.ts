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

import { invoke, invokeQuiet } from './ipc';

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
