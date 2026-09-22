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

import type { SessionRecord } from './ipc';

export const CLAUDE_PROVIDER = 'claude-code';

/**
 * `session.provider` when the record carries one, else the `provider:variant`
 * prefix of the model id -- Nimbalyst writes both (`claude-code` /
 * `claude-code:opus-1m`, `openai-codex` / `openai-codex:gpt-5.6-luna`), but a
 * list entry that never resolved through `sessions:get` may have only the model.
 */
export function sessionProvider(session: SessionRecord | null): string | null {
  if (!session) return null;

  if (typeof session.provider === 'string' && session.provider) return session.provider;

  const model = session.model;
  if (typeof model === 'string' && model.includes(':')) {
    const prefix = model.slice(0, model.indexOf(':'));
    if (prefix) return prefix;
  }

  return null;
}

/**
 * The provider to disclaim the Claude plan chips against, or null when there is
 * nothing to disclaim.
 *
 * Only a *positive* non-Claude signal degrades the chips. No session at all, or
 * a session whose provider cannot be determined, leaves them as they were: with
 * no competing model on screen the bars are simply your plan, and demoting them
 * on a missing field would mute the common case on a technicality.
 */
export function foreignProvider(session: SessionRecord | null): string | null {
  const provider = sessionProvider(session);
  if (provider === null || provider === CLAUDE_PROVIDER) return null;
  return provider;
}
