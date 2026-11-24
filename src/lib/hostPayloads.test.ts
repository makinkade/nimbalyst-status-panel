/**
 * GET-222: exercise the existing boundaries with sanitized real host payloads.
 * The fixture's projections/provenance are documented beside it. Selection
 * changes and deferred responses below are controlled tests, not claims that
 * the running panel was switched or that useStatus's lifecycle was exercised.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractTokenUsage,
  getDefaultEffortLevel,
  getFocusedSession,
  getServedModel,
  getWorkspacePolicy,
  invokeQuiet,
  resolveEffortLevel,
  selectedSessionId,
  type SessionRecord,
  type WorkspaceState,
} from './ipc';
import { sessionProvider } from './provider';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/status-host-0.83.0.json', import.meta.url), 'utf8'),
) as { observations: Array<{ channel: string; payload: unknown }> };

function payload<T>(channel: string, index = 0): T {
  const row = fixture.observations.filter((entry) => entry.channel === channel)[index];
  if (!row) throw new Error(`Missing host observation: ${channel} #${index}`);
  return row.payload as T;
}

const workspace = '<workspace>';
const state = payload<WorkspaceState>('workspace:get-state');
const listed = payload<{ success: boolean; sessions: SessionRecord[] }>('sessions:list');
const codex = payload<{ success: boolean; session: SessionRecord }>('sessions:get').session;
const claude = payload<{ success: boolean; session: SessionRecord }>('sessions:get', 1).session;
const bridgeInvoke = vi.fn();

function selecting(session: SessionRecord): WorkspaceState {
  return {
    ...state,
    agenticCodingWindowState: { selectedWorkstream: { type: 'session', id: session.id } },
  };
}

beforeEach(() => {
  bridgeInvoke.mockReset();
  bridgeInvoke.mockImplementation(async (channel: string, id?: string) => {
    if (channel === 'sessions:list') return listed;
    if (channel === 'sessions:get') {
      return { success: true, session: id === codex.id ? codex : claude };
    }
    if (channel === 'transcript:get-tail-messages') {
      return payload(channel, id === codex.id ? 0 : 1);
    }
    if (channel === 'settings:get-default-effort-level') return payload(channel);
    return payload(channel);
  });
  vi.stubGlobal('window', { electronAPI: { invoke: bridgeInvoke } });
});

afterEach(() => vi.unstubAllGlobals());

describe('Nimbalyst 0.83.0 runtime status payloads', () => {
  it('preserves the observed raw workspace mode and classifier flag', async () => {
    await expect(getWorkspacePolicy(state)).resolves.toEqual({ policy: {
      mode: 'bypass-all', allowAllUsesClassifier: true,
    }, source: 'workspace:get-state' });
    expect(bridgeInvoke).not.toHaveBeenCalled();
  });
  it('follows persisted selection when another provider has newer activity', async () => {
    expect(selectedSessionId(state)).toBe(codex.id);
    expect(Number(codex.updatedAt)).toBeGreaterThan(Number(claude.updatedAt));

    const first = await getFocusedSession(workspace, state);
    const second = await getFocusedSession(workspace, selecting(claude));

    expect(first?.id).toBe(codex.id);
    expect(sessionProvider(first)).toBe('openai-codex');
    expect(second?.id).toBe(claude.id);
    expect(sessionProvider(second)).toBe('claude-code');
    expect(extractTokenUsage(second)).toEqual(claude.metadata?.tokenUsage);
  });

  it('resolves each selection independently when full-record replies arrive out of order', async () => {
    let finishClaude!: (value: unknown) => void;
    let finishCodex!: (value: unknown) => void;
    const claudeReply = new Promise((resolve) => { finishClaude = resolve; });
    const codexReply = new Promise((resolve) => { finishCodex = resolve; });
    bridgeInvoke.mockImplementation((channel: string, id?: string) => {
      if (channel === 'sessions:list') return Promise.resolve(listed);
      return id === claude.id ? claudeReply : codexReply;
    });

    const oldSelection = getFocusedSession(workspace, selecting(claude));
    const newSelection = getFocusedSession(workspace, selecting(codex));
    finishCodex({ success: true, session: codex });
    expect((await newSelection)?.id).toBe(codex.id);
    finishClaude({ success: true, session: claude });
    expect((await oldSelection)?.id).toBe(claude.id);
    // Each resolver returns its own record. Discarding this late old selection
    // in the hook is a separate generation/lifecycle responsibility.
  });

  it('extracts current context without substituting cumulative or cached totals', () => {
    const usage = extractTokenUsage(codex);
    expect(usage?.currentContext).toEqual({ tokens: 124715, contextWindow: 475000 });
    expect(usage?.totalTokens).toBe(8946657);
    expect(usage?.inputTokens).toBe(132842);
    expect(usage?.outputTokens).toBe(10615);
    expect(extractTokenUsage(claude)?.currentContext).toEqual({
      tokens: 98005,
      contextWindow: 1000000,
    });
    expect(extractTokenUsage(listed.sessions[0])).toBeNull();
  });

  it('reads configured effort from the real full record and the bare default response', async () => {
    const appDefault = await getDefaultEffortLevel();
    expect(appDefault).toBe('high');
    expect(resolveEffortLevel(codex, appDefault)).toEqual({ level: 'high', source: 'session' });
    expect(resolveEffortLevel(listed.sessions[0], appDefault)).toEqual({
      level: 'high',
      source: 'app-default',
    });
  });

  it('finds the Claude served model and leaves the observed Codex model missing', async () => {
    await expect(getServedModel(claude.id)).resolves.toBe('claude-opus-5-5');
    await expect(getServedModel(codex.id)).resolves.toBeNull();
    expect(bridgeInvoke).toHaveBeenCalledWith('transcript:get-tail-messages', codex.id, 40);
  });

  it('preserves account and catalog shapes at the thin IPC boundary', async () => {
    const quota = payload('codex-usage:get');
    const catalog = payload('ai:getModels');
    await expect(invokeQuiet('codex-usage:get')).resolves.toBe(quota);
    await expect(invokeQuiet('ai:getModels')).resolves.toBe(catalog);
    // Normalization belongs to a source adapter. invoke must not silently turn
    // either a bare usage object or the catalog wrapper into another shape.
  });
});
