import { describe, expect, it } from 'vitest';
import { modelLabel, parseModelId } from './modelNames';

/**
 * The model chip used to read its version out of a table copied from
 * Nimbalyst, and went stale the day a model shipped: `opus` said Opus 5 long
 * after it resolved to Opus 5.5. These hold the replacement to the property
 * that actually matters -- a version nobody has written down yet still reads
 * correctly -- using ids this machine has really seen, plus ones it has not.
 */
describe('parseModelId', () => {
  it('reads family and version off a served id', () => {
    expect(parseModelId('claude-opus-5-5')).toEqual({ family: 'Opus', version: '5.5', oneMillion: false });
    expect(parseModelId('claude-opus-5')).toEqual({ family: 'Opus', version: '5', oneMillion: false });
    expect(parseModelId('claude-sonnet-4-5')).toEqual({ family: 'Sonnet', version: '4.5', oneMillion: false });
    expect(parseModelId('claude-fable-5-1')).toEqual({ family: 'Fable', version: '5.1', oneMillion: false });
  });

  it('reads versions that do not exist yet, with no table to update', () => {
    // The whole point: none of these appear anywhere in the source.
    expect(parseModelId('claude-opus-6')?.version).toBe('6');
    expect(parseModelId('claude-sonnet-5-7')?.version).toBe('5.7');
    expect(parseModelId('claude-haiku-5-0-1')?.version).toBe('5.0.1');
  });

  it('reads a family that does not exist yet', () => {
    expect(parseModelId('claude-sonata-1')).toEqual({ family: 'Sonata', version: '1', oneMillion: false });
  });

  it('drops a snapshot date rather than reading it as a version', () => {
    expect(parseModelId('claude-haiku-4-5-20251001')?.version).toBe('4.5');
  });

  it('handles the older version-first shape', () => {
    expect(parseModelId('claude-3-5-sonnet-20241022')).toEqual({
      family: 'Sonnet',
      version: '3.5',
      oneMillion: false,
    });
  });

  it("reads Nimbalyst's session aliases, pinned or bare", () => {
    expect(parseModelId('claude-code:opus-1m')).toEqual({ family: 'Opus', version: null, oneMillion: true });
    expect(parseModelId('claude-code:sonnet')).toEqual({ family: 'Sonnet', version: null, oneMillion: false });
    expect(parseModelId('claude-code:opus-4-8')).toEqual({ family: 'Opus', version: '4.8', oneMillion: false });
    expect(parseModelId('claude-code:fable-5')).toEqual({ family: 'Fable', version: '5', oneMillion: false });
  });

  it('recognises the long-context marker in either spelling', () => {
    expect(parseModelId('claude-opus-5-5[1m]')?.oneMillion).toBe(true);
    expect(parseModelId('claude-code:opus-4-8-1m')).toEqual({ family: 'Opus', version: '4.8', oneMillion: true });
  });

  it("refuses ids that are not Claude's, rather than inventing a label", () => {
    expect(parseModelId('openai-codex:gpt-6')).toBeNull();
    expect(parseModelId('openai-codex:gpt-5.6-luna')).toBeNull();
    expect(parseModelId('gpt-6')).toBeNull();
  });

  it("refuses Claude Code's placeholder model", () => {
    // Written as the model of turns Claude Code fabricates, e.g. after an interrupt.
    expect(parseModelId('<synthetic>')).toBeNull();
  });

  it('refuses a shape it does not understand, rather than guessing', () => {
    expect(parseModelId('claude-opus-5-5-thinking')).toBeNull();
    expect(parseModelId('claude-')).toBeNull();
    expect(parseModelId('')).toBeNull();
    expect(parseModelId(undefined)).toBeNull();
  });
});

describe('modelLabel', () => {
  it('names the served version beside a bare alias', () => {
    // GET-111: the chip said `Opus 5` in a session Opus 5.5 was answering.
    expect(
      modelLabel({ sessionModel: 'claude-code:opus-1m', servedModel: 'claude-opus-5-5' }),
    ).toBe('Opus 5.5 (1M)');
  });

  it('prefers the served version over a catalog name that has fallen behind', () => {
    expect(
      modelLabel({
        sessionModel: 'claude-code:opus-1m',
        servedModel: 'claude-opus-5-5',
        catalogName: 'Opus 5 (1M)',
      }),
    ).toBe('Opus 5.5 (1M)');
  });

  it('takes the long-context marker from the alias, not the served id', () => {
    expect(modelLabel({ sessionModel: 'claude-code:opus', servedModel: 'claude-opus-5-5' })).toBe('Opus 5.5');
  });

  it('formats a verified past reply independently of the requested family', () => {
    // The presentation must label this as a past reply; formatting must not
    // discard real served identity or pretend a mismatching request served it.
    expect(
      modelLabel({
        sessionModel: 'claude-code:opus-1m',
        servedModel: 'claude-sonnet-5',
        catalogName: 'Opus 5.5 (1M)',
      }),
    ).toBe('Sonnet 5 (1M)');
    expect(modelLabel({ sessionModel: 'claude-code:opus-1m', servedModel: 'claude-sonnet-5' })).toBe('Sonnet 5 (1M)');
  });

  it('prefers a verified served identity to a requested pin', () => {
    expect(
      modelLabel({
        sessionModel: 'claude-code:opus-4-8',
        servedModel: 'claude-opus-5-5',
        catalogName: 'Opus 4.8',
      }),
    ).toBe('Opus 5.5');
  });

  it('falls back to the catalog before the first reply', () => {
    expect(modelLabel({ sessionModel: 'claude-code:opus-1m', catalogName: 'Opus 5.5 (1M)' })).toBe(
      'Opus 5.5 (1M)',
    );
  });

  it('names only the family when nothing knows the version, rather than a stale one', () => {
    expect(modelLabel({ sessionModel: 'claude-code:opus-1m' })).toBe('Opus (1M)');
    expect(modelLabel({ sessionModel: 'claude-code:sonnet' })).toBe('Sonnet');
  });

  it('makes unfamiliar IDs readable without inventing names or versions', () => {
    expect(modelLabel({ sessionModel: 'openai-codex:gpt-6-astra' })).toBe('openai codex gpt 6 astra');
  });

  it('keeps the catalog name for a model it cannot parse', () => {
    expect(
      modelLabel({ sessionModel: 'openai-codex:gpt-6-astra', catalogName: 'GPT-6 Astra' }),
    ).toBe('GPT-6 Astra');
  });

  it('still formats IDs when the catalog has only repeated the ID as a name', () => {
    expect(modelLabel({ sessionModel: 'local:Future_V2.7', catalogName: 'local:Future_V2.7' })).toBe('local Future V2.7');
    expect(modelLabel({ servedModel: 'local:Future_V2.7', servedCatalogName: 'local:Future_V2.7' })).toBe('local Future V2.7');
    expect(modelLabel({ sessionModel: '___' })).toBe('___');
  });

  it('returns null with no session model at all', () => {
    expect(modelLabel({})).toBeNull();
  });
});
