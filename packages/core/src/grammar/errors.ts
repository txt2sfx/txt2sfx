/**
 * Parse errors, written for two readers at once.
 *
 * Every message starts with `line L, col C:` and continues with a concrete,
 * actionable statement — the same string is underlined in the playground
 * editor and pasted verbatim into the LLM's next turn. A message that only
 * says "syntax error" costs the agent loop an entire iteration, so each one
 * names what was expected and, where possible, offers the fix.
 *
 * @packageDocumentation
 */

import type { Loc } from '@txt2sfx/shared';

/** Fields needed to build a {@link SoundlineError}. */
export interface SoundlineErrorInit {
  /** Stable machine-readable id, e.g. `unit.missing`. */
  readonly code: string;
  /** The part of the message after the location prefix. */
  readonly detail: string;
  readonly loc: Loc;
  /** Optional imperative follow-up, appended to the message in parentheses. */
  readonly hint?: string;
}

/** A syntax error in a soundline document. */
export class SoundlineError extends Error {
  /** Stable machine-readable id, e.g. `unit.missing`. */
  readonly code: string;
  /** Message body without the `line L, col C:` prefix. */
  readonly detail: string;
  /** Suggested fix, if the parser could infer one. */
  readonly hint: string | undefined;
  readonly loc: Loc;

  constructor(init: SoundlineErrorInit) {
    const suffix = init.hint === undefined ? '' : ` (${init.hint})`;
    super(`line ${init.loc.line}, col ${init.loc.column}: ${init.detail}${suffix}`);
    this.name = 'SoundlineError';
    this.code = init.code;
    this.detail = init.detail;
    this.hint = init.hint;
    this.loc = init.loc;
  }

  /** 1-based line of the offending token. */
  get line(): number {
    return this.loc.line;
  }

  /** 1-based column of the offending token. */
  get column(): number {
    return this.loc.column;
  }

  /**
   * Render the error with the offending source line and a caret span.
   *
   * ```text
   * line 2, col 14: expected unit (Hz|kHz) after number
   *   thud: tone sine 480 -> 80Hz in 12ms
   *                   ^^^
   * ```
   */
  format(source: string): string {
    const lines = source.split(/\r?\n/);
    const srcLine = lines[this.loc.line - 1];
    if (srcLine === undefined) return this.message;
    const caret = `${' '.repeat(Math.max(0, this.loc.column - 1))}${'^'.repeat(Math.max(1, this.loc.length))}`;
    return `${this.message}\n${srcLine}\n${caret}`;
  }
}

/**
 * Optimal string alignment distance (Damerau-Levenshtein restricted to
 * adjacent transpositions).
 *
 * Plain Levenshtein charges 2 for a swap, which is enough to lose `nosie` ->
 * `noise` — and swapped letters are the single most common typo in a hand-
 * written soundline. Words here are a handful of characters, so the full
 * matrix costs nothing.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = new Array<number>(rows * cols).fill(0);
  const at = (i: number, j: number): number => d[i * cols + j] as number;
  const set = (i: number, j: number, v: number): void => {
    d[i * cols + j] = v;
  };

  for (let i = 0; i < rows; i++) set(i, 0, i);
  for (let j = 0; j < cols; j++) set(0, j, j);

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      set(i, j, best);
    }
  }
  return at(a.length, b.length);
}

/**
 * Words that are wrong but predictable, mapped to the soundline spelling.
 *
 * Edit distance cannot connect `lowpass` to `lp` or `reverb` to `verb`, yet
 * those are exactly the names a language model reaches for on its first try.
 * Each entry here saves one agent iteration, so the table is worth its weight.
 * A synonym is only offered when it is among the candidates for the position
 * that failed, which keeps `drive` on a `delay` from suggesting `dist`.
 */
const SYNONYMS: Readonly<Record<string, string>> = {
  // effects
  lowpass: 'lp',
  'low-pass': 'lp',
  lpf: 'lp',
  highpass: 'hp',
  hpf: 'hp',
  bandpass: 'bp',
  bpf: 'bp',
  filter: 'lp',
  reverb: 'verb',
  room: 'verb',
  distortion: 'dist',
  overdrive: 'dist',
  saturate: 'dist',
  waveshaper: 'dist',
  crush: 'dist',
  echo: 'delay',
  // primitives
  osc: 'tone',
  oscillator: 'tone',
  sine: 'tone',
  saw: 'tone',
  square: 'tone',
  tri: 'tone',
  hiss: 'noise',
  whitenoise: 'noise',
  sweep: 'chirp',
  glide: 'chirp',
  string: 'pluck',
  karplus: 'pluck',
  resonator: 'modal',
  bell: 'modal',
  metal: 'modal',
  impulse: 'click',
  transient: 'click',
  kick: 'sub',
  bass: 'sub',
  // parameters
  release: 'decay',
  sustain: 'hold',
  volume: 'gain',
  amp: 'gain',
  amplitude: 'gain',
  level: 'gain',
  offset: 'delay',
  start: 'delay',
  frequency: 'freq',
  pitch: 'freq',
  cutoff: 'freq',
  resonance: 'Q',
  depth: 'index',
};

/**
 * Closest candidate to `word`, or `undefined` if nothing is close enough.
 *
 * A curated synonym wins over edit distance; otherwise the threshold scales
 * with word length so that `decy` -> `decay` is offered while `boom` ->
 * `noise` is not.
 */
export function didYouMean(word: string, candidates: readonly string[]): string | undefined {
  const lower = word.toLowerCase();
  const synonym = SYNONYMS[lower];
  if (synonym !== undefined && candidates.includes(synonym)) return synonym;
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const score = editDistance(lower, candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  const limit = Math.max(1, Math.floor(Math.max(word.length, 4) / 3));
  return best !== undefined && bestScore <= limit ? best : undefined;
}

/** Format a closed set for an error message: `sine|tri|saw|square`. */
export function expectedList(items: readonly string[]): string {
  return items.join('|');
}
