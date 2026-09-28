/**
 * Model names, read off the id rather than looked up in a table.
 *
 * GET-111: this used to mirror Nimbalyst's `CLAUDE_CODE_MODEL_LABELS` /
 * `CLAUDE_CODE_VARIANT_VERSIONS`, which meant the chip went stale every time a
 * model shipped: `opus` meant Opus 5 in the table long after it resolved to
 * Opus 5.5. A session's own id cannot fix that -- `claude-code:opus-1m` is an
 * alias for "the current Opus", with no version in it at all.
 *
 * What does carry the version is the model the API actually served. Every
 * assistant turn records it (`message.model`, e.g. `claude-opus-5-5`), and the
 * id spells family and version out in a stable shape, so it can be parsed
 * instead of listed. A model released tomorrow reads correctly with no change
 * here. See `modelLabel` for how the served id and the session's alias are
 * combined, and `latestServedModel` in `ipc.ts` for where the served id comes
 * from.
 */

export interface ModelIdentity {
  /** `Opus`, `Sonnet`, `Haiku`, `Fable` -- title-cased from the id. */
  family: string;
  /** `5.5`, `4.8`; null for a bare alias that names no version. */
  version: string | null;
  /** The `-1m` / `[1m]` long-context variant. */
  oneMillion: boolean;
}

/** An 8-digit snapshot date, as in `claude-haiku-4-5-20251001`. */
const DATE_SUFFIX = /-\d{8}$/;
/** Version parts are short; anything longer is a date or not a version at all. */
const VERSION_PART = /^\d{1,3}$/;
const WORD = /^[a-z]+$/;

/**
 * Split a Claude model id into family and version.
 *
 * Accepts the served shape (`claude-opus-5-5`, `claude-haiku-4-5-20251001`,
 * the older `claude-3-5-sonnet-20241022`) and Nimbalyst's session shape
 * (`claude-code:opus-1m`, `claude-code:opus-4-8`, `claude-code:sonnet`).
 *
 * Only Claude ids are parsed -- a `claude-code:` prefix, or an id that starts
 * with `claude-`. Anything else returns null so the caller shows the raw id:
 * `openai-codex:gpt-6` would otherwise come out as a confident `Gpt 6`, and
 * that is a label for somebody else's naming scheme, not ours to invent.
 *
 * An id with more than one word in it is rejected too, rather than guessed at.
 * Nothing Claude-shaped has one today, and a wrong label is worse than the raw
 * id, which is at least true.
 */
export function parseModelId(id: string | null | undefined): ModelIdentity | null {
  if (!id) return null;

  let rest = id.trim().toLowerCase();

  const colon = rest.indexOf(':');
  if (colon >= 0) {
    const provider = rest.slice(0, colon);
    if (provider !== 'claude-code' && provider !== 'claude') return null;
    rest = rest.slice(colon + 1);
  } else if (!rest.startsWith('claude-')) {
    return null;
  }

  if (rest.startsWith('claude-')) rest = rest.slice('claude-'.length);

  let oneMillion = false;
  if (rest.endsWith('[1m]')) {
    oneMillion = true;
    rest = rest.slice(0, -'[1m]'.length);
  }
  if (rest.endsWith('-1m')) {
    oneMillion = true;
    rest = rest.slice(0, -'-1m'.length);
  }
  rest = rest.replace(DATE_SUFFIX, '');

  const words: string[] = [];
  const version: string[] = [];
  for (const part of rest.split('-')) {
    if (VERSION_PART.test(part)) version.push(part);
    else if (WORD.test(part)) words.push(part);
    else return null;
  }
  if (words.length !== 1) return null;

  const [word] = words;
  return {
    family: word.charAt(0).toUpperCase() + word.slice(1),
    version: version.length ? version.join('.') : null,
    oneMillion,
  };
}

function format({ family, version }: ModelIdentity, oneMillion: boolean): string {
  return `${family}${version ? ` ${version}` : ''}${oneMillion ? ' (1M)' : ''}`;
}

export interface ModelLabelInputs {
  /** The session's model, as Nimbalyst records it: `claude-code:opus-1m`. */
  sessionModel?: string | null;
  /** The model the latest main-thread turn was served by: `claude-opus-5-5`. */
  servedModel?: string | null;
  /** Nimbalyst's own name for `sessionModel`, when its catalog has one. */
  catalogName?: string | null;
}

/**
 * The label for the model chip.
 *
 * In order of how much each source can be trusted to be current:
 *
 * 1. **A pinned alias** (`opus-4-8`, `fable-5`) names its version in the id,
 *    and a pin is exact by definition. Nothing else can know better.
 * 2. **The served model**, for a bare alias (`opus`) -- but only when its
 *    family matches the alias. Switch a session from Sonnet to Opus and the
 *    newest turn on record is still Sonnet's until the next reply; reading
 *    `Sonnet 5` off it beside an Opus session would be exactly wrong.
 * 3. **Nimbalyst's catalog name.** Maintained by hand upstream, so it can lag a
 *    release, but it is the best available before the session's first reply.
 * 4. **The bare alias**, with no version: `Opus (1M)`. Honest about knowing
 *    only the family, rather than claiming a version that may be stale.
 * 5. **The raw id**, for anything that is not a Claude model at all.
 *
 * The `(1M)` marker always comes from the session's alias: the served id does
 * not carry the context variant, and the alias is what chose it.
 */
export function modelLabel({ sessionModel, servedModel, catalogName }: ModelLabelInputs): string | null {
  const alias = parseModelId(sessionModel);
  const oneMillion = alias?.oneMillion ?? false;

  if (alias?.version) return format(alias, oneMillion);

  const served = parseModelId(servedModel);
  if (served?.version && (!alias || alias.family === served.family)) {
    return format(served, oneMillion);
  }

  if (catalogName) return catalogName;
  if (alias) return format(alias, oneMillion);
  return sessionModel || null;
}
