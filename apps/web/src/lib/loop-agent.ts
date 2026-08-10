/**
 * Asking a model for a soundtrack, and holding it to the rules.
 *
 * `lib/score.ts` owns the format and the checks; this file owns the conversation. Three
 * decisions in it are worth the reader's time.
 *
 * ## The lane table is generated, never written out
 *
 * The model is taught the instruments from `LANES` itself, at prompt-build time. A table
 * of lanes typed into a prompt string is a table that goes stale the first time somebody
 * adds a lane and forgets — and the failure is silent and expensive: the model keeps
 * writing a lane the sequencer stopped having, or never learns about one it gained. The
 * same rule the rest of this repository follows for generated documentation.
 *
 * ## When the model is asked again, and when it is not
 *
 * `packages/agent`'s loop has a hard rule: ask for a structural change only when the
 * optimizer is provably stuck, because a rewrite discards what the search found. There
 * is no optimizer here and no target, so the rule takes its general form — **the model is
 * asked to change something only when a deterministic check failed.** A score that
 * parses, validates and mixes audibly is accepted, full stop. There is no "this
 * arrangement is a bit dull, try again" trip, because dull is not measurable and a
 * machine that bounces valid work on taste is making the same mistake as one that
 * rewrites a topology whose numbers were still improving. Taste has exactly one channel:
 * the user's next prompt.
 *
 * One failure class per repair, first one reached in pipeline order — extraction, parse,
 * validate — for the reason `repairMessage` gives: a model handed a parse error and six
 * validator complaints fixes the parse error and rewrites something unrelated.
 *
 * ## Nothing is salvaged
 *
 * If four lanes validate and one does not, the whole document goes back. Keeping the
 * good four and dropping the fifth would be repairing generated output instead of
 * repairing the spec — the exact thing "spec-first, fail fast" forbids, and the reason
 * this project never patches generated JavaScript.
 *
 * @packageDocumentation
 */

import type { LLMProvider } from '@txt2sfx/agent';
import { LANES, STEPS_PER_BAR, type LoopPreset, type LoopTrack } from './loop.js';
import {
  BAR_COUNTS,
  BPM_RANGE,
  DEGREE_RANGE,
  MAX_CAPTION,
  MAX_CHORD,
  MAX_LANES,
  PIECES,
  extractScore,
  parseScore,
  scoreDocument,
  validateScore,
  type Score,
  type ScoreIssue,
} from './score.js';

/**
 * Trips through the model, including the first.
 *
 * One fewer than the sound loop's budget, because this loop has what that one lacks: an
 * instant, free, known-good fallback sitting behind it. A third repair buys less here
 * than the seconds it costs the user.
 */
export const MAX_TRIPS = 3;

/** Upper bound on a reply. A sixteen-bar, six-lane score is well under a thousand. */
const MAX_TOKENS = 2000;

/** How each lane reads to the model: what it plays, and where it sits. */
const LANE_ROLE: Readonly<Record<string, string>> = {
  drums: 'the main kit — kick, snare, hats',
  perc: 'a second, quieter kit for colour',
  bass: 'the bass line',
  chords: 'plucked chords, mid register',
  keys: 'plucked chords, one octave up',
  stabs: 'synth power chords, low and distorted — the heavy chord lane',
  guitar: 'a distorted electric guitar through a cabinet — chords, low',
  riff: 'the same guitar playing one line: a low, palm-muted riff',
  organ: 'a drawbar organ — held chords, sustained not struck',
  brass: 'a brass section — chords that take 30 ms to speak',
  epiano: 'an electric piano, bell-like and struck',
  lead: 'the melody, high and cutting',
  arp: 'fast plucked figures',
  bells: 'sparse high bells',
  fx: 'one or two accents in the whole loop',
  pads: 'held chords, slow to arrive — the bed',
  strings: 'held chords, slow to arrive, softer',
  choir: 'held chords, slow to arrive, high and vowel-like',
  drone: 'a held sub, one note',
  air: 'high noise, barely there',
};

/** The instrument table, generated from the sequencer's own map. */
export function laneTable(): string {
  return Object.entries(LANES)
    .map(([name, spec]) => {
      const role = LANE_ROLE[name] ?? `${spec.family} voice`;
      const where = spec.drum === true ? 'percussion' : `octave ${String(spec.octave)}`;
      return `  ${name.padEnd(8)} ${where.padEnd(12)} ${role}`;
    })
    .join('\n');
}

/**
 * What the model is told, once per conversation.
 *
 * Written as instructions and not as a description, because everything in it is a thing
 * a reply can get wrong. The section on what makes a game loop work is the only part
 * that is taste rather than rule — it is there because the alternative is sixteen bars
 * of undifferentiated sixteenth notes, which is what a model writes when nobody says
 * that repetition is the material and variation is the message.
 */
export function scoreSystemPrompt(): string {
  return `You are the composer for NeurosLoop, a game-soundtrack sequencer. You write a
short score in a text format called scoreline; a deterministic sequencer turns it into
audio with fixed synthesized instruments. You decide the music — tempo, key, which
instruments play, and every note. You do not decide the sound design: each lane's
instrument is fixed and cannot be swapped.

## The format

A score is a header and one or more lanes:

    loop "<name>" <bpm>bpm <key> <bars> bars

- <name>: you name the track. Short, evocative, lowercase — it is the title the user sees.
- <bpm>: a whole number, ${String(BPM_RANGE.min)}–${String(BPM_RANGE.max)}.
- <key>: a root note and a mode, like \`D min\` or \`G maj\`.
- <bars>: ${BAR_COUNTS.join(', ')}.

Each lane is a block:

    lane <lane-name> "<one-line caption>"
      <rows>

The caption is shown to the user while that lane's audio is being built. One line,
present tense, about what the part does musically ("eighth-note grind that lifts to the
fifth"). At most ${String(MAX_CAPTION)} characters.

## The lanes

Lane names come from this closed table. There are no other instruments; a name that is
not here plays nothing. If the request asks for an instrument that is not in the table
("banjo", "sitar"), pick the nearest one and say so in the caption.

${laneTable()}

Use 3–${String(MAX_LANES)} lanes. Every lane you declare must play something.

## The grid

Time is a grid of sixteenth notes, ${String(STEPS_PER_BAR)} per bar. A row is:

    [piece] <bars> <steps> [degrees]

- <bars> is a 1-based bar range — \`1-15\` — or a single bar — \`16\`. Bars no row covers
  are silent. Two rows of the same lane and piece may not cover the same bar, so a fill
  in the last bar is written as its own row.
- <steps> is one character per sixteenth: \`X\` accent, \`x\` normal, \`-\` ghost,
  \`.\` rest, \`=\` tie (the note before keeps sounding). The string is one bar
  (${String(STEPS_PER_BAR)} characters) repeated across the range, or exactly
  ${String(STEPS_PER_BAR)}×N characters covering N bars, where N divides the range.
- Drum lanes name a piece per row: ${Object.keys(PIECES).join(', ')}. Drum rows take no
  degrees.
- Pitched lanes list degrees after the steps. A degree is a scale degree in the track's
  key: \`0\` is the root in that lane's own register, \`7\` the octave above, \`-3\` the
  sixth below. Stay between ${String(DEGREE_RANGE.min)} and ${String(DEGREE_RANGE.max)}.
  Hits consume degrees left to right and wrap around, so a repeating riff is written
  once. A chord is one token: \`0+2+4\`, at most ${String(MAX_CHORD)} notes.

Example:

\`\`\`
loop "molten throne" 150bpm D min 16 bars

lane drums "toms marching on the floor"
  kick  1-15  X......x..X.....
  kick  16    X......x..X..x.x
  snare 1-16  ....X.......X...
  hat   1-16  x.x.x.x.x.x.x.x.

lane bass "eighth-note grind that lifts to the fifth"
  1-8   X=x=X=x=X=x=X=x=  0 0 0 4 0 0 -3 4
  9-16  X=x=X=x=X=x=X=x=  3 3 3 4 3 3 0 4

lane lead "a siren that climbs into the wrap"
  13-16  X===x===X===x===  7 8 9 11
\`\`\`

## What makes a game loop work

The score loops forever: the last bar flows straight back into bar 1, and note tails that
run past the end fold around to the beginning — that is handled for you, so a pad may
ring across the loop point freely.

- Write bar 1 as the strongest downbeat, and aim the last bar at it. A fill, a rising
  line or a held tension in the final bar should resolve on the first hit of bar 1, so
  the join is an arrival rather than a splice.
- Repetition is the material; variation is the message. Repeat a bar-length idea and
  change it in a few deliberate places — usually the halves and the last bar. Sixteen
  different bars is not composition, it is noise.
- Leave space. Not every lane plays everywhere. A lead that enters at bar 13 gives the
  loop a shape; constant density gives it none.
- Accents are the groove: \`X\` on the beats you mean, \`x\` elsewhere, \`-\` to make
  percussion breathe.

## Range

You have one habit to fight, and it is the only reason this section exists: asked for
"music", a model writes a bright major loop at 120 bpm with every part in its top octave
and something playing on every eighth. That is one piece of music, and this screen is
asked for hundreds.

- **The mode is a decision, not a default.** Minor for anything cold, tense, tired,
  underground, sacred or sad; major only when the request is genuinely sunlit. If the
  request names no mood, minor is the safer read — the requests this screen gets are
  ambience far more often than fanfare.
- **Use the whole tempo range.** ${String(BPM_RANGE.min)} bpm is a real answer and so is
  ${String(BPM_RANGE.max)}. Anything asking to be still, vast, heavy or half-time belongs
  under 90.
- **Register is expression.** Degrees run down to ${String(DEGREE_RANGE.min)}, and a
  figure written an octave lower is a different piece of music, not a quieter one. Do not
  put every lane at the top of its range; let one part sit low and alone.
- **Dynamics.** A loop where every bar is as full as every other bar has no shape. Take a
  lane out for four bars. Let one enter halfway. End a phrase early and leave the gap.
- **Density is not effort.** Long notes and rests are composition. A pad holding one
  chord for four bars while a bell plays three notes in sixteen is a finished piece of
  music, and it is what most of these requests actually want.

## How aggression works here

Some requests are the opposite of ambience — a march, a boss, an assault, anything
militant or industrial. The instruments saturate when the request reads that way, so the
sound follows; what you have to get right is the *arrangement*, and there is one trap:

- **The bed lanes — \`pads\`, \`strings\`, \`choir\`, \`drone\`, \`air\` — fade in.** They are
  two detuned saws with a slow attack; that is what they are for and it cannot be swapped.
  A held bed chord under a march turns the whole thing back into ambience with a drum
  track. If you want chords that hit, use \`stabs\` (short bright chord hits) or \`chords\`,
  and keep a bed lane out or give it long notes far under the rest.
- **Aggression is the low end and the repetition**: \`drums\` on a hard, unbroken grid with
  \`tom\` carrying the fills, \`bass\` in eighths mostly on the root, \`stabs\` — power
  chords, the heaviest lane there is — on the beats or the offbeats, and a \`lead\` that
  repeats a short figure rather than wandering. Ostinato, not melody.
- **Weight comes from the bottom two octaves.** Prefer degrees at or below 0 in the low
  lanes and do not answer "heavy" with a busier top end: four lanes crowding the middle
  make the mixdown turn the whole thing down, and what it takes off is the weight.
- Keep the tempo where the style lives — a march is near 120–130, not 90 — and stay in a
  minor mode.

## How to reply

- Reply with exactly one fenced code block containing the score, and nothing else — no
  prose before or after it, no JSON, no explanation.
- When you are asked to ADD to an existing track you will be shown what is playing.
  Reply with the new \`lane\` block or blocks only: no \`loop\` header, and never a lane
  that is already there.
- Never refuse. Every request has an answer inside these lanes. If the request cannot be
  taken literally, write the nearest thing that can be and let the captions say what you
  chose.`;
}

/**
 * The first turn for a new track.
 *
 * The numbers are shown as what they are: a *guess the interface made from the same words
 * you are reading*, produced by `paletteFor` so the built-in composer has something to
 * work with. Naming it a palette the user "started from" — as this turn used to — invited
 * the model to treat six fixed tempi as the brief, which is exactly the monotony the
 * chips were replaced to end.
 */
export function composeRequest(prompt: string, palette: LoopPreset): string {
  return `Compose a new loop for this request:

<request>
${prompt.trim()}
</request>

From those words the interface guessed ${String(palette.bpm)}bpm, ${palette.key}, ${String(palette.bars)} bars and lanes ${palette.lanes.join('/')}. That guess exists so the built-in composer has numbers when you are not asked; it is not the brief. Set the tempo, key, mode, length and lane choice yourself from the request, and depart from the guess wherever the request reads better another way.`;
}

/** The first turn for lanes added to a track that already plays. */
export function extendRequest(prompt: string, track: LoopTrack): string {
  const playing = track.lanes.map((lane) => lane.name);
  return `Add to this track:

\`\`\`
${scoreDocument(track)}
\`\`\`

<request>
${prompt.trim() === '' ? 'one or two parts that answer what is already playing' : prompt.trim()}
</request>

Reply with one or two new \`lane\` blocks and no header. Lanes already playing: ${playing.join(', ')} — choose ones that are not, and write material that answers what is there rather than doubling it. Say in each caption what the part is for.`;
}

/** The turn that replaces exactly one lane, keeping its role. */
export function retryRequest(lane: string, track: LoopTrack): string {
  return `Rewrite one lane of this track:

\`\`\`
${scoreDocument(track)}
\`\`\`

Replace the \`${lane}\` lane. Keep its role in the arrangement and write different material for it — a different figure, a different register within the lane, a different placement. Reply with one \`lane ${lane}\` block and no header.`;
}

/** One line of the repair message: what broke, and the instruction to fix it. */
function line(issue: ScoreIssue): string {
  const where = issue.line === undefined ? '' : `line ${String(issue.line)}: `;
  return `- ${where}${issue.rule} — ${issue.got} (expected ${issue.expected}). ${issue.hint}`;
}

/**
 * What goes back after a rejected score.
 *
 * Errors only, and at most six of them: the point is a fix, and a model handed twenty
 * complaints rewrites the score from scratch and loses whatever was working.
 */
export function repairMessage(issues: readonly ScoreIssue[]): string {
  const errors = issues.filter((entry) => entry.severity === 'error').slice(0, 6);
  return `That score was rejected. Fix exactly this and reply with the whole corrected score in one fenced block:

${errors.map(line).join('\n')}`;
}

/** What the caller watches while this runs. */
export type ScoreEvent =
  | { readonly type: 'asking'; readonly attempt: number }
  | { readonly type: 'reply'; readonly chars: number }
  | { readonly type: 'rejected'; readonly issues: readonly ScoreIssue[] }
  | { readonly type: 'accepted'; readonly warnings: readonly ScoreIssue[] };

export interface ComposeScoreOptions {
  readonly provider: LLMProvider;
  /** The opening turn — {@link composeRequest}, {@link extendRequest} or {@link retryRequest}. */
  readonly request: string;
  readonly context: Parameters<typeof validateScore>[1];
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ScoreEvent) => void;
}

/** What came back, and the text it came from. */
export interface ComposedScore {
  readonly score: Score;
  readonly text: string;
  readonly warnings: readonly ScoreIssue[];
  readonly attempts: number;
}

/**
 * Ask, check, repair, accept — or throw with the last thing that was wrong.
 *
 * Throwing rather than returning a failure shape is deliberate: every caller's answer to
 * "no usable score" is the same one — compose it with the seeded composer and say so —
 * and a `null` that has to be checked at three call sites is three chances to forget.
 * The message is the reason, phrased for the status line rather than for the model.
 */
export async function composeScore(options: ComposeScoreOptions): Promise<ComposedScore> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: options.request },
  ];
  let last = 'the model never answered';

  for (let attempt = 1; attempt <= MAX_TRIPS; attempt++) {
    options.onEvent?.({ type: 'asking', attempt });
    const reply = await options.provider.complete({
      system: scoreSystemPrompt(),
      messages,
      maxTokens: MAX_TOKENS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    options.onEvent?.({ type: 'reply', chars: reply.length });

    const text = extractScore(reply);
    const parsed = parseScore(text);
    const issues = [...parsed.issues, ...validateScore(parsed.score, options.context)];
    const errors = issues.filter((entry) => entry.severity === 'error');

    if (errors.length === 0) {
      const warnings = issues.filter((entry) => entry.severity === 'warning');
      options.onEvent?.({ type: 'accepted', warnings });
      return { score: parsed.score, text, warnings, attempts: attempt };
    }

    options.onEvent?.({ type: 'rejected', issues: errors });
    last = `${errors[0]?.rule ?? 'score.rejected'} — ${errors[0]?.got ?? ''}`;
    messages.push({ role: 'assistant', content: reply }, { role: 'user', content: repairMessage(errors) });
  }

  throw new Error(last);
}
