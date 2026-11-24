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
 * with `claude-`. Other naming schemes use their supplied catalog name or
 * conservative separator formatting, without interpreting a version.
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
  /** A supplied name for the served ID, never the requested alias's name. */
  servedCatalogName?: string | null;
}

/**
 * GET-224: cosmetic formatting only, without inventing a vendor display name.
 * Preserve case, dots, digits and snapshot dates. The exact ID stays in the
 * model tooltip; separators are the only information removed from the label.
 */
export function readableModelId(id: string): string {
  return id.trim().replace(/[:/_-]+/g, ' ').replace(/\s+/g, ' ').trim() || id.trim();
}

/**
 * A served identity wins over a requested pin when it has actually been read.
 * This formats identities, not their time/correlation: modelPresentation labels
 * disagreements as "Last reply" so an old turn cannot impersonate a new request.
 * The `(1M)` marker describes the requested variant, not a served capacity.
 */
export function modelLabel({ sessionModel, servedModel, catalogName, servedCatalogName }: ModelLabelInputs): string | null {
  const alias = parseModelId(sessionModel);
  const oneMillion = alias?.oneMillion ?? false;
  const served = parseModelId(servedModel);
  if (servedModel?.trim()) {
    // Claude's concrete ID avoids outdated version names in the host catalog.
    if (served?.version) return format(served, oneMillion);
    return servedCatalogName?.trim() && servedCatalogName.trim() !== servedModel.trim()
      ? servedCatalogName.trim() : readableModelId(servedModel);
  }
  if (alias?.version) return format(alias, oneMillion);
  if (catalogName?.trim() && catalogName.trim() !== sessionModel?.trim()) return catalogName.trim();
  if (alias) return format(alias, oneMillion);
  return sessionModel?.trim() ? readableModelId(sessionModel) : null;
}
