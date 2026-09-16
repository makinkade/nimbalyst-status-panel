/**
 * Friendly model names.
 *
 * Mirrors Nimbalyst's own `CLAUDE_CODE_MODEL_LABELS` / `CLAUDE_CODE_VARIANT_VERSIONS`
 * so `claude-code:opus-1m` reads as `Opus 5 (1M)` rather than the raw id. Used
 * when the model catalog has no entry for the session's id.
 */

const LABELS: Record<string, string> = {
  fable: 'Fable',
  'fable-5': 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  'opus-4-8': 'Opus',
  'opus-4-7': 'Opus',
  'opus-4-6': 'Opus',
  'sonnet-4-6': 'Sonnet',
};

const VERSIONS: Record<string, string> = {
  fable: '5.1',
  'fable-5': '5',
  opus: '5',
  sonnet: '5',
  haiku: '4.5',
  'opus-4-8': '4.8',
  'opus-4-7': '4.7',
  'opus-4-6': '4.6',
  'sonnet-4-6': '4.6',
};

/** `claude-code:opus-1m` -> `Opus 5 (1M)`; unknown ids come back unchanged. */
export function friendlyModelName(modelId: string | undefined): string | null {
  if (!modelId) return null;

  const [, variant] = modelId.includes(':') ? modelId.split(':', 2) : [null, modelId];
  if (!variant) return modelId;

  const is1m = variant.endsWith('-1m');
  const base = is1m ? variant.slice(0, -'-1m'.length) : variant;

  const label = LABELS[base];
  if (!label) return modelId;

  const version = VERSIONS[base];
  return `${label}${version ? ` ${version}` : ''}${is1m ? ' (1M)' : ''}`;
}
