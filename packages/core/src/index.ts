/**
 * `@txt2sfx/core` — the soundline DSL.
 *
 * Phase 1 surface: lexer, parser, serializer and the signature table they share.
 * `validate`, `compile`, `render` and `codegen` land in later phases and will be
 * re-exported from here, so this module stays the single public entry point.
 *
 * @example
 * ```ts
 * import { parse, serialize } from '@txt2sfx/core';
 *
 * const ast = parse('sound "pop" 35ms pop\n  body: tone sine 480Hz | gain 0.9 decay 30ms\n');
 * console.log(serialize(ast));
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
  toHz,
  toLinear,
  toMs,
  unitAllowed,
} from './grammar/units.js';
