/**
 * Turning a request into something the reference model can read.
 *
 * ## The failure this fixes
 *
 * Stable Audio Open Small conditions on **t5-base**, with `max_length: 64` — both
 * read straight out of the checkpoint's `model_config.json`. t5-base's SentencePiece
 * vocabulary is English; every other script falls apart in it. Measured, with the
 * cached tokenizer:
 *
 * ```
 * "магическое заклинание леденая стрела"
 *   → 26 tokens: ▁ ма <unk> и <unk> е ско е ▁ <unk> а к ли на ни е ▁ ле де на <unk> ▁ ст ре ла </s>
 *   → decodes back as "ма<unk>и<unk>еское <unk>аклинание ледена<unk> стрела"
 * ```
 *
 * So the model was never asked for an ice arrow. It was handed a sentence with holes
 * in it, spent thirty seconds of CPU, and returned its own median — which is what a
 * "strange text in a language that does not exist" render actually is. No amount of
 * fixing encodings anywhere in the pipeline touches this: the prompt arrives intact
 * and is destroyed by the tokenizer.
 *
 * The same tokenizer measurement bounds the other end. Over ten realistic captions
 * the worst rate was 3.28 characters per token, so 64 tokens holds at least
 * {@link CAPTION_LIMIT} characters — about 34 words. Anything past that is not
 * "slightly truncated", it is silently absent.
 *
 * One short model call fixes both halves: a request in any language out, one line of
 * concrete English acoustics in.
 *
 * ## Why this is not `searchQuery`
 *
 * They look alike and their failure stances are opposites. A bad retrieval query
 * costs *worse examples*, so {@link searchQuery} is allowed to fail quietly and fall
 * back to the raw prompt. A bad caption costs the render itself — thirty to sixty
 * seconds of somebody's CPU for audio that answers nothing — and the raw prompt is
 * not a fallback, it is the thing that was broken. So this module reports what it
 * did ({@link Caption.source}), never substitutes silently, and hands back a
 * {@link captionIssue} the caller can show next to the button instead of a shrug.
 *
 * The caller shows the caption and lets it be edited, which is the other half of the
 * argument: on a diffusion model the caption *is* the instrument. Hiding the one
 * string that decides the output would be the same mistake as hiding a download
 * behind a spinner.
 *
 * @packageDocumentation
 */

import type { LLMProvider } from './provider.js';

/**
 * Longest caption worth sending, in characters.
 *
 * 64 t5 tokens is the checkpoint's `max_length`, and the worst rate measured over ten
 * realistic SFX captions was 3.28 characters per token — so 200 characters cannot
 * overflow the window, while 210 (the mean-case equivalent) sometimes would. The cap
 * is deliberately a length the model *can* read rather than a length a human would
 * write: a caption near it is already using its whole budget.
 */
export const CAPTION_LIMIT = 200;

/**
 * What the captioning model is told.
 *
 * Two rules here are load-bearing and the rest is hygiene.
 *
 * **"What a microphone would pick up, not what happens in the game."** The training
 * captions are descriptions of recordings, so the model knows `crystalline shatter`
 * and `icy crackle` and has never been told what a spell is. A caption that says
 * "ice arrow spell" spends its tokens on a concept and leaves the acoustics to
 * chance; one that says "crystalline shatter, icy crackle, sharp whoosh" describes a
 * sound that exists in the data.
 *
 * **The word cap.** Not politeness — 25 words is about 42 tokens at the measured
 * mean rate, which leaves room under the 64-token window for the comma-separated
 * structure the same rate charges for. A model asked for "a rich description" writes
 * sixty words and the last thirty are dropped by the tokenizer without a word from
 * anybody.
 */
const SYSTEM = `You write one caption for Stable Audio Open, a text-to-audio model that renders sound
effects. Its text encoder is t5-base: English only, and it reads at most 64 tokens.

Reply with one line of English, at most 25 words, and nothing else. No quotes, no
explanation, no markdown, no line breaks.

Describe what a microphone would pick up, not what happens in the game. The model was
trained on captions of recordings: it knows "crystalline shatter" and "icy crackle" and
has never heard of a spell, a mana cost or a critical hit. Translate a game concept into
the physical events that make its sound.

Name, in this order, separated by commas: the source and its material, the action, the
character of the attack and decay, and how it was recorded — close-up, dry, reverberant
hall, distant.

Translate to English whatever language the request is written in. t5-base cannot read
another script and renders one as noise.

Stay concrete. Drop degree words that describe nothing audible ("big", "epic", "nice")
and filler ("sound", "effect of", "please"). Do not invent a musical key, a tempo or an
instrument unless the request asks for one.`;

/** Longest reply worth reading. A caption that arrives as an essay has already failed. */
const MAX_REPLY = 2000;

/** Scripts t5-base has no vocabulary for, and the length it cannot read past. */
export type CaptionIssue = 'script' | 'length';

/**
 * A letter t5-base has no vocabulary for: any letter that is not Latin.
 *
 * Stated as "not Latin" rather than as a list of scripts to reject, because the list
 * is every script there is — the measurement above is Cyrillic, but Greek, Han,
 * Hangul, Devanagari and Hebrew all break the same way and in the same place. The
 * lookahead is set subtraction without the `v` flag: assert the position is not a
 * Latin letter, then match a letter.
 */
const NON_LATIN_LETTER = /(?![\p{Script=Latin}])\p{L}/u;

/**
 * What is wrong with a caption, deterministically, before anything is spawned.
 *
 * A rule id rather than a sentence, for the same reason the validator's invariants
 * carry one: the caller renders it in the reader's language, and a test can pin the
 * behaviour without pinning the wording.
 *
 * Reported and not enforced. A render that will come back as noise is worth a
 * sentence next to the button, not a disabled button — the same stance `renderSound`
 * takes about clipping and `codegen` about its size budget. Someone who wants to hear
 * what the tokenizer does with their language is entitled to hear it.
 *
 * @returns The issue, or null when the caption is something the model can read.
 */
export function captionIssue(caption: string): CaptionIssue | null {
  if (NON_LATIN_LETTER.test(caption)) return 'script';
  if (caption.length > CAPTION_LIMIT) return 'length';
  return null;
}

/**
 * Clean a model reply into one caption line.
 *
 * Trimmed rather than rejected when it runs long, which is where this parts company
 * with {@link parseKeywords}: there the caller had a good fallback and a trimmed
 * sentence would have been misleading, here the fallback is the prompt that was
 * already unreadable. Trimming at the last comma keeps the caption a list of whole
 * descriptors instead of a list ending mid-thought — the tokenizer would have cut it
 * at token 64 anyway, and it does not look for commas.
 *
 * @returns The caption, or undefined when the reply holds nothing usable.
 */
export function parseCaption(reply: string): string | undefined {
  if (reply.length > MAX_REPLY) return undefined;

  const first = reply
    .split('\n')
    .map((line) =>
      line
        .trim()
        /* Models like to wrap one-line answers, and a caption that keeps its quotes
           spends two tokens saying nothing. Markdown emphasis, the same. */
        .replace(/^["'`*_\s]+|["'`*_\s]+$/g, '')
        /* "Caption: …" and "Prompt: …" are the two prefixes that survive an
           instruction not to explain. Anything longer than a label is left alone. */
        .replace(/^[A-Za-z][A-Za-z ]{0,14}:\s*/, ''),
    )
    .find((line) => line !== '');
  if (first === undefined) return undefined;

  /* Collapse whatever whitespace the reply used into single spaces: a caption is one
     line by the time it reaches the tokenizer either way, and a stray newline in the
     middle of it would reach argv and be refused as a control character. */
  const line = first.replace(/\s+/gu, ' ').trim();
  if (line === '') return undefined;
  if (line.length <= CAPTION_LIMIT) return line;

  const cut = line.slice(0, CAPTION_LIMIT);
  const comma = cut.lastIndexOf(',');
  /* Halfway is the threshold: a comma at character 20 of a 200-character budget means
     the reply was one long clause, and honouring it would throw away most of a
     caption the model can in fact read. */
  const trimmed = comma > CAPTION_LIMIT / 2 ? cut.slice(0, comma) : cut.replace(/\s+\S*$/u, '');
  return trimmed.replace(/[\s,;]+$/u, '');
}

/** A caption, and how it came to be one. */
export interface Caption {
  /** What to send to the model. Never empty. */
  readonly text: string;
  /**
   * `model` when a model wrote it, `prompt` when the request was used as written.
   *
   * Reported rather than resolved here so the caller can say so: "the caption you are
   * about to render was not translated" is the single most useful thing on the panel
   * when the render comes back as noise.
   */
  readonly source: 'model' | 'prompt';
  /** Why the model's answer was not used. One sentence, for a log line. */
  readonly note?: string;
}

/** Options of {@link audioCaption}. */
export interface AudioCaptionOptions {
  readonly prompt: string;
  readonly provider: LLMProvider;
  /**
   * How long the render will be, in seconds.
   *
   * Passed to the model because it changes the caption and not just its length: two
   * seconds is one isolated event with an attack and a decay, eight is something that
   * evolves or repeats, and a caption written for the wrong one fights the
   * `seconds_total` conditioning the same checkpoint is given.
   */
  readonly seconds?: number;
  readonly signal?: AbortSignal;
}

/**
 * Ask a model for one English caption describing the requested sound.
 *
 * @returns The caption. Never rejects — a failed call comes back as
 *   `source: 'prompt'` with the reason in `note`, because the caller is showing this
 *   in an editable field and a thrown error there would replace a usable starting
 *   point with nothing.
 */
export async function audioCaption(options: AudioCaptionOptions): Promise<Caption> {
  const prompt = options.prompt.trim();
  if (prompt === '') return { text: '', source: 'prompt', note: 'there is no prompt to caption' };

  const length =
    options.seconds === undefined
      ? ''
      : `\n\nThe render is ${String(options.seconds)} seconds long${options.seconds <= 3 ? ' — one short one-shot event' : ''}.`;

  try {
    const reply = await options.provider.complete({
      system: SYSTEM,
      messages: [{ role: 'user', content: `${prompt}${length}` }],
      /* 25 words is ~42 tokens at the measured mean rate; 128 leaves a model room to
         be slightly wordy and still be trimmed rather than cut off mid-caption. */
      maxTokens: 128,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const caption = parseCaption(reply);
    return caption === undefined
      ? { text: prompt, source: 'prompt', note: 'the model did not answer with a caption' }
      : { text: caption, source: 'model' };
  } catch (error) {
    return {
      text: prompt,
      source: 'prompt',
      note: error instanceof Error ? error.message : String(error),
    };
  }
}
