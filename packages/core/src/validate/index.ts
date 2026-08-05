/**
 * Validation: does this soundline describe the sound it claims to describe?
 *
 * Two entry points, because the invariants split cleanly in two:
 *
 * - {@link validate} reads the AST alone. Everything a category promises —
 *   duration, decays, ramp spans, layer budget — is knowable from the text.
 * - {@link validateRender} needs a rendered buffer. Peak amplitude is the case:
 *   layers do not peak at the same instant, and a high-pass differentiates and
 *   can push the peak above its input, so the sum of gains bounds nothing.
 *
 * Both return the same {@link ValidationIssue} shape, so a caller that has a
 * render just concatenates. `error` blocks code generation; `warn` does not.
 *
 * Nothing here throws on a parsed AST: the parser has already rejected unknown
 * names and missing required arguments, so validation always gets to say
 * everything it knows. A model handed one error at a time spends one iteration
 * per error.
 *
 * @packageDocumentation
 */

import type { SoundAST, ValidationIssue } from '@txt2sfx/shared';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { INVARIANTS } from './invariants.js';

export type { Rule } from './invariants.js';
export { INVARIANTS } from './invariants.js';

/** Every invariant violation in a soundline document, in reporting order. */
export function validate(ast: SoundAST): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const rule of INVARIANTS) rule(ast, issues);
  return issues;
}

/** Whether anything in a list blocks code generation. */
export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

/**
 * Measurements a render produces that the text cannot predict.
 *
 * Deliberately not the `RenderResult` type: the optimizer and the playground
 * both have these numbers without holding an `AudioBuffer`, and the analyzer
 * package must be able to supply them from a decoded reference.
 */
export interface RenderFacts {
  /** Largest absolute sample value across the whole mix. */
  readonly peak: number;
}

/**
 * Peak so low the sound is effectively missing: -34 dBFS.
 *
 * This exists because of a real failure that nothing else caught — an envelope
 * still opening when its source had already ended, rendering a layer at -41 dB.
 * A recipe that renders near silence is never what anyone asked for, and the
 * symptom is invisible in the text.
 */
const SILENT_PEAK = 0.02;

/** Invariants that only a rendered buffer can settle. */
export function validateRender(facts: RenderFacts): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (facts.peak > GLOBAL_LIMITS.maxPeak) {
    const overDb = 20 * Math.log10(facts.peak / GLOBAL_LIMITS.maxPeak);
    issues.push({
      severity: 'error',
      layer: null,
      rule: 'peak.max',
      got: `peak ${facts.peak.toFixed(3)}`,
      expected: `<= ${GLOBAL_LIMITS.maxPeak}`,
      hint: `Lower the loudest layer's gain by about ${overDb.toFixed(1)} dB. Do not normalize the render — clipping fixed after the fact hides which layer caused it.`,
    });
  }

  if (facts.peak < SILENT_PEAK) {
    const db = 20 * Math.log10(Math.max(facts.peak, 1e-6));
    issues.push({
      severity: 'warn',
      layer: null,
      rule: 'peak.silent',
      got: `peak ${facts.peak.toFixed(4)} (${db.toFixed(0)} dBFS)`,
      expected: `audible output, peak >= ${SILENT_PEAK}`,
      hint: "The sound renders as near silence. Check for an attack longer than its source, a gain near zero, or a filter tuned outside the layer's own spectrum.",
    });
  }

  return issues;
}

/**
 * Issues as text, one line each, in the format the parser already uses for
 * errors: `line L, col C: ...`.
 *
 * This is what goes into the LLM prompt verbatim. One line per issue keeps the
 * prompt small enough that a dozen issues do not push the grammar and the
 * few-shot examples out of the window, and the `rule` id gives the model
 * something stable to reason about across iterations.
 */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map(formatIssue).join('\n');
}

/** One issue as a single line. */
export function formatIssue(issue: ValidationIssue): string {
  const where = issue.loc === undefined ? '' : `line ${issue.loc.line}, col ${issue.loc.column}: `;
  const layer = issue.layer === null ? '' : ` in layer '${issue.layer}'`;
  return `${where}[${issue.severity}] ${issue.rule}${layer} — got ${issue.got}, expected ${issue.expected}. ${issue.hint}`;
}
