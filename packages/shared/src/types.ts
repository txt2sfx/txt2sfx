/**
 * Core data model of txt2sfx.
 *
 * Everything here is plain data: the AST produced by the soundline parser, the
 * acoustic profile produced by the analyzer, and the records stored by the
 * recipe bank. No behaviour, no dependencies — every other package builds on
 * these shapes.
 *
 * @packageDocumentation
 */

/* ------------------------------------------------------------------------- *
 * Source locations
 * ------------------------------------------------------------------------- */

/**
 * A span in the original soundline source.
 *
 * `line`/`column` are 1-based (they appear verbatim in error messages that are
 * read both by humans and by the LLM in the agent loop); `offset`/`length` are
 * 0-based character indices, used by the editor to underline the exact span.
 */
export interface Loc {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number. */
  readonly column: number;
  /** 0-based character offset from the start of the source. */
  readonly offset: number;
  /** Length of the span in characters. */
  readonly length: number;
}

/* ------------------------------------------------------------------------- *
 * Units and values
 * ------------------------------------------------------------------------- */

/**
 * Units the lexer accepts as a suffix of a numeric literal.
 *
 * The empty string means "dimensionless" — allowed only for parameters that are
 * ratios or linear gains (`gain`, `Q`, `mix`, `ratio`, `index`, `drive`, ...).
 * Every other number in a soundline must carry a unit; that rule is what keeps
 * "480" from silently meaning milliseconds in one place and hertz in another.
 */
export type Unit = '' | 'Hz' | 'kHz' | 'ms' | 's' | 'dB';

/**
 * The kind of quantity a parameter holds. Determines which units the parser
 * accepts and which canonical unit the compiler reads.
 *
 * - `freq`  — `Hz` | `kHz`, canonical Hz
 * - `time`  — `ms` | `s`, canonical ms
 * - `level` — dimensionless linear gain or `dB`, canonical linear
 * - `ratio` — dimensionless scalar (Q, modulation index, feedback, ...)
 * - `enum`  — one of a closed set of bare words
 * - `list`  — colon-separated numbers, e.g. modal `ratios 1:2.76:5.4`
 */
export type ParamKind = 'freq' | 'time' | 'level' | 'ratio' | 'enum' | 'list';

/**
 * An optimizable range attached to a numeric literal by the `~value[min..max]`
 * syntax. Bounds are expressed in the *same unit as the literal they annotate*.
 *
 * The LLM writes a tilde wherever it is unsure of an exact number; the
 * differential-evolution optimizer treats every slot as one search dimension.
 */
export interface SlotRange {
  readonly min: number;
  readonly max: number;
  /**
   * Span of the bound's own number token in the source.
   *
   * Filled in by the parser, so that a transform which rewrites a literal by
   * span — the master sliders in the playground multiply every frequency or
   * every duration — can move the range with the value instead of leaving the
   * seed outside its own bounds. Optional because an AST can be built by hand
   * and `exactOptionalPropertyTypes` makes "absent" an explicit state; note
   * that `min`/`max` are already converted to the unit of the value they
   * bound, while the token at this span may have been written in another.
   */
  readonly minLoc?: Loc;
  /** Span of the upper bound's number token; see {@link SlotRange.minLoc}. */
  readonly maxLoc?: Loc;
}

/** A number as written in the source, with its unit and optional slot range. */
export interface NumberLiteral {
  /** Value in the unit it was written with — never silently converted. */
  readonly value: number;
  readonly unit: Unit;
  /** Present only when the literal was written as `~value[min..max]`. */
  readonly slot?: SlotRange;
  readonly loc: Loc;
}

/** One `-> target in time` step of a parameter trajectory. */
export interface RampSegment {
  /** `exp` is the default; `lin` is written as `-> lin target in time`. */
  readonly curve: 'exp' | 'lin';
  readonly to: NumberLiteral;
  /** Segment duration; unit is `ms` or `s`. */
  readonly time: NumberLiteral;
  readonly loc: Loc;
}

/** A numeric argument: a starting value plus zero or more ramp segments. */
export interface NumberArg {
  readonly kind: 'number';
  readonly head: NumberLiteral;
  /** Empty for a constant parameter. */
  readonly ramp: readonly RampSegment[];
  readonly loc: Loc;
}

/** A bare word chosen from a closed set, e.g. `sine`, `white`, `metal`. */
export interface EnumArg {
  readonly kind: 'enum';
  readonly value: string;
  readonly loc: Loc;
}

/** A colon-separated list of dimensionless numbers, e.g. `1:2.76:5.4`. */
export interface ListArg {
  readonly kind: 'list';
  readonly values: readonly number[];
  readonly loc: Loc;
}

/** Any argument value that can appear after a primitive or effect name. */
export type ArgValue = NumberArg | EnumArg | ListArg;

/**
 * Arguments of one node, keyed by parameter name.
 *
 * Only parameters that were *written* are present — defaults are applied at
 * compile time, never baked into the AST. That is what makes
 * `serialize(parse(src)) === src` hold byte for byte.
 */
export type NodeArgs = Readonly<Record<string, ArgValue>>;

/* ------------------------------------------------------------------------- *
 * Parameter signatures
 * ------------------------------------------------------------------------- */

/** Declaration of a single parameter of a primitive, effect or envelope. */
export interface ParamSpec {
  readonly name: string;
  readonly kind: ParamKind;
  /** Written without its name, in signature order (e.g. `tone sine 480Hz`). */
  readonly positional?: boolean;
  readonly required?: boolean;
  /** Whether `-> value in time` trajectories are allowed. */
  readonly rampable?: boolean;
  /** Default applied by the compiler when the parameter is omitted. */
  readonly default?: number | string | readonly number[];
  /** Soft physical bounds in canonical units (Hz / ms / linear). */
  readonly min?: number;
  readonly max?: number;
  /** Allowed words for `kind: 'enum'`. */
  readonly values?: readonly string[];
  /** One line, shown in PRIMITIVES.md and injected into the LLM prompt. */
  readonly doc: string;
}

/** Syntactic + physical contract of one primitive, effect or the envelope. */
export interface Signature {
  readonly name: string;
  readonly kind: 'primitive' | 'effect' | 'envelope';
  readonly params: readonly ParamSpec[];
  readonly doc: string;
}

/* ------------------------------------------------------------------------- *
 * AST
 * ------------------------------------------------------------------------- */

/**
 * Sound category. Drives the physical invariants in the validator: a `pop`
 * that lasts 400 ms is not a pop, whatever the prompt claimed.
 *
 * `cycle` is the loopable category (rotors, engines, hums) and requires the
 * `loop` flag in the header.
 */
export type SoundCategory =
  | 'pop'
  | 'ui'
  | 'laser'
  | 'impact'
  | 'explosion'
  | 'pickup'
  | 'foley'
  | 'cycle'
  | 'misc';

/** A sound source: one of the eight v0 primitives. */
export interface SourceNode {
  readonly kind: 'source';
  /** Primitive name, e.g. `tone`, `noise`, `modal`. */
  readonly name: string;
  readonly args: NodeArgs;
  readonly loc: Loc;
}

/** One processing stage of a layer's `>>` chain. */
export interface EffectNode {
  readonly kind: 'effect';
  /** Effect name, e.g. `bp`, `dist`, `verb`. */
  readonly name: string;
  readonly args: NodeArgs;
  readonly loc: Loc;
}

/** The `| gain ... decay ...` section: amplitude contour of the layer's source. */
export interface EnvelopeNode {
  readonly args: NodeArgs;
  readonly loc: Loc;
}

/**
 * One layer of a sound.
 *
 * Signal flow is `source -> envelope -> chain -> mix`: the envelope shapes the
 * source, and the `>>` chain runs *after* it, so `delay`/`verb` tails outlive
 * the decay. The written order (`source >> chain | envelope`) is chosen for
 * readability, not for signal order — see docs/SOUNDLINE_GRAMMAR.md.
 */
export interface LayerNode {
  readonly name: string;
  readonly source: SourceNode;
  readonly chain: readonly EffectNode[];
  readonly envelope: EnvelopeNode;
  /** Own-line `#` comments directly above this layer, raw text after `#`. */
  readonly leading: readonly string[];
  /** Same-line trailing `#` comment, raw text after `#`. */
  readonly trailing?: string;
  readonly loc: Loc;
}

/** A parsed soundline document — the single source of truth for a sound. */
export interface SoundAST {
  readonly name: string;
  /** Total-duration contract from the header; unit is `ms` or `s`. */
  readonly duration: NumberLiteral;
  readonly category: SoundCategory;
  /** True when the header carries the `loop` flag. */
  readonly loop: boolean;
  readonly layers: readonly LayerNode[];
  /** Own-line `#` comments above the header. */
  readonly leading: readonly string[];
  /** Same-line trailing `#` comment on the header. */
  readonly trailing?: string;
  readonly loc: Loc;
}

/* ------------------------------------------------------------------------- *
 * Validation
 * ------------------------------------------------------------------------- */

/** Severity of a validation issue. `error` blocks codegen, `warn` does not. */
export type IssueSeverity = 'error' | 'warn';

/**
 * A physical-invariant violation.
 *
 * Written for two readers at once: a human sees `rule`/`got`/`expected`, and
 * the LLM in the agent loop is handed `hint` as a direct instruction.
 */
export interface ValidationIssue {
  readonly severity: IssueSeverity;
  /** Layer name, or `null` for sound-wide issues. */
  readonly layer: string | null;
  /** Stable machine-readable rule id, e.g. `pop.max-duration`. */
  readonly rule: string;
  /** What the soundline actually says, formatted for a human. */
  readonly got: string;
  /** What the invariant demands. */
  readonly expected: string;
  /** Imperative fix, phrased as an instruction to the model. */
  readonly hint: string;
  readonly loc?: Loc;
}

/* ------------------------------------------------------------------------- *
 * Acoustic profile
 * ------------------------------------------------------------------------- */

/**
 * Compact deterministic fingerprint of a rendered sound.
 *
 * Extracted identically from a candidate render and from a reference sample,
 * which is what makes candidate-vs-target comparison meaningful.
 */
export interface SoundProfile {
  /** Duration down to -60 dBFS, in milliseconds. */
  readonly durationMs: number;
  /** Time from onset to peak RMS, in milliseconds. */
  readonly attackMs: number;
  /** 64-point RMS envelope, normalized to a peak of 1. */
  readonly rmsEnvelope: readonly number[];
  /** 32-point spectral-centroid trajectory, in Hz. */
  readonly centroidHz: readonly number[];
  /** Median spectral flatness: 0 = pure tone, 1 = white noise. */
  readonly flatness: number;
  /** Share of energy outside harmonic peaks, 0..1. */
  readonly noiseRatio: number;
  /** Dominant frequency, in Hz. */
  readonly peakHz: number;
  /** Approximate integrated loudness, in LUFS. */
  readonly loudnessLufsApprox: number;
}

/* ------------------------------------------------------------------------- *
 * Recipe bank
 * ------------------------------------------------------------------------- */

/**
 * Whoever published a recipe or wrote a comment.
 *
 * Deliberately three fields. The bank stores what it needs to attribute a sound and
 * to ban an account, and an identity provider will happily hand over an email
 * address, a company and a location that this project has no use for and would then
 * have to protect.
 */
export interface Author {
  readonly id: number;
  /** Handle at the identity provider, e.g. a GitHub login. */
  readonly login: string;
  readonly avatarUrl: string;
}

/** A solved sound stored in the recipe bank. */
export interface Recipe {
  readonly id: number;
  readonly name: string;
  /** The user prompt this recipe answers. */
  readonly prompt: string;
  /** Source of truth — everything else is derived from it. */
  readonly soundline: string;
  readonly profile: SoundProfile;
  readonly category: SoundCategory;
  readonly tags: readonly string[];
  readonly durationMs: number;
  /**
   * How many people liked it.
   *
   * Not a vanity number: retrieval orders by it and few-shot selection prefers it,
   * so a like is the community telling the next person's model which recipes are
   * worth imitating.
   */
  readonly rating: number;
  /** ISO-8601 timestamp. */
  readonly createdAt: string;
  /** Absent for the reference set in `examples/`, which has no author. */
  readonly author?: Author;
  /** The recipe this one was derived from, when it is a remix. */
  readonly parentId?: number;
  /** Hash of the canonical form — the identity that deduplication uses. */
  readonly fingerprint?: string;
  /** Number of visible comments. Absent when the source did not count them. */
  readonly comments?: number;
}

/**
 * A reply on a recipe.
 *
 * The interesting field is `soundline`. A comment may answer with a sound — "your
 * gate, with 40 ms off the tail" — and when it does, that text went through the same
 * parse, validate and render as a published recipe. It is the one thing in this
 * system that is both a discussion and a proposal, and it is also why the comment
 * form is hard for a spammer to use: the valuable move requires the grammar.
 */
export interface RecipeComment {
  readonly id: number;
  readonly recipeId: number;
  readonly author: Author;
  readonly body: string;
  /** A counter-proposal, already validated and rendered. */
  readonly soundline?: string;
  /** ISO-8601 timestamp. */
  readonly createdAt: string;
}

/** Payload accepted by `POST /api/recipes`. */
export interface RecipeInput {
  readonly name: string;
  readonly prompt: string;
  readonly soundline: string;
  readonly profile: SoundProfile;
  readonly category: SoundCategory;
  readonly tags: readonly string[];
  readonly durationMs: number;
}
