/**
 * Bench targets: what a run is measured against.
 *
 * ## Why a scripted attempt lives in the target file
 *
 * A benchmark that needs an API key is a benchmark nobody runs, and one whose
 * numbers move every time a model is updated cannot tell you whether *this repo*
 * regressed. So each target carries the reply (or replies) a model is pretending to
 * give, and the default run measures everything downstream of the model: the
 * validator's report, the render checks, the optimizer's recovery, the export size.
 * Same targets, same "model", so the only thing that can move a score is a change
 * in this codebase.
 *
 * Pass a real provider and the same targets become a model evaluation instead, with
 * the scripted attempts ignored. Both are useful; only one is reproducible.
 *
 * @packageDocumentation
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TARGETS_DIR = fileURLToPath(new URL('../targets', import.meta.url));
const EXAMPLES_DIR = fileURLToPath(new URL('../../examples', import.meta.url));

/** One target, as it appears on disk. */
export interface TargetFile {
  /** Short id; also the row label. */
  readonly name: string;
  /** The prompt a person would type. This is what retrieval matches against. */
  readonly prompt: string;
  /** Reference recipe in `examples/`, rendered to become the target sound. */
  readonly reference: string;
  /** Distance that counts as a match for this target. */
  readonly maxDistance: number;
  /**
   * Scripted replies, one per iteration, each as a list of soundline lines.
   *
   * Lists rather than one string with `\n` escapes: a recipe is the thing a reader
   * of this file most needs to be able to read.
   */
  readonly attempts: readonly (readonly string[])[];
  /** What this target is *for* — which stage of the pipeline it exercises. */
  readonly exercises: string;
}

/** A loaded target: the file plus the reference source it names. */
export interface BenchTarget extends TargetFile {
  /** Source text of the reference recipe. */
  readonly referenceSource: string;
  /** The scripted replies as complete soundline documents. */
  readonly scripted: readonly string[];
}

/** Read one reference recipe, with newlines normalized (`.gitattributes` forces LF). */
export function loadExample(name: string): string {
  return readFileSync(`${EXAMPLES_DIR}/${name}.soundline`, 'utf8').replace(/\r\n/g, '\n');
}

/** Fail loudly and specifically: a malformed target file is a repo bug, not input. */
function assertShape(value: unknown, file: string): TargetFile {
  const target = value as Partial<TargetFile>;
  const problems: string[] = [];
  if (typeof target.name !== 'string') problems.push('name must be a string');
  if (typeof target.prompt !== 'string') problems.push('prompt must be a string');
  if (typeof target.reference !== 'string') problems.push('reference must be a string');
  if (typeof target.maxDistance !== 'number') problems.push('maxDistance must be a number');
  if (typeof target.exercises !== 'string') problems.push('exercises must be a string');
  if (
    !Array.isArray(target.attempts) ||
    target.attempts.length === 0 ||
    !target.attempts.every((attempt) => Array.isArray(attempt) && attempt.every((line) => typeof line === 'string'))
  ) {
    problems.push('attempts must be a non-empty array of arrays of strings');
  }
  if (problems.length > 0) {
    throw new Error(`${file}: ${problems.join('; ')}`);
  }
  return target as TargetFile;
}

/** Every target in `bench/targets`, in filename order so runs are comparable. */
export function loadTargets(only?: readonly string[]): BenchTarget[] {
  const files = readdirSync(TARGETS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();

  const targets = files.map((file) => {
    const parsed: unknown = JSON.parse(readFileSync(`${TARGETS_DIR}/${file}`, 'utf8'));
    const target = assertShape(parsed, file);
    return {
      ...target,
      referenceSource: loadExample(target.reference),
      /* A soundline document ends in a newline; the parser is fine either way, but
         the recipe stored in the bank after a run should be canonical. */
      scripted: target.attempts.map((lines) => `${lines.join('\n')}\n`),
    };
  });

  if (only === undefined || only.length === 0) return targets;
  const wanted = new Set(only);
  const selected = targets.filter((target) => wanted.has(target.name));
  const missing = only.filter((name) => !targets.some((target) => target.name === name));
  if (missing.length > 0) {
    throw new Error(`unknown target(s): ${missing.join(', ')}. Available: ${targets.map((t) => t.name).join(', ')}`);
  }
  return selected;
}
