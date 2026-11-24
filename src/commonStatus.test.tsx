import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildSegments } from './StatusPanel';
import { normalizeModels, latestServedModel, type SessionRecord } from './lib/ipc';
import { normalizeSessionStatus, type SessionInputs } from './lib/providerAdapters';
import { measured } from './lib/statusModel';
import { permissionModeLabel } from './lib/format';
import { MUTED } from './lib/thresholds';
import { SEGMENT_IDS, type SegmentId } from './segments';

const fixture = JSON.parse(readFileSync(new URL('./lib/fixtures/status-host-0.83.0.json', import.meta.url), 'utf8'));
const payload = (channel: string, index = 0) => fixture.observations.filter((row: { channel: string }) => row.channel === channel)[index].payload;
const codex: SessionRecord = payload('sessions:get').session;
const claude: SessionRecord = payload('sessions:get', 1).session;
const models = normalizeModels(payload('ai:getModels'));
const workspacePath = '<workspace>';
const now = Date.parse(fixture.provenance.capturedAt);

function data(session: SessionRecord | null = codex, overrides: Partial<SessionInputs> = {}) {
  return normalizeSessionStatus({ workspacePath, session, models, defaultEffort: 'high', permissionMode: null,
    workspacePolicy: payload('workspace:get-state').agentPermissions && {
      mode: payload('workspace:get-state').agentPermissions.permissionMode,
      allowAllUsesClassifier: payload('workspace:get-state').agentPermissions.allowAllUsesClassifier,
    }, now, ...overrides });
}
function render(readings = data(), id: SegmentId = 'model', folder = workspacePath) {
  const status = { workspacePath: folder, readings, loading: false,
    git: { repoPath: folder || null, branch: folder ? 'master' : null, dirtyCount: 2 } };
  return renderToStaticMarkup(<>{buildSegments(status, folder)[id]}</>);
}
function served(session: SessionRecord, value: string) {
  return measured(value, 'test-verified-reply', { kind: 'session', provider: session.provider ?? null,
    sessionId: session.id, workspacePath }, null, now);
}

describe('common cards with sanitized real Claude/Codex payloads', () => {
  it('shows the supplied Codex catalog name and preserves exact requested ID/provider', () => {
    const html = render();
    expect(html).toContain('>GPT-6.1 Sol<');
    expect(html).toContain(`Requested model: ${codex.model}`);
    expect(html).toContain('Provider: openai-codex');
    expect(html).toContain('No verified served model');
  });

  it('keeps the served Claude version rather than an outdated alias display name', () => {
    const value = latestServedModel(payload('transcript:get-tail-messages', 1))!;
    const readings = data(claude, { servedModel: served(claude, value) });
    expect(render(readings)).toContain('>Opus 5.5 (1M)<');
    expect(render(readings)).toContain('Last observed reply served by: claude-opus-5-5');
  });

  it('uses the observed context window, not output limits or billed/cache totals', () => {
    const html = render(data(), 'context');
    expect(html).toContain('124.7K of 475.0K tokens in context');
    expect(html).toContain('26%');
    expect(html).toContain('Cumulative total: 8,946,657 tokens');
    expect(html).toContain('Cache read input: 8,803,200 tokens');
    expect(html).toContain('Provider cumulative input: 8,936,042 tokens');
    expect(html).not.toContain('of 128.0K');
  });

  it('keeps raw workspace policy apart from all unavailable execution fields', () => {
    const readings = data();
    expect(readings.workspacePolicy.value).toEqual({ mode: 'bypass-all', allowAllUsesClassifier: true });
    const html = render(readings, 'permissionMode');
    expect(html).toContain('Workspace: Agent-verified');
    expect(html).toContain('Automatic review: on');
    for (const field of ['Provider approval policy', 'Approval reviewer', 'Session sandbox', 'Filesystem access', 'Network access']) {
      expect(html).toContain(`${field}: not reported`);
    }
    expect(html).not.toContain('workspace-write');
    expect(html).not.toContain('on-request');
  });
});

describe('source-derived provider capabilities and synthetic future/custom cases', () => {
  // GET-222 verified these capabilities in the host source, not live sessions.
  it.each(['copilot-cli', 'cursor-agent'])('keeps %s configured identity honest and effort/context unsupported', (provider) => {
    const session = { id: 'source-example', provider, model: `${provider}:Future_Model`,
      metadata: { tokenUsage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } } };
    const readings = data(session);
    expect(readings.effort.state).toBe('unsupported');
    expect(readings.context.state).toBe('unsupported');
    expect(render(readings, 'effort')).toContain('Effort —');
    expect(render(readings, 'context')).not.toContain('sp-bar');
    expect(render(readings)).toContain(`Requested model: ${session.model}`);
    expect(render(readings, 'context').includes('Total 0') || render(readings, 'context').includes('↑0')).toBe(provider === 'cursor-agent');
  });

  it.each(['lmstudio', 'custom-local', 'vendor-from-the-future', undefined])('renders a useful whole strip for %s without inferring quota or effort', (provider) => {
    const session = { id: 'synthetic', provider, model: 'Future_Model/V2.17_Q8', metadata: {
      tokenUsage: { totalTokens: 9000, currentContext: { tokens: 0, contextWindow: 2000 } },
    } };
    const readings = data(session);
    for (const id of SEGMENT_IDS) expect(render(readings, id)).not.toBe('');
    expect(render(readings)).toContain('>Future Model V2.17 Q8<');
    expect(render(readings)).toContain('Requested model: Future_Model/V2.17_Q8');
    expect(render(readings, 'effort')).toContain('Effort —');
    expect(render(readings, 'context')).toContain('0%');
    expect(render(readings, 'directory')).toContain('&lt;workspace&gt;');
    expect(render(readings, 'branch')).toContain('master');
    expect(render(readings, 'branch')).toContain('±2');
  });

  it('uses explicit custom configured effort but never inherits an unrelated app default', () => {
    const session = { id: 'custom', provider: 'custom', model: 'local:new', metadata: { effortLevel: 'medium' } };
    expect(render(data(session), 'effort')).toContain('>Medium<');
    expect(render(data(session), 'effort')).toContain('this session&#x27;s own setting');
    expect(data({ ...session, metadata: {} }).effort.value).toBeNull();
  });

  it.each(['claude-code:unknown-new-family', 'claude-code:opus-99-9'])('does not default effort for an unverified Claude model %s', (model) => {
    expect(data({ id: 'unknown', provider: 'claude-code', model }).effort.value).toBeNull();
  });

  it('distinguishes session effort, app defaults and audited built-in defaults', () => {
    expect(render(data(), 'effort')).toContain('>High<');
    const unconfigured = { ...codex, metadata: {} };
    expect(render(data(unconfigured, { defaultEffort: 'low' }), 'effort')).toContain('Low (default)');
    expect(render(data(unconfigured, { defaultEffort: 'low' }), 'effort')).toContain('the app default');
    expect(render(data(unconfigured, { defaultEffort: null }), 'effort')).toContain('High (default)');
    expect(render(data(unconfigured, { defaultEffort: null }), 'effort')).toContain('built-in default');
    expect(render(data(), 'effort')).toContain('effective effort is not reported');
  });

  it('shows configured pin and last reply separately without claiming rerouting', () => {
    const session = { ...claude, model: 'claude-code:opus-4-8' };
    const html = render(data(session, { servedModel: served(session, 'claude-opus-5-5') }));
    expect(html).toContain('>Last reply: Opus 5.5<');
    expect(html).toContain('Requested model: claude-code:opus-4-8');
    expect(html).toContain('not proof that the current requested model has answered');
  });

  it('keeps a different-family historical reply visible without presenting it as the requested model', () => {
    const html = render(data(claude, { servedModel: served(claude, 'claude-sonnet-5') }));
    expect(html).toContain('>Last reply: Sonnet 5 (1M requested)<');
    expect(html).toContain(`Requested model: ${claude.model}`);
    expect(html).toContain('1M variant is requested');
  });

  it('uses a served catalog name only when it matches the actual served ID/provider', () => {
    const session = { id: 'future', provider: 'custom', model: 'custom:requested' };
    const html = render(data(session, { servedModel: served(session, 'custom:served'), models: [
      { id: session.model, provider: 'custom', name: 'Requested Display' },
      { id: 'custom:served', provider: 'custom', name: 'Served Display' },
      { id: 'custom:served', provider: 'other', name: 'Wrong Provider' },
    ] }));
    expect(html).toContain('>Last reply: Served Display<');
    expect(html).not.toContain('Wrong Provider');
  });

  it('mutes and labels an old reply rather than dropping its identity', () => {
    const reading = { ...served(claude, 'claude-opus-5-5'), state: 'stale' as const, value: 'claude-opus-5-5', reason: 'The latest transcript has no model' };
    const html = render(data(claude, { servedModel: reading }));
    expect(html).toContain('Last reply: Opus 5.5');
    expect(html).toContain(MUTED);
    expect(html).toContain('Stale model reading');
  });

  it.each([
    ['ask', undefined, 'Ask'], ['allow-all', undefined, 'Allow all'],
    ['bypass-all', false, 'Bypass'], ['bypass-all', true, 'Agent-verified'],
    ['futurePolicy', undefined, 'futurePolicy'], ['acceptEdits', undefined, 'acceptEdits'],
  ] as const)('keeps workspace policy %s / %s distinct', (mode, classifier, label) => {
    expect(permissionModeLabel(mode, classifier)).toBe(label);
    expect(render(data(null, { workspacePolicy: { mode, allowAllUsesClassifier: classifier } }), 'permissionMode')).toContain(`Workspace: ${label}`);
  });

  it('does not treat an absent classifier flag as off', () => {
    expect(render(data(null, { workspacePolicy: { mode: 'bypass-all' } }), 'permissionMode')).toContain('Automatic review setting is not reported');
  });

  it('shows zero and partial token counters without inventing missing output', () => {
    const readings = data({ id: 'zero', provider: 'custom', metadata: { tokenUsage: {
      inputTokens: 0, currentContext: { tokens: 0, contextWindow: 2000 },
    } } });
    const html = render(readings, 'context');
    expect(html).toContain('0%');
    expect(html).toContain('↑0');
    expect(html).not.toContain('↓0');
    expect(html).not.toContain('Cumulative output:');
  });

  it('shows measured occupancy with no window and never substitutes billed tokens', () => {
    const readings = data({ id: 'unknown-window', provider: 'custom', metadata: { tokenUsage: {
      totalTokens: 9000, currentContext: { tokens: 100 },
    } } });
    const html = render(readings, 'context');
    expect(html).toContain('>100 tokens<');
    expect(html).toContain('Total 9.0K');
    expect(html).toContain('capacity is not reported');
    expect(html).not.toContain('sp-bar');
    expect(html).not.toContain('of 0');
  });

  it('keeps billed, cached and reasoning counters when there is no context snapshot', () => {
    const html = render(data({ id: 'counts', provider: 'custom', metadata: { tokenUsage: {
      totalTokens: 100, cacheCreationInputTokens: 0, reasoningTokens: 50,
    } } }), 'context');
    expect(html).toContain('Context —');
    expect(html).toContain('Total 100');
    expect(html).toContain('Cache creation input: 0 tokens');
    expect(html).toContain('Reasoning: 50 tokens');
    expect(html).not.toContain('sp-bar');
  });

  it('rejects invalid counts and capacities at the normalizer boundary', () => {
    const readings = data({ id: 'invalid', provider: 'custom', metadata: { tokenUsage: {
      inputTokens: -1, outputTokens: Number.NaN, contextWindow: -1,
      currentContext: { tokens: Number.POSITIVE_INFINITY, contextWindow: 0 },
    } } });
    expect(readings.context.value).toBeNull();
    expect(readings.tokens.value).toBeNull();
    expect(render(readings, 'context')).not.toContain('sp-bar');
  });

  it('explains every configured card with no session, model, folder or repository', () => {
    for (const session of [null, { id: 'bare' }]) {
      const readings = data(session, { workspacePolicy: null });
      for (const id of SEGMENT_IDS) expect(render(readings, id, '')).not.toBe('');
      expect(render(readings, 'directory', '')).toContain('No folder');
      expect(render(readings, 'branch', '')).toContain('No repo');
      expect(render(readings, 'model', '')).toContain(session ? 'Model —' : 'No session');
      expect(render(readings, 'effort', '')).toContain('Effort —');
      expect(render(readings, 'permissionMode', '')).toContain('Workspace —');
    }
  });

  it('keeps stale common readings muted with their reasons', () => {
    const readings = data();
    readings.context = { ...readings.context, state: 'stale', value: readings.context.value!, reason: 'Refresh failed' };
    readings.tokens = { ...readings.tokens, state: 'stale', value: readings.tokens.value!, reason: 'Refresh failed' };
    readings.effort = { ...readings.effort, state: 'stale', value: readings.effort.value!, reason: 'Refresh failed' };
    readings.workspacePolicy = { ...readings.workspacePolicy, state: 'stale', value: readings.workspacePolicy.value!, reason: 'Refresh failed' };
    for (const id of ['context', 'effort', 'permissionMode'] as const) {
      const html = render(readings, id);
      expect(html).toContain(MUTED);
      expect(html).toContain('Refresh failed');
    }
  });
});
