/**
 * Naming a rendered sound the way a game project files it.
 *
 * Two things are worth pinning here and the rest is hygiene. The **file rule** has to
 * hold for every title a model can return, including the ones it was told not to write —
 * a name with a slash or a leading digit in it reaches a file system and an identifier,
 * and neither forgives. And the **fallback** has to produce something usable from the
 * text alone, because the row it names already exists in the list by the time this runs.
 */

import { describe, expect, it } from 'vitest';
import {
  ASSET_FILE_LIMIT,
  ASSET_TITLE_LIMIT,
  assetFileName,
  audioAssetName,
  mockProvider,
  parseAssetTitle,
  titleFromText,
} from '../src/index.js';
import { ProviderError } from '../src/provider.js';

const CAPTION = 'heavy steel door slams shut, metallic clang, corridor reverb, dry close-up';

describe('assetFileName', () => {
  it('makes a snake-case stem under the sfx prefix', () => {
    expect(assetFileName('Metal Door Slam')).toBe('sfx_metal_door_slam');
  });

  /* An asset name is routinely pasted into code as `SFX.metal_door_slam`, so the stem
     has to be an identifier — which is what the prefix is for as much as grouping. */
  it('never starts with a digit', () => {
    expect(assetFileName('3 Round Burst')).toBe('sfx_3_round_burst');
  });

  it('takes every character a file system would refuse', () => {
    expect(assetFileName('Door / Slam: "heavy"')).toBe('sfx_door_slam_heavy');
    expect(assetFileName('  ..Coin Pickup..  ')).toBe('sfx_coin_pickup');
  });

  /* Folded rather than dropped: dropping the diacritic turns `Fötstep` into `Ftstep`. */
  it('folds diacritics instead of deleting the letter', () => {
    expect(assetFileName('Café Door Chime')).toBe('sfx_cafe_door_chime');
  });

  it('does not prefix a title that already carries the prefix', () => {
    expect(assetFileName('sfx_coin_pickup')).toBe('sfx_coin_pickup');
  });

  it('cuts a long stem at an underscore rather than mid-word', () => {
    const stem = assetFileName('Enormous Cavernous Subterranean Explosion Rumble Tail');
    expect(stem.length).toBeLessThanOrEqual(ASSET_FILE_LIMIT);
    expect(stem.endsWith('_')).toBe(false);
    expect(stem).toBe('sfx_enormous_cavernous_subterranean');
  });

  /* Empty rather than a placeholder: `sfx_sound` for every title in a script this
     cannot transliterate would file all of them under one name. */
  it('returns nothing when no ASCII survives', () => {
    expect(assetFileName('тяжёлая дверь')).toBe('');
    expect(assetFileName('  ')).toBe('');
  });
});

describe('parseAssetTitle', () => {
  it('takes a title as it is', () => {
    expect(parseAssetTitle('Metal Door Slam')).toBe('Metal Door Slam');
  });

  it('strips the quoting, labelling and extension a model adds anyway', () => {
    expect(parseAssetTitle('"Metal Door Slam"')).toBe('Metal Door Slam');
    expect(parseAssetTitle('Title: Metal Door Slam')).toBe('Metal Door Slam');
    expect(parseAssetTitle('**Metal Door Slam**')).toBe('Metal Door Slam');
    expect(parseAssetTitle('Metal Door Slam.wav')).toBe('Metal Door Slam');
  });

  it('keeps only the first line', () => {
    expect(parseAssetTitle('Coin Pickup\n\nI chose "pickup" because…')).toBe('Coin Pickup');
  });

  it('rejects an empty reply', () => {
    expect(parseAssetTitle('')).toBeUndefined();
    expect(parseAssetTitle('  \n ')).toBeUndefined();
    expect(parseAssetTitle('""')).toBeUndefined();
  });

  it('cuts a long title at a word boundary', () => {
    const title = parseAssetTitle('Enormous Cavernous Subterranean Explosion With A Long Rumbling Tail');
    expect(title?.length).toBeLessThanOrEqual(ASSET_TITLE_LIMIT);
    expect(title?.endsWith(' ')).toBe(false);
  });

  it('rejects an essay rather than trimming one', () => {
    expect(parseAssetTitle('Certainly! '.repeat(200))).toBeUndefined();
  });
});

describe('titleFromText', () => {
  /* The caption's own system prompt puts the source and its material first, which is
     why the first clause is where the name is. */
  it('takes the first clause of a caption, Title Cased', () => {
    expect(titleFromText(CAPTION)).toBe('Heavy Steel Door Slams');
  });

  it('keeps at most four words', () => {
    expect(titleFromText('one two three four five six')).toBe('One Two Three Four');
  });

  it('survives an empty string', () => {
    expect(titleFromText('   ')).toBe('');
  });
});

describe('audioAssetName', () => {
  it('asks the model and derives the file name from what it answered', async () => {
    const provider = mockProvider({ replies: ['Metal Door Slam'] });
    await expect(audioAssetName({ text: CAPTION, provider })).resolves.toEqual({
      title: 'Metal Door Slam',
      file: 'sfx_metal_door_slam',
      source: 'model',
    });
    expect(provider.requests[0]?.messages[0]?.content).toBe(CAPTION);
  });

  /* Never rejects: the row being named is already in the list, and an exception here
     would leave it nameless rather than named badly. */
  it('names it from the text and says why when the call fails', async () => {
    const provider = mockProvider({
      reply: () => {
        throw new ProviderError({ provider: 'mock', message: 'rate limited' });
      },
    });
    const named = await audioAssetName({ text: CAPTION, provider });
    expect(named).toMatchObject({ title: 'Heavy Steel Door Slams', file: 'sfx_heavy_steel_door_slams', source: 'text' });
    expect(named.note).toContain('rate limited');
  });

  it('names it from the text when the reply is not a title', async () => {
    const provider = mockProvider({ replies: ['Certainly! '.repeat(200)] });
    await expect(audioAssetName({ text: CAPTION, provider })).resolves.toMatchObject({ source: 'text' });
  });

  /* A model that answered in the wrong script still answered *about this sound*, so the
     label is kept and only the stem falls back — the input is English by then. */
  it('keeps a non-Latin title but takes the stem from the text', async () => {
    const provider = mockProvider({ replies: ['Тяжёлая дверь'] });
    await expect(audioAssetName({ text: CAPTION, provider })).resolves.toEqual({
      title: 'Тяжёлая дверь',
      file: 'sfx_heavy_steel_door_slams',
      source: 'model',
    });
  });

  it('spends no call on an empty text', async () => {
    const provider = mockProvider({ replies: ['Metal Door Slam'] });
    const named = await audioAssetName({ text: '  ', provider });
    expect(named).toMatchObject({ title: '', file: '', source: 'text' });
    expect(provider.requests).toHaveLength(0);
  });
});
