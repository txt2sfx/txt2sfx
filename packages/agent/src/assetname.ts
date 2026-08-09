/**
 * Naming a rendered sound the way a game project would file it.
 *
 * ## Why a model is asked at all
 *
 * The obvious answer is a slug of the prompt, and it is wrong for the same reason
 * {@link audioCaption} exists: the prompt is written in whatever language and whatever
 * register the person thinks in, and `sfx_tyazhelaya_metallicheskaya_dver` is not a name,
 * it is a transliteration accident. Worse, the prompt describes the *request* — "the one
 * from the trailer, but drier" names nothing an asset browser can sort.
 *
 * A caption is closer, because it is already English and already about acoustics, but it
 * is a sentence: `heavy steel door slams shut, metallic clang, corridor reverb` is exactly
 * what the renderer needed and a terrible file name. So one cheap call turns either of
 * them into a short asset title, and the file name is derived from *that* by
 * {@link assetFileName} rather than asked for.
 *
 * ## Why the file name is derived and not requested
 *
 * Because a file name has hard rules and a title does not, and the two must agree. A model
 * asked for both returns them agreeing about 90% of the time and, on the other 10%, hands
 * back a name with a space, a slash or a leading dot in it — and a validator that repairs
 * the reply has to decide which of the two disagreeing answers was meant. This is the same
 * division the whole project runs on: the model judges (what is this sound called), the
 * script enforces (what a file may be called). One answer, one transformation, no repair.
 *
 * @packageDocumentation
 */

import type { LLMProvider } from './provider.js';

/**
 * Longest title worth keeping, in characters.
 *
 * Not a model limit — a list limit. The title is drawn in a sidebar row beside a duration
 * and a play button, and anything past about this length is ellipsised there, which turns
 * a name into a riddle. Four words of English sit comfortably under it.
 */
export const ASSET_TITLE_LIMIT = 48;

/** Longest file-name stem this will produce, extension excluded. */
export const ASSET_FILE_LIMIT = 40;

/** Longest reply worth reading. A name that arrives as an essay has already failed. */
const MAX_REPLY = 600;

/**
 * What the naming model is told.
 *
 * Two rules carry the weight. **Name the sound, not the request** — the input may be a
 * caption full of recording vocabulary (`close-up dry recording`), and none of that
 * belongs in the name of the asset. **Two to four words** — an asset browser sorts by
 * name, so the first word should be the thing (`Door`, `Coin`, `Fireball`) and the rest
 * should narrow it; a name that opens with an adjective files itself under the adjective.
 */
const SYSTEM = `You name sound-effect assets for a game project.

Reply with one short English title and nothing else. No quotes, no explanation, no
markdown, no file extension, no line breaks.

Two to four words, Title Case. Start with the thing that makes the sound, then narrow it:
"Metal Door Slam", "Coin Pickup", "Fireball Cast", "Footstep Gravel". Never start with an
adjective — the list this appears in is sorted by name.

Name the sound itself, not the request and not the recording: drop words about microphones,
rooms, mixing and takes ("close-up", "dry", "reverberant", "mono"), and drop words that
describe no event ("nice", "epic", "cool").`;

/** A name for a rendered sound, and where it came from. */
export interface AssetName {
  /** What a person reads in a list. Title Case, never empty. */
  readonly title: string;
  /** The file-name stem the title implies. ASCII, lower snake case, never empty. */
  readonly file: string;
  /**
   * `model` when a model wrote the title, `text` when it was cut from the input.
   *
   * Reported for the same reason {@link Caption.source} is: a list where half the rows
   * were named by a model and half by a regular expression should be able to say which
   * is which, and a caller that wants to retry knows which rows are worth retrying.
   */
  readonly source: 'model' | 'text';
  /** Why the model's answer was not used. One sentence, for a log line. */
  readonly note?: string;
}

/**
 * Turn a title into a file-name stem a game project can live with.
 *
 * Lower snake case, ASCII only, no leading digit. That last rule is not cosmetic: an
 * asset name is routinely pasted into code as an identifier — `SFX.metal_door_slam` — and
 * a stem starting with a digit is not one, so `3 Round Burst` becomes `sfx_3_round_burst`
 * rather than something that fails to compile the first time somebody uses it.
 *
 * The `sfx_` prefix is that rule's answer and a grouping besides: an import that dumps
 * everything into one directory keeps the generated sounds together, and a name that is
 * already prefixed is not prefixed twice.
 *
 * Diacritics are folded (`Café` → `cafe`) rather than dropped, because dropping them
 * turns `Fötsteps` into `ftsteps`. Anything with no ASCII left after folding — a title in
 * a script this cannot transliterate — returns an empty string, and the caller decides
 * what to call it instead; inventing `sfx_sound` here would file every one of them under
 * the same name.
 */
export function assetFileName(title: string): string {
  const folded = title
    .normalize('NFKD')
    /* Combining marks, i.e. what NFKD just split the accents into. */
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (folded === '') return '';

  const stem = folded.startsWith('sfx_') ? folded : `sfx_${folded}`;
  if (stem.length <= ASSET_FILE_LIMIT) return stem;
  /* Cut at a word boundary rather than mid-word: a stem ending `..._explos` reads as a
     truncation bug, and the underscore is the only place the meaning survives a cut. */
  const cut = stem.slice(0, ASSET_FILE_LIMIT);
  const underscore = cut.lastIndexOf('_');
  return (underscore > 4 ? cut.slice(0, underscore) : cut).replace(/_+$/u, '');
}

/**
 * Clean a model reply into one title.
 *
 * @returns The title, or undefined when the reply holds nothing usable.
 */
export function parseAssetTitle(reply: string): string | undefined {
  if (reply.length > MAX_REPLY) return undefined;

  const first = reply
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^["'`*_#\s]+|["'`*_\s.]+$/gu, '')
        /* "Title: …" and "Name: …" survive an instruction not to explain. */
        .replace(/^[A-Za-z][A-Za-z ]{0,14}:\s*/u, '')
        /* A model that ignored "no file extension" answers `Metal Door Slam.wav`. */
        .replace(/\.(wav|mp3|ogg|m4a|aiff?|flac)$/iu, ''),
    )
    .find((line) => line !== '');
  if (first === undefined) return undefined;

  const line = first.replace(/\s+/gu, ' ').trim();
  if (line === '') return undefined;
  return line.length <= ASSET_TITLE_LIMIT ? line : cutWords(line, ASSET_TITLE_LIMIT);
}

/** Cut to at most `limit` characters, on a word boundary where there is one. */
function cutWords(line: string, limit: number): string {
  const cut = line.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit / 3 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/u, '');
}

/**
 * A title made from the text itself, for when no model can be asked.
 *
 * The first clause of a caption is the subject — `audioCaption`'s system prompt puts the
 * source and its material first, before the action and the recording — so cutting at the
 * first comma yields the two or three words that name the thing surprisingly often. Title
 * Case afterwards, because the list is a list of names and a lower-case row in it reads as
 * a different kind of entry rather than as a name nobody capitalised.
 */
export function titleFromText(text: string): string {
  const clause = text.split(/[,.;\n]/u)[0] ?? '';
  const words = clause
    .replace(/\s+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '')
    .slice(0, 4);
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .slice(0, ASSET_TITLE_LIMIT);
}

/** Options of {@link audioAssetName}. */
export interface AudioAssetNameOptions {
  /**
   * The text to name: the caption if there is one, otherwise the prompt.
   *
   * One field rather than both, because the two are the same string on the render screen
   * — the caption replaces the prompt in place — and a second parameter would only exist
   * to be passed the same value twice.
   */
  readonly text: string;
  readonly provider: LLMProvider;
  readonly signal?: AbortSignal;
}

/**
 * Ask a model what this sound should be called in a game project.
 *
 * @returns The title and the file stem. Never rejects — a failed call comes back as
 *   `source: 'text'` with the reason in `note`, because the caller is naming a row in a
 *   list that already exists, and a thrown error there would leave it nameless.
 */
export async function audioAssetName(options: AudioAssetNameOptions): Promise<AssetName> {
  const text = options.text.trim();
  const fallback = (note?: string): AssetName => {
    const title = titleFromText(text);
    return {
      title,
      file: assetFileName(title),
      source: 'text',
      ...(note === undefined ? {} : { note }),
    };
  };

  if (text === '') return { title: '', file: '', source: 'text', note: 'there is nothing to name' };

  try {
    const reply = await options.provider.complete({
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
      /* Four words is a dozen tokens; 48 is room to be wordy and still be cut rather
         than truncated mid-answer. */
      maxTokens: 48,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const title = parseAssetTitle(reply);
    if (title === undefined) return fallback('the model did not answer with a title');
    const file = assetFileName(title);
    /* A title the file rule cannot represent — every character non-Latin — is a title
       the model wrote in the wrong script. Keep it as the label, since it is at least
       about this sound, and take the stem from the input, which is English by then. */
    return file === '' ? { title, file: assetFileName(titleFromText(text)), source: 'model' } : { title, file, source: 'model' };
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
}
