/**
 * Master transforms: multiply every number of one kind, or move the brightness
 * of every layer.
 *
 * These are the three knobs a recipe has *above* its slots — pitch, length,
 * brightness — and they are grammar-aware rather than textual: which numbers are
 * frequencies and which are durations comes from the signature table, never from
 * a list of parameter names written out here. Add a primitive with a `freq`
 * parameter and the pitch master already moves it.
 *
 * ## The candidate is text
 *
 * Same decision as `optimizer/src/slots.ts`, for the same reasons: values are
 * written back into the source at each literal's own span and the caller re-parses,
 * so what the editor shows is exactly what was measured, comments and spacing
 * survive untouched, and there is no second tree-rewriting path to keep correct.
 * A parse is microseconds — cheaper than the render it feeds.
 *
 * The three implementations of "write a number back at its span" (here, the
 * optimizer's `applyVector`, the playground's `applySlot`) are deliberately not
 * merged in this change: both of the others are covered by tests and working, and
 * the shared helper is a follow-up, not a rider on a feature.
 *
 * ## Why brightness is not just another kind
 *
 * A `ratio` over one `ParamKind` cannot express "darker": brightness lives in the
 * filters, and a recipe may have none. So:
 *
 * - `lp` and `hp` cutoffs move with the ratio. Both, because the pair is a
 *   spectral window and moving only its top would turn every darkening into a
 *   narrowing.
 * - `bp` is deliberately **not** treated as a filter here. A band-pass centre is
 *   the perceived *pitch* of the layer — it is what "turns flat noise into a
 *   pitched-sounding snap" — so it belongs to the pitch master (`kind: 'freq'`,
 *   which already moves it) and moving it from two knobs would make them fight.
 * - A layer with neither `lp` nor `hp` gets one inserted, at
 *   {@link OPEN_CUTOFF_HZ}. The rejected alternative was to leave such layers
 *   alone, which reads as a broken knob: a recipe of bare `noise` layers is
 *   exactly the one whose brightness a user most wants to pull down.
 *
 * @packageDocumentation
 */

import type {
  ArgValue,
  Loc,
  NodeArgs,
  NumberLiteral,
  ParamSpec,
  SoundAST,
} from '@txt2sfx/shared';
import { parse } from '../grammar/parser.js';
import { EFFECTS, ENVELOPE, lookupSignature } from '../grammar/signatures.js';
import { formatNumber, roundLiteral } from '../grammar/units.js';

/** Parameter kinds a master slider can multiply. */
export type ScalableKind = 'freq' | 'time';

/** Outcome of a master transform. */
export interface ScaleResult {
  /** The rewritten text; equal to the input when nothing of that kind is there. */
  readonly source: string;
  /**
   * How many literals the transform rewrote (an inserted filter counts as one).
   *
   * Zero means the knob has nothing to turn, which is what the interface mutes
   * a slider on — an honest dead control beats a live one that does nothing.
   */
  readonly touched: number;
}

/**
 * Cutoff of the low-pass inserted into a layer that has no filter of its own,
 * at ratio 1.
 *
 * 12 kHz is chosen to be inaudible at rest: the reference recipes' spectral
 * centroids all sit below 8 kHz (docs/ACOUSTIC_PROFILE.md), so at 44.1 kHz a
 * low-pass here removes air nobody put there, and only starts to darken the
 * sound once the ratio pulls it down.
 */
export const OPEN_CUTOFF_HZ = 12000;

/** One span replacement; a zero-length `loc` is an insertion. */
interface Edit {
  readonly loc: Loc;
  readonly text: string;
}

/**
 * Apply every edit in one pass, from the last span to the first.
 *
 * Going backwards means every earlier offset still refers to the character it
 * did when the AST was walked, so a whole set of edits can be applied against a
 * single parse instead of re-parsing between them.
 */
function replaceSpans(source: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.loc.offset - a.loc.offset);
  let out = source;
  for (const edit of ordered) {
    out = out.slice(0, edit.loc.offset) + edit.text + out.slice(edit.loc.offset + edit.loc.length);
  }
  return out;
}

/** Constrain a value to a closed interval. */
function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** A limit applied in the literal's own unit, after multiplication. */
type Bound = (value: number) => number;

/** No limit — the validator, not this transform, is what reports a silly number. */
const UNBOUNDED: Bound = (value) => value;

/**
 * Queue the edits that multiply one literal, and its slot bounds, by `ratio`.
 *
 * The value stays in the unit it was written in (multiplying kHz by 2 is still
 * kHz), and the bounds are written bare, which is their canonical form — that
 * also normalizes the rare `[200ms..1s]` spelling instead of reproducing it.
 *
 * Two guards, both about {@link roundLiteral}: it is piecewise, so scaling can
 * collapse a narrow range onto a single number. When the rounded bounds no
 * longer increase they are left as written — `slot.range-order` is a hard parse
 * error and a transform that can produce a document the parser rejects is
 * unusable. The value is then clamped into whichever bounds ended up in the
 * text, because `slot.start-outside` is the same kind of hard error.
 */
function scaleLiteral(lit: NumberLiteral, ratio: number, bound: Bound, edits: Edit[]): void {
  let value = roundLiteral(bound(lit.value * ratio));

  const slot = lit.slot;
  if (slot !== undefined) {
    const min = roundLiteral(bound(slot.min * ratio));
    const max = roundLiteral(bound(slot.max * ratio));
    const { minLoc, maxLoc } = slot;
    if (min < max && minLoc !== undefined && maxLoc !== undefined) {
      edits.push({ loc: minLoc, text: formatNumber(min) }, { loc: maxLoc, text: formatNumber(max) });
      value = clamp(value, min, max);
    } else {
      value = clamp(value, slot.min, slot.max);
    }
  }

  edits.push({ loc: lit.loc, text: `${formatNumber(value)}${lit.unit}` });
}

/** The declared parameters of a primitive or effect, or none if it is unknown. */
function paramsOf(name: string): readonly ParamSpec[] {
  return lookupSignature(name)?.params ?? [];
}

/**
 * Scale every literal of `kind` in one node's arguments.
 *
 * A ramp target inherits the kind of the parameter it belongs to (`freq -> freq`),
 * while a ramp's `in` time is a duration whatever it is ramping — which is why
 * the length master stretches an FM index sweep and the pitch master does not.
 */
function scaleArgs(
  args: NodeArgs,
  params: readonly ParamSpec[],
  kind: ScalableKind,
  ratio: number,
  edits: Edit[],
): number {
  let touched = 0;
  for (const [name, arg] of Object.entries(args)) {
    if (arg.kind !== 'number') continue;
    const spec = params.find((p) => p.name === name);
    if (spec === undefined) continue;
    const headMatches = spec.kind === kind;
    if (headMatches) {
      scaleLiteral(arg.head, ratio, UNBOUNDED, edits);
      touched += 1;
    }
    for (const segment of arg.ramp) {
      if (headMatches) {
        scaleLiteral(segment.to, ratio, UNBOUNDED, edits);
        touched += 1;
      }
      if (kind === 'time') {
        scaleLiteral(segment.time, ratio, UNBOUNDED, edits);
        touched += 1;
      }
    }
  }
  return touched;
}

/**
 * Multiply every literal of one parameter kind by `ratio`, rewriting the text.
 *
 * Covers the header duration, every layer's source, effect chain and envelope,
 * and every ramp target and ramp time — which is what makes the result *the same
 * sound, transposed or stretched*, rather than a recipe whose parts have drifted
 * apart. Slot ranges travel with their value.
 *
 * @throws {SoundlineError} when `source` does not parse.
 */
export function scaleKind(source: string, kind: ScalableKind, ratio: number): ScaleResult {
  const ast: SoundAST = parse(source);
  const edits: Edit[] = [];
  let touched = 0;

  /* The header duration has no signature to look up: it is declared inline by the
     parser and is a time by definition. */
  if (kind === 'time') {
    scaleLiteral(ast.duration, ratio, UNBOUNDED, edits);
    touched += 1;
  }

  for (const layer of ast.layers) {
    touched += scaleArgs(layer.source.args, paramsOf(layer.source.name), kind, ratio, edits);
    for (const effect of layer.chain) {
      touched += scaleArgs(effect.args, paramsOf(effect.name), kind, ratio, edits);
    }
    touched += scaleArgs(layer.envelope.args, ENVELOPE.params, kind, ratio, edits);
  }

  return { source: replaceSpans(source, edits), touched };
}

/** The `freq` parameter of a filter — the authority on how far a cutoff may go. */
function filterFreqSpec(): ParamSpec {
  const spec = EFFECTS['lp']?.params.find((p) => p.name === 'freq');
  if (spec === undefined) throw new Error("the 'lp' signature has no 'freq' parameter");
  return spec;
}

/**
 * A cutoff limit expressed in the unit the literal was written in.
 *
 * The signature states its bounds in canonical hertz, so a `kHz` literal has to
 * be compared against them divided by a thousand rather than against the raw
 * numbers — otherwise `1.2kHz` would read as below the 20 Hz floor.
 */
function cutoffBound(spec: ParamSpec, unit: NumberLiteral['unit']): Bound {
  const perUnit = unit === 'kHz' ? 1000 : 1;
  const min = (spec.min ?? 0) / perUnit;
  const max = (spec.max ?? Number.POSITIVE_INFINITY) / perUnit;
  return (value) => clamp(value, min, max);
}

/** Whether an effect is one of the two filters brightness owns. */
function isBrightnessFilter(name: string): boolean {
  return name === 'lp' || name === 'hp';
}

/**
 * Move the brightness of every layer by `ratio`.
 *
 * Existing `lp`/`hp` cutoffs are multiplied (head, ramp targets and slot bounds
 * alike, clamped to what the signature allows); a layer with neither gets a
 * `>> lp <cutoff>` inserted just before its envelope. The inserted text is
 * spelled exactly as the serializer would spell it, so a canonical recipe stays
 * canonical.
 *
 * @throws {SoundlineError} when `source` does not parse.
 */
export function scaleBrightness(source: string, ratio: number): ScaleResult {
  const ast: SoundAST = parse(source);
  const spec = filterFreqSpec();
  const edits: Edit[] = [];
  let touched = 0;

  for (const layer of ast.layers) {
    const filters = layer.chain.filter((effect) => isBrightnessFilter(effect.name));

    if (filters.length === 0) {
      const cutoff = roundLiteral(cutoffBound(spec, 'Hz')(OPEN_CUTOFF_HZ * ratio));
      /* `EnvelopeNode.loc` is the `|` token, and the layer always has a space in
         front of it, so inserting there produces ` >> lp NNNNHz | ...` — the
         serializer's own spacing. */
      edits.push({
        loc: { ...layer.envelope.loc, length: 0 },
        text: `>> lp ${formatNumber(cutoff)}Hz `,
      });
      touched += 1;
      continue;
    }

    for (const filter of filters) {
      const arg: ArgValue | undefined = filter.args['freq'];
      if (arg === undefined || arg.kind !== 'number') continue;
      scaleLiteral(arg.head, ratio, cutoffBound(spec, arg.head.unit), edits);
      touched += 1;
      for (const segment of arg.ramp) {
        scaleLiteral(segment.to, ratio, cutoffBound(spec, segment.to.unit), edits);
        touched += 1;
      }
    }
  }

  return { source: replaceSpans(source, edits), touched };
}
