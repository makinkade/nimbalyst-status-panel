import { describe, expect, it } from 'vitest';
import { foreignProvider, sessionProvider } from './provider';
import type { SessionRecord } from './ipc';

describe('sessionProvider', () => {
  it('prefers the record field', () => {
    expect(sessionProvider({ id: 'a', provider: 'openai-codex' })).toBe('openai-codex');
  });

  it('falls back to the model id prefix when no provider field survived', () => {
    // `sessions:list` entries reach the panel without going through
    // `sessions:get`, and the model id is the other half of the same fact.
    expect(sessionProvider({ id: 'a', model: 'openai-codex:gpt-5.6-luna' })).toBe('openai-codex');
    expect(sessionProvider({ id: 'a', model: 'claude-code:opus-1m' })).toBe('claude-code');
  });

  it('reports nothing it cannot actually tell', () => {
    expect(sessionProvider(null)).toBeNull();
    expect(sessionProvider({ id: 'a' })).toBeNull();
    // A bare model id with no `provider:` prefix names no provider.
    expect(sessionProvider({ id: 'a', model: 'gpt-5.6-luna' })).toBeNull();
  });
});

describe('foreignProvider', () => {
  it('names a non-Claude provider', () => {
    expect(foreignProvider({ id: 'a', provider: 'openai-codex' })).toBe('openai-codex');
  });

  it('is null for a Claude session, which is what the plan bars are about', () => {
    expect(foreignProvider({ id: 'a', provider: 'claude-code' })).toBeNull();
  });

  it('is null when there is nothing to disclaim against', () => {
    // No session, or a session whose provider cannot be determined: the bars
    // are simply your plan, and muting them on a missing field would demote
    // the ordinary case on a technicality.
    expect(foreignProvider(null)).toBeNull();
    expect(foreignProvider({ id: 'a' } as SessionRecord)).toBeNull();
  });
});
