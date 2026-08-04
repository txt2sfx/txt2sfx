/**
 * `@txt2sfx/shared` — the vocabulary every other package speaks.
 *
 * Types only plus a table of physical constants; zero runtime dependencies and
 * zero behaviour, so it can be imported from the browser, from Node and from
 * the worker that runs the optimizer alike.
 *
 * @packageDocumentation
 */

export type {
  ArgValue,
  EffectNode,
  EnumArg,
  EnvelopeNode,
  IssueSeverity,
  LayerNode,
  ListArg,
  Loc,
  NodeArgs,
  NumberArg,
  NumberLiteral,
  ParamKind,
  ParamSpec,
  RampSegment,
  Recipe,
  RecipeInput,
  Signature,
  SlotRange,
  SoundAST,
  SoundCategory,
  SoundProfile,
  SourceNode,
  Unit,
  ValidationIssue,
} from './types.js';

export type { CategoryLimits } from './constants.js';
export { CATEGORY_LIMITS, GLOBAL_LIMITS, SOUND_CATEGORIES, UNITS } from './constants.js';
