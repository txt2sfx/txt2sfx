/**
 * `@txt2sfx/core` — the soundline DSL, its compiler and its two backends.
 *
 * Current surface: lexer, parser, serializer, the signature table they share,
 * the physical-invariant validator, the compiler that turns an AST into an
 * {@link AudioIR}, and the two backends that play that IR — live `AudioNode`s
 * and exported JavaScript — plus offline rendering and a WAV writer. This module
 * is the single public entry point.
 *
 * @example
 * ```ts
 * import { codegen, parse, serialize } from '@txt2sfx/core';
 *
 * const ast = parse('sound "pop" 35ms pop\n  body: tone sine 480Hz | gain 0.9 decay 30ms\n');
 * console.log(serialize(ast));
 * console.log(codegen(ast).code);   // a self-contained (ctx, when) => void
 * ```
 *
 * @packageDocumentation
 */

export { SoundlineError, didYouMean, expectedList } from './grammar/errors.js';
export type { SoundlineErrorInit } from './grammar/errors.js';

export { describeToken, tokenNumber, tokenize } from './grammar/lexer.js';
export type { Token, TokenType } from './grammar/lexer.js';

export { parse, parseWithDiagnostics } from './grammar/parser.js';
export type { ParseResult } from './grammar/parser.js';

export { serialize, serializeLayer } from './grammar/serializer.js';

export {
  INVARIANTS,
  formatIssue,
  formatIssues,
  hasErrors,
  validate,
  validateRender,
} from './validate/index.js';
export type { RenderFacts, Rule } from './validate/index.js';

export {
  EFFECTS,
  EFFECT_NAMES,
  ENVELOPE,
  GLUED_PARAM_NAMES,
  MODAL_MATERIALS,
  NOISE_COLORS,
  PRIMITIVES,
  PRIMITIVE_NAMES,
  WAVEFORMS,
  lookupSignature,
} from './grammar/signatures.js';

export {
  UNITS_FOR_KIND,
  canonicalValue,
  describeUnits,
  formatLiteral,
  formatNumber,
  roundLiteral,
  toHz,
  toLinear,
  toMs,
  unitAllowed,
} from './grammar/units.js';

/* --- compiler ----------------------------------------------------------- */

export { DEFAULT_MAX_DURATION_MS, DEFAULT_SEED, compileToIR } from './compile/compile.js';
export type { CompileOptions } from './compile/compile.js';

export {
  EXP_EPSILON,
  IRBuilder,
  constantParam,
  constantValue,
  isConstant,
  normalizeSeed,
  quantizeIR,
  safeExpTarget,
} from './compile/ir.js';
export type {
  AudioIR,
  IRBufferSpec,
  IREdge,
  IRFilterType,
  IRNode,
  IRNoiseColor,
  IROscWave,
  IRParam,
  IRParamEvent,
  IRTarget,
} from './compile/ir.js';

export { CURVE_POINTS, bufferLength, fillBuffer, shaperCurve } from './compile/buffers.js';

export { envelopeParam, envelopeTiming } from './compile/envelope.js';
export type { EnvelopeTiming } from './compile/envelope.js';

export {
  declaredDurationMs,
  effectTailMs,
  layerEndMs,
  layerTailMs,
  soundDurationMs,
} from './compile/duration.js';

export { buildGraph, instantiate } from './compile/graph.js';
export type { BuildGraphOptions, GraphOptions } from './compile/graph.js';

export { codegen, codegenFromIR } from './compile/codegen.js';
export type { CodegenResult } from './compile/codegen.js';

/* --- primitives --------------------------------------------------------- */

export {
  EFFECT_DEFS,
  PRIMITIVE_DEFS,
  effectDef,
  primitiveDef,
  registryGaps,
} from './primitives/index.js';
export type { BuildContext, EffectDef, PrimitiveDef } from './primitives/index.js';

export { MATERIAL_RATIOS } from './primitives/modal.js';

/* --- render ------------------------------------------------------------- */

export { DEFAULT_PAD_MS, peakOf, renderSound } from './render/offline.js';
export type {
  OfflineContextFactory,
  OfflineContextOptions,
  RenderOptions,
  RenderResult,
} from './render/offline.js';

export { encodeWav } from './render/wav.js';
export type { WavBitDepth, WavOptions } from './render/wav.js';
