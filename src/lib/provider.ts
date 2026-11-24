/**
 * Which provider is behind the focused session.
 *
 * The plan-usage chips read Anthropic's endpoint with your Claude OAuth token,
 * so they describe your Claude plan whatever session is in front of you. Beside
 * a Codex session that is a claim the strip is not making on purpose, and the
 * colour makes it worse -- a red `5h 91%` next to a session it does not govern
 * reads as urgency about *that* session. This names the case so the chips can
 * say whose plan they are about (GET-103).
 */

import type { ModelInfo, SessionRecord } from './ipc';
import type { ProviderIdentity } from './statusModel';

export const CLAUDE_PROVIDER = 'claude-code';

/**
 * `session.provider` when the record carries one, else the `provider:variant`
 * prefix of the model id -- Nimbalyst writes both (`claude-code` /
 * `claude-code:opus-1m`, `openai-codex` / `openai-codex:gpt-5.6-luna`), but a
 * list entry that never resolved through `sessions:get` may have only the model.
 */
export function providerIdentity(session: SessionRecord | null, models: ModelInfo[] = []): ProviderIdentity {
  if (!session) return { id: null, source: 'unknown' };

  if (typeof session.provider === 'string' && session.provider.trim()) {
    return { id: session.provider.trim(), source: 'session' };
  }
  const catalog = models.filter((entry) => entry.id === session.model && entry.provider);
  const providers = new Set(catalog.map((entry) => entry.provider));
  if (providers.size === 1) return { id: catalog[0].provider, source: 'catalog' };

  const model = session.model;
  if (typeof model === 'string' && model.includes(':')) {
    const prefix = model.slice(0, model.indexOf(':'));
    if (prefix) return { id: prefix, source: 'prefix' };
  }

  return { id: null, source: 'unknown' };
}

export function sessionProvider(session: SessionRecord | null): string | null {
  return providerIdentity(session).id;
}

/**
 * The provider to disclaim the Claude plan chips against, or null when there is
 * nothing to disclaim.
 *
 * GET-223: an unknown session is not a Claude session. Keep the old no-session
 * plan view, but qualify/mute it when a selected session's owner is unknown.
 */
export function foreignProvider(session: SessionRecord | null): string | null {
  const provider = sessionProvider(session);
  if (!session || provider === CLAUDE_PROVIDER) return null;
  return provider ?? 'unknown provider';
}
