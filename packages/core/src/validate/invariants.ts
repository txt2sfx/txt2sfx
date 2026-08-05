/**
 * Physical invariants of a soundline document, one function per rule.
 *
 * ## Why this exists at all
 *
 * The parser answers "is this a soundline?"; these rules answer "is this the
 * sound it claims to be?". A `pop` that lasts 400 ms parses perfectly and is
 * still not a pop, and a language model asked for a bubble pop will write that
 * 400 ms sweep confidently. Every rule here turns a number from
 * `shared/constants.ts` into a {@link ValidationIssue} whose `hint` is phrased
 * as an instruction, because the primary reader is the model in the agent loop
 * and the cheapest fix is the one it can apply without asking.
 *
 * ## What cannot live here
 *
 * Peak amplitude. Layers do not reach their peaks simultaneously — different
 * attacks, decays and delays spread them — and a high-pass differentiates, so a
 * filter can push the peak *above* its input. The sum of layer gains is neither
 * an upper nor a lower bound on the rendered peak, so peak invariants are
 * checked on the render instead (`validateRender` in `./index.ts`).
 *
 * ## Severity by magnitude
 *
 * Two rules grade themselves: the duration contract and the attack-vs-voice
 * check. Both compare against an estimate rather than a measurement — a decay
 * tail is an exponential approximated to -60 dB, an effect tail is a formula
 * capped at 4 s — so a few percent of disagreement is estimation noise, while a
 * factor of two is a different sound than the header advertises. Grading keeps
 * the loop from burning an iteration on rounding.
 *
 * @packageDocumentation
 */

import type {
  LayerNode,
  NodeArgs,
  NumberArg,
  NumberLiteral,
  ParamSpec,
  Signature,
  SoundAST,
  SourceNode,
  ValidationIssue,
} from '@txt2sfx/shared';
import { CATEGORY_LIMITS, GLOBAL_LIMITS } from '@txt2sfx/shared';
import { declaredDurationMs, layerEndMs, soundDurationMs } from '../compile/duration.js';
import { envelopeTiming } from '../compile/envelope.js';
import { ENVELOPE, lookupSignature } from '../grammar/signatures.js';
import { canonicalValue, formatNumber } from '../grammar/units.js';
import { numberOf, rampSpanMs } from '../primitives/args.js';

/** One invariant. Rules append to `out` and never throw on a parsed AST. */
export type Rule = (ast: SoundAST, out: ValidationIssue[]) => void;

/* ------------------------------------------------------------------------- *
 * Thresholds
 * ------------------------------------------------------------------------- */

/**
 * Fraction of the declared duration the real sound may overrun before anyone
 * complains, and the floor of that allowance in milliseconds.
 *
 * 5 % is inside the error of the tail estimate itself, and the floor keeps very
 * short sounds from being held to sub-millisecond precision: a 35 ms pop that
 * ends at 37 ms is not lying about anything.
 */
const DURATION_SLACK = 0.05;
const DURATION_SLACK_FLOOR_MS = 10;

/** Overrun beyond which the header is not loose but wrong. */
const DURATION_ERROR_RATIO = 1.25;

/* ------------------------------------------------------------------------- *
 * Formatting
 * ------------------------------------------------------------------------- */

const ms = (value: number): string => `${formatNumber(Math.round(value * 10) / 10)}ms`;

const hz = (value: number): string =>
  value >= 1000
    ? `${formatNumber(Math.round(value / 10) / 100)}kHz`
    : `${formatNumber(Math.round(value * 10) / 10)}Hz`;

const percent = (ratio: number): string => `${formatNumber(Math.round(ratio * 100))}%`;

/* ------------------------------------------------------------------------- *
 * Walking the AST
 * ------------------------------------------------------------------------- */

/**
 * Signature of a primitive or effect the parser has already accepted.
 *
 * The lookup cannot miss on a parsed AST — an unknown name is a parse error —
 * so a miss here means the signature table and the parser have drifted apart,
 * which is a bug, not a validation issue.
 */
function sigOf(name: string): Signature {
  const sig = lookupSignature(name);
  if (sig === undefined) throw new Error(`no signature for '${name}' — parser and signature table disagree`);
  return sig;
}

/** One written numeric argument, with everything needed to judge it. */
interface ArgSite {
  readonly layer: LayerNode;
  /** `tone`, `bp`, `envelope` — how the issue names the offender. */
  readonly owner: string;
  /** The whole argument bag the parameter came from. */
  readonly args: NodeArgs;
  readonly spec: ParamSpec;
  readonly arg: NumberArg;
}

/** Every numeric argument that was actually written, in source order. */
function* numericArgs(ast: SoundAST): Generator<ArgSite> {
  for (const layer of ast.layers) {
    const nodes: readonly (readonly [string, NodeArgs])[] = [
      [layer.source.name, layer.source.args],
      ...layer.chain.map((effect) => [effect.name, effect.args] as const),
      ['envelope', layer.envelope.args],
    ];
    for (const [owner, args] of nodes) {
      const sig = owner === 'envelope' ? ENVELOPE : sigOf(owner);
      for (const spec of sig.params) {
        const arg = args[spec.name];
        if (arg !== undefined && arg.kind === 'number') yield { layer, owner, args, spec, arg };
      }
    }
  }
}

/** Canonical value of a slot bound, which is written in the literal's unit. */
function boundValue(bound: number, literal: NumberLiteral, spec: ParamSpec): number {
  return canonicalValue({ value: bound, unit: literal.unit, loc: literal.loc }, spec.kind);
}

/* ------------------------------------------------------------------------- *
 * Rules: the header's duration contract
 * ------------------------------------------------------------------------- */

/** Declared duration against the category's plausible range. */
const categoryDuration: Rule = (ast, out) => {
  const limits = CATEGORY_LIMITS[ast.category];
  const declared = declaredDurationMs(ast);

  if (declared < limits.minDurationMs) {
    out.push({
      severity: 'error',
      layer: null,
      rule: `${ast.category}.min-duration`,
      got: ms(declared),
      expected: `>= ${ms(limits.minDurationMs)}`,
      hint: `A ${ast.category} shorter than ${ms(limits.minDurationMs)} does not read as one. Lengthen the header duration, or change the category.`,
      loc: ast.duration.loc,
    });
  }
  if (declared > limits.maxDurationMs) {
    out.push({
      severity: 'error',
      layer: null,
      rule: `${ast.category}.max-duration`,
      got: ms(declared),
      expected: `<= ${ms(limits.maxDurationMs)}`,
      hint: `${limits.doc} At ${ms(declared)} this is a different kind of event. Shorten the header duration and the layer decays, or change the category.`,
      loc: ast.duration.loc,
    });
  }
};

/**
 * What the sound really does against what its header promised.
 *
 * The signal order is `source -> envelope -> chain`, so `delay` and `verb`
 * tails outlive the decay and count. That is what catches the case this rule
 * was written for: a rotor built from a 90 ms delay at 0.88 feedback rings for
 * over four seconds behind a header that claims 1.5, and for a `loop` sound
 * that is not a detail — the loop period is the thing being declared.
 */
const durationContract: Rule = (ast, out) => {
  const declared = declaredDurationMs(ast);
  const actual = soundDurationMs(ast);
  const slack = Math.max(DURATION_SLACK_FLOOR_MS, declared * DURATION_SLACK);
  if (actual <= declared + slack) return;

  const ratio = actual / declared;
  const longest = ast.layers.reduce(
    (worst, layer) => (layerEndMs(layer) > layerEndMs(worst) ? layer : worst),
    ast.layers[0] as LayerNode,
  );

  out.push({
    severity: ratio > DURATION_ERROR_RATIO ? 'error' : 'warn',
    layer: longest.name,
    rule: 'duration.contract',
    got: `${ms(actual)} of audible sound (${percent(ratio - 1)} over)`,
    expected: `<= ${ms(declared)} as declared in the header`,
    hint:
      ast.loop && longest.chain.length > 0
        ? `Layer '${longest.name}' keeps sounding past the declared loop period, so the loop will not seam. Either raise the header duration to ${ms(actual)} or shorten the effect tail (lower feedback or delay/verb time).`
        : `Layer '${longest.name}' ends at ${ms(layerEndMs(longest))}. Either raise the header duration to ${ms(actual)} or shorten that layer's decay and effect tails.`,
    loc: ast.duration.loc,
  });
};

/* ------------------------------------------------------------------------- *
 * Rules: per-layer shape
 * ------------------------------------------------------------------------- */

/** Longest decay any single layer may declare in this category. */
const layerDecay: Rule = (ast, out) => {
  const limits = CATEGORY_LIMITS[ast.category];
  for (const layer of ast.layers) {
    const decayMs = numberOf(layer.envelope.args, ENVELOPE, 'decay');
    if (decayMs <= limits.maxLayerDecayMs) continue;
    out.push({
      severity: 'error',
      layer: layer.name,
      rule: `${ast.category}.max-layer-decay`,
      got: `decay ${ms(decayMs)}`,
      expected: `<= ${ms(limits.maxLayerDecayMs)}`,
      hint: `Shorten '${layer.name}' to decay ${ms(limits.maxLayerDecayMs)} or less. A tail longer than the whole event is what makes a short sound feel smeared.`,
      loc: layer.envelope.loc,
    });
  }
};

/**
 * The anti-"pew" rule.
 *
 * A long frequency ramp is the single most common way a model turns a bubble pop
 * into a cartoon laser: it hears "pop" and writes a 120 ms sweep. Filter sweeps
 * count too — a band-pass gliding over 120 ms sings just as much as an
 * oscillator does.
 */
const freqRamp: Rule = (ast, out) => {
  const limits = CATEGORY_LIMITS[ast.category];
  for (const { layer, owner, args, spec, arg } of numericArgs(ast)) {
    if (spec.kind !== 'freq' || arg.ramp.length === 0) continue;
    const spanMs = rampSpanMs(args, spec.name);
    if (spanMs <= limits.maxFreqRampMs) continue;
    out.push({
      severity: 'error',
      layer: layer.name,
      rule: `${ast.category}.max-freq-ramp`,
      got: `${owner} ${spec.name} ramps for ${ms(spanMs)}`,
      expected: `<= ${ms(limits.maxFreqRampMs)}`,
      hint: `Shorten the ${owner} ${spec.name} ramp in '${layer.name}' to ${ms(limits.maxFreqRampMs)} or less, or drop the ramp entirely. A slow sweep reads as a laser, not as a ${ast.category}.`,
      loc: arg.loc,
    });
  }
};

/**
 * Intrinsic length of a source's voice, independent of its envelope.
 *
 * Only `click` has one: its buffer is exactly `width` long, and everything else
 * sustains until the envelope closes. Returning `null` for the rest is the
 * point — an oscillator cannot be shorter than its own envelope.
 */
function intrinsicVoiceMs(source: SourceNode): number | null {
  if (source.name !== 'click') return null;
  return numberOf(source.args, sigOf('click'), 'width');
}

/**
 * An envelope that is still opening when its source has already finished.
 *
 * The most expensive silent failure found so far: `click 0.3ms` under the
 * default `attack 1ms` peaks at about -41 dBFS — effectively inaudible — and
 * nothing in the parser or the renderer says a word. The layer is there, the
 * numbers look reasonable, and the sound simply is not.
 */
const attackVsVoice: Rule = (ast, out) => {
  for (const layer of ast.layers) {
    const voiceMs = intrinsicVoiceMs(layer.source);
    if (voiceMs === null) continue;
    const attackMs = numberOf(layer.envelope.args, ENVELOPE, 'attack');
    if (attackMs <= voiceMs / 2) continue;

    /* No decibel figure in the hint on purpose. The envelope's own attenuation is
       computable — the ramp only reaches `voice / attack` of its peak before the
       source ends — but the audible loss is not: the layer's chain and the source's
       own spectrum decide the rest, which is why the case that motivated this rule
       measured -41 dBFS where the envelope alone accounts for about -15. A number
       that specific and that wrong is worse than no number, and the instruction is
       the part the model acts on. */
    out.push({
      severity: attackMs > voiceMs ? 'error' : 'warn',
      layer: layer.name,
      rule: 'envelope.attack-longer-than-voice',
      got: `attack ${ms(attackMs)} over a ${ms(voiceMs)} ${layer.source.name}`,
      expected: `attack <= ${ms(voiceMs / 2)}`,
      hint: `Write 'attack 0ms' in '${layer.name}'. The envelope is still opening when the impulse is already over, so the layer never reaches the gain it asks for and can end up inaudible. A click needs no attack ramp to avoid a discontinuity — it *is* one.`,
      loc: layer.envelope.loc,
    });
  }
};

/* ------------------------------------------------------------------------- *
 * Rules: sound-wide structure
 * ------------------------------------------------------------------------- */

/**
 * Layer budget.
 *
 * Two caps meet here: the category's (transient sounds need fewer layers than
 * an explosion) and the global one, past which the export stops being compact.
 * The tighter of the two wins, and the message says which bound bit.
 */
const layerCount: Rule = (ast, out) => {
  const limits = CATEGORY_LIMITS[ast.category];
  const cap = Math.min(limits.maxLayers, GLOBAL_LIMITS.maxLayers);
  if (ast.layers.length <= cap) return;
  const offender = ast.layers[cap] ?? ast.layers[ast.layers.length - 1];
  out.push({
    severity: 'error',
    layer: offender?.name ?? null,
    rule: `${ast.category}.max-layers`,
    got: `${formatNumber(ast.layers.length)} layers`,
    expected:
      limits.maxLayers <= GLOBAL_LIMITS.maxLayers
        ? `<= ${formatNumber(cap)} for ${ast.category}`
        : `<= ${formatNumber(cap)} globally`,
    hint: `Merge or drop layers until ${formatNumber(cap)} remain. Two layers doing the same spectral job usually means one of them can carry both.`,
    loc: offender?.loc ?? ast.loc,
  });
};

/** Categories that only make sense as a loop must say `loop`. */
const loopFlag: Rule = (ast, out) => {
  const limits = CATEGORY_LIMITS[ast.category];
  if (!limits.requiresLoop || ast.loop) return;
  out.push({
    severity: 'error',
    layer: null,
    rule: `${ast.category}.requires-loop`,
    got: 'no loop flag',
    expected: '`loop` in the header',
    hint: `Add 'loop' after the category: a ${ast.category} sound is a texture that has to run continuously, and a one-shot render of it just stops.`,
    loc: ast.loc,
  });
};

/* ------------------------------------------------------------------------- *
 * Rules: numbers
 * ------------------------------------------------------------------------- */

/**
 * Written values against the soft physical bounds in the signature table.
 *
 * "Soft" describes where the numbers come from — taste and practice, not
 * physics — not how seriously a violation is taken. A violation is always a
 * mistake worth blocking: `Q 400` on a biquad rings like a bell, an oscillator
 * at 19 kHz is inaudible to most of the audience, and a warning the agent loop
 * is free to ignore would cost an iteration to discover the same thing.
 *
 * One exception: a ramp *target* of exactly zero. `-> 0Hz` and `index -> 0` are
 * a supported idiom for "sweep down to nothing" — the compiler clamps
 * exponential ramps away from zero precisely so that intent survives — and
 * `ramp.exp-to-zero` already says what actually happens, with a better message
 * than a bounds complaint could. A head value of zero is a different thing and
 * still an error: a source that starts at nothing never starts.
 */
const paramRange: Rule = (ast, out) => {
  for (const { layer, owner, spec, arg } of numericArgs(ast)) {
    const literals: readonly NumberLiteral[] = [arg.head, ...arg.ramp.map((segment) => segment.to)];
    for (const literal of literals) {
      const value = canonicalValue(literal, spec.kind);
      if (value === 0 && literal !== arg.head) continue;
      const low = spec.min !== undefined && value < spec.min;
      const high = spec.max !== undefined && value > spec.max;
      if (!low && !high) continue;

      const unit = spec.kind === 'freq' ? hz : spec.kind === 'time' ? ms : formatNumber;
      const bound = low ? (spec.min as number) : (spec.max as number);
      out.push({
        severity: 'error',
        layer: layer.name,
        rule: 'param.range',
        got: `${owner} ${spec.name} ${unit(value)}`,
        expected: `${low ? '>=' : '<='} ${unit(bound)}`,
        hint: `Bring ${owner} ${spec.name} in '${layer.name}' to ${unit(bound)} or ${low ? 'above' : 'below'}. ${spec.doc}`,
        loc: literal.loc,
      });
    }
  }
};

/**
 * Slot bounds against the same signature limits.
 *
 * A slot is a licence for the optimizer to move a number, so a slot reaching
 * past a parameter's bound is a licence to produce an invalid sound — found in
 * phase 4, thousands of candidates later, rather than here. A warning rather
 * than an error because the seed value is still legal and the sound still
 * renders; the optimizer clamps.
 */
const slotRange: Rule = (ast, out) => {
  for (const { layer, owner, spec, arg } of numericArgs(ast)) {
    const literals: readonly NumberLiteral[] = [arg.head, ...arg.ramp.map((segment) => segment.to)];
    for (const literal of literals) {
      if (literal.slot === undefined) continue;
      const min = boundValue(literal.slot.min, literal, spec);
      const max = boundValue(literal.slot.max, literal, spec);
      const low = spec.min !== undefined && min < spec.min;
      const high = spec.max !== undefined && max > spec.max;
      if (!low && !high) continue;

      const unit = spec.kind === 'freq' ? hz : spec.kind === 'time' ? ms : formatNumber;
      out.push({
        severity: 'warn',
        layer: layer.name,
        rule: 'param.slot-range',
        got: `slot [${unit(min)}..${unit(max)}] on ${owner} ${spec.name}`,
        expected: `within [${unit(spec.min ?? min)}..${unit(spec.max ?? max)}]`,
        hint: `Narrow the slot on ${owner} ${spec.name} in '${layer.name}' to the parameter's own range. The optimizer searches the whole interval and will spend candidates on values that cannot sound right.`,
        loc: literal.loc,
      });
    }
  }
};

/**
 * Exponential ramps that aim at zero.
 *
 * Web Audio's `exponentialRampToValueAtTime` cannot reach zero, and the
 * compiler clamps such targets to -60 dBFS so the intent survives — which is
 * why this is a warning and not an error. It is still worth saying: the model
 * that wrote `-> 0Hz` believes the pitch lands at zero, and the number it will
 * actually hear is the clamp.
 */
const expRampToZero: Rule = (ast, out) => {
  for (const { layer, owner, spec, arg } of numericArgs(ast)) {
    for (const segment of arg.ramp) {
      if (segment.curve !== 'exp' || canonicalValue(segment.to, spec.kind) !== 0) continue;
      out.push({
        severity: 'warn',
        layer: layer.name,
        rule: 'ramp.exp-to-zero',
        got: `${owner} ${spec.name} -> 0`,
        expected: `a non-zero target, or '-> lin 0'`,
        hint: `An exponential ramp cannot reach zero; this one is clamped to ${formatNumber(GLOBAL_LIMITS.minExpTarget)} (-60 dB). Write the floor you mean, or use '-> lin 0' if you want it to actually land on zero.`,
        loc: segment.to.loc,
      });
    }
  }
};

/**
 * A descending pitch sweep in the `pop` category.
 *
 * Measured against a reference game pop: the resonance climbs 960 -> 1109 Hz
 * over 8 ms, which is Minnaert's signature for a collapsing cavity — the cavity
 * shrinks, so its resonance rises. Sweeping the other way puts the energy at
 * the bottom of the range and produces a dull thud; that exact mistake cost the
 * project's own reference recipe its resemblance. A warning, because a
 * descending pop is occasionally what someone wants.
 */
const risingResonance: Rule = (ast, out) => {
  if (ast.category !== 'pop') return;
  for (const layer of ast.layers) {
    const sig = sigOf(layer.source.name);
    for (const spec of sig.params) {
      const arg = layer.source.args[spec.name];
      if (spec.kind !== 'freq' || arg === undefined || arg.kind !== 'number' || arg.ramp.length === 0) continue;
      const from = canonicalValue(arg.head, spec.kind);
      const last = arg.ramp[arg.ramp.length - 1];
      if (last === undefined) continue;
      const to = canonicalValue(last.to, spec.kind);
      if (to >= from) continue;
      out.push({
        severity: 'warn',
        layer: layer.name,
        rule: 'pop.rising-resonance',
        got: `${layer.source.name} ${spec.name} falls ${hz(from)} -> ${hz(to)}`,
        expected: 'a rising sweep, or no sweep',
        hint: `Sweep upwards in '${layer.name}' — a bursting cavity's resonance rises as it collapses (Minnaert), so a falling sweep parks the energy at the bottom of the range and sounds like a dull thud instead of a pop.`,
        loc: arg.loc,
      });
    }
  }
};

/* ------------------------------------------------------------------------- *
 * Registry
 * ------------------------------------------------------------------------- */

/**
 * Every invariant, in the order issues are reported.
 *
 * Sound-wide rules come first: a wrong category or a wrong header duration
 * makes every per-layer complaint downstream of it questionable, and the model
 * should read the structural problem first.
 */
export const INVARIANTS: readonly Rule[] = [
  categoryDuration,
  loopFlag,
  layerCount,
  durationContract,
  layerDecay,
  freqRamp,
  attackVsVoice,
  paramRange,
  slotRange,
  expRampToZero,
  risingResonance,
];
