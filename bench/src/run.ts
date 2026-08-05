/**
 * SFX-Bench v0 — run the pipeline against the reference targets and score it.
 *
 * ```powershell
 * pnpm bench                              # scripted model, no key, reproducible
 * pnpm bench -- --strict                  # non-zero exit if a target regresses
 * pnpm bench -- --provider gemini         # a real model, key from GEMINI_API_KEY
 * pnpm bench -- --targets laser,coin --out bench/results.md
 * ```
 *
 * ## What the number means
 *
 * `distance` is {@link profileDistance} (or {@link soundDistance} with `--audio`)
 * between the accepted recipe's render and the reference recipe's render. Zero is
 * "the same sound"; the plan's measured matrix puts *different* reference sounds
 * between 0.36 and 0.60, so a target's `maxDistance` of 0.1 asks for something
 * distinctly closer than any two different sounds in the set.
 *
 * ## What it does not mean
 *
 * With the default scripted model this is a **regression benchmark for this
 * repository**, not a model evaluation: the replies are fixed, so a moved number
 * means the validator, the renderer, the optimizer or the loop changed. Point it at
 * a real provider and it becomes a model evaluation whose numbers move when the
 * model does. Both are useful; only the first is reproducible, which is why it is
 * the default.
 *
 * @packageDocumentation
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OfflineAudioContext as NodeOfflineAudioContext } from 'node-web-audio-api';
import type { SoundAST } from '@txt2sfx/shared';
import { codegen, parse, renderSound } from '@txt2sfx/core';
import { extractProfile, type Signal } from '@txt2sfx/analyzer';
import type { Target } from '@txt2sfx/optimizer';
import {
  anthropicProvider,
  generateSound,
  geminiProvider,
  httpBank,
  mockProvider,
  type GenerateResult,
  type LLMProvider,
} from '@txt2sfx/agent';
import { loadTargets, type BenchTarget } from './targets.js';

/** Command line, parsed. */
export interface Options {
  readonly provider: 'mock' | 'anthropic' | 'gemini';
  readonly model?: string;
  readonly bank?: string;
  readonly targets: readonly string[];
  readonly out?: string;
  readonly iterations: number;
  readonly generations: number;
  readonly populationSize: number;
  readonly seed: number;
  /** Include the spectral loss in the distance. Slower, and the stricter metric. */
  readonly audio: boolean;
  /** Exit non-zero when a target misses its threshold. For CI. */
  readonly strict: boolean;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      i++;
    } else {
      bare.add(name);
    }
  }

  const number = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${name} needs a number, got '${raw}'`);
    return value;
  };

  const provider = flags.get('provider') ?? 'mock';
  if (provider !== 'mock' && provider !== 'anthropic' && provider !== 'gemini') {
    throw new Error(`--provider must be mock, anthropic or gemini (got '${provider}')`);
  }

  return {
    provider,
    ...(flags.has('model') ? { model: flags.get('model') as string } : {}),
    ...(flags.has('bank') ? { bank: flags.get('bank') as string } : {}),
    targets: (flags.get('targets') ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
    ...(flags.has('out') ? { out: flags.get('out') as string } : {}),
    iterations: number('iterations', 4),
    /* Smaller than the optimizer's own defaults (60 × 24 ≈ 1500 renders): a bench
       run has to finish in a coffee break, and the recovery tests in phase 4 showed
       the reference recipes converge well inside this budget. */
    generations: number('generations', 24),
    populationSize: number('population', 16),
    seed: number('seed', 1),
    audio: bare.has('audio'),
    strict: bare.has('strict'),
    json: bare.has('json'),
  };
}

/**
 * Render an AST to mono samples.
 *
 * The samples are **copied** out of the `AudioBuffer`. `getChannelData` returns a
 * view into memory the native context owns; a bench run holds each target's signal
 * across hundreds of later renders, and when those contexts are collected the view
 * turns to NaN and the process dies without a JavaScript stack. This is the §11
 * reminder, honoured here.
 */
async function renderSignal(ast: SoundAST): Promise<Signal> {
  const result = await renderSound(ast, {
    context: (contextOptions) =>
      new NodeOfflineAudioContext(contextOptions) as unknown as OfflineAudioContext,
  });
  return {
    samples: Float32Array.from(result.buffer.getChannelData(0)),
    sampleRate: result.buffer.sampleRate,
  };
}

/** One row of the report. */
export interface BenchRow {
  readonly name: string;
  readonly exercises: string;
  readonly outcome: string;
  readonly accepted: boolean;
  readonly pass: boolean;
  readonly iterations: number;
  /**
   * What each attempt ended on, in order.
   *
   * The most informative column in the report: `render → accepted` says the loop
   * caught a clipping buffer and the model fixed it, `distance → accepted` says the
   * model was asked to restructure and did. A target whose path collapses to a
   * single `accepted` has stopped exercising the stage it was written for, and that
   * is a regression the distance column cannot show.
   */
  readonly path: readonly string[];
  readonly initialDistance: number | undefined;
  readonly distance: number | undefined;
  readonly maxDistance: number;
  readonly bytes: number | undefined;
  readonly withinBudget: boolean | undefined;
  readonly warnings: readonly string[];
  readonly elapsedMs: number;
  /** The final recipe, for `--json` and for eyeballing a regression. */
  readonly soundline: string;
  /** Last thing said to the model on a failed run — the useful debugging line. */
  readonly lastFeedback: string | undefined;
}

/** Build the provider for a run. Scripted replies are ignored by real providers. */
function providerFor(options: Options, target: BenchTarget): LLMProvider {
  if (options.provider === 'mock') {
    return mockProvider({
      replies: target.scripted.map((soundline) => `\`\`\`\n${soundline}\`\`\`\n`),
      name: 'mock',
      model: 'scripted',
    });
  }
  const envName = options.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
  const apiKey = process.env[envName];
  if (apiKey === undefined || apiKey === '') {
    throw new Error(`--provider ${options.provider} needs ${envName} in the environment. The key is always yours.`);
  }
  const factory = options.provider === 'anthropic' ? anthropicProvider : geminiProvider;
  return factory({ apiKey, ...(options.model === undefined ? {} : { model: options.model }) });
}

/** Run one target. */
export async function runTarget(target: BenchTarget, options: Options): Promise<BenchRow> {
  const referenceSignal = await renderSignal(parse(target.referenceSource));
  const audioTarget: Target = {
    profile: extractProfile(referenceSignal),
    ...(options.audio ? { signal: referenceSignal } : {}),
  };

  const provider = providerFor(options, target);
  const started = Date.now();
  const result: GenerateResult = await generateSound({
    prompt: target.prompt,
    provider,
    render: renderSignal,
    target: audioTarget,
    /* A scripted run gets exactly the iterations it has replies for; running past
       them would be the mock throwing, which says nothing about the pipeline. */
    maxIterations: options.provider === 'mock' ? target.scripted.length : options.iterations,
    targetDistance: target.maxDistance,
    optimizer: {
      generations: options.generations,
      populationSize: options.populationSize,
      seed: options.seed,
    },
    ...(options.bank === undefined ? {} : { bank: httpBank(options.bank) }),
  });
  const elapsedMs = Date.now() - started;

  const exported = result.ast === undefined ? undefined : codegen(result.ast);

  return {
    name: target.name,
    exercises: target.exercises,
    outcome: result.outcome,
    accepted: result.accepted,
    pass: result.accepted && (result.distance ?? Infinity) <= target.maxDistance,
    iterations: result.attempts.length,
    path: result.attempts.map((attempt) => attempt.outcome),
    initialDistance: result.initialDistance,
    distance: result.distance,
    maxDistance: target.maxDistance,
    bytes: exported?.bytes,
    withinBudget: exported?.withinBudget,
    warnings: result.issues.filter((issue) => issue.severity === 'warn').map((issue) => issue.rule),
    elapsedMs,
    soundline: result.soundline,
    lastFeedback: result.attempts.at(-1)?.feedback,
  };
}

const distance = (value: number | undefined): string => (value === undefined ? '—' : value.toFixed(3));

/** The report, as markdown. */
export function markdownReport(rows: readonly BenchRow[], options: Options): string {
  const head =
    '| target | result | path | distance | budget | export | ms |\n' +
    '| --- | --- | --- | --- | --- | --- | --- |';
  const body = rows
    .map((row) => {
      const verdict = row.pass ? 'pass' : `**${row.outcome}**`;
      const improvement =
        row.initialDistance === undefined || row.distance === undefined
          ? distance(row.distance)
          : `${distance(row.initialDistance)} → ${distance(row.distance)}`;
      const bytes =
        row.bytes === undefined ? '—' : `${String(row.bytes)} B${row.withinBudget === true ? '' : ' *(over)*'}`;
      return `| ${row.name} | ${verdict} | ${row.path.join(' → ')} | ${improvement} | ≤ ${distance(row.maxDistance)} | ${bytes} | ${String(row.elapsedMs)} |`;
    })
    .join('\n');

  const passed = rows.filter((row) => row.pass).length;
  const totalMs = rows.reduce((sum, row) => sum + row.elapsedMs, 0);

  const failures = rows
    .filter((row) => !row.pass)
    .map((row) => {
      const feedback = row.lastFeedback === undefined ? '' : `\n\nLast message to the model:\n\n> ${row.lastFeedback.trim().split('\n').join('\n> ')}`;
      return `### ${row.name} — ${row.outcome}\n\n${row.exercises}${feedback}\n\nWhat it ended on:\n\n\`\`\`\n${row.soundline === '' ? '(nothing)\n' : row.soundline}\`\`\``;
    });

  const warnings = rows
    .filter((row) => row.warnings.length > 0)
    .map((row) => `- ${row.name}: ${row.warnings.join(', ')}`);

  return [
    `# SFX-Bench v0`,
    '',
    `${String(passed)} of ${String(rows.length)} targets passed in ${(totalMs / 1000).toFixed(1)} s. ` +
      `Model: \`${options.provider}\`${options.model === undefined ? '' : ` (${options.model})`}; metric: ` +
      `${options.audio ? 'profile + spectral loss' : 'profile only'}; optimizer: ` +
      `${String(options.populationSize)} × ${String(options.generations)}, seed ${String(options.seed)}.`,
    '',
    head,
    body,
    '',
    ...(warnings.length === 0
      ? []
      : ['Validation warnings on accepted recipes (they do not block a pass):', '', ...warnings, '']),
    ...(failures.length === 0 ? [] : ['## What failed', '', ...failures]),
  ].join('\n');
}

/** Run every target and report. Returns the rows so a test can assert on them. */
export async function runBench(options: Options): Promise<BenchRow[]> {
  const targets = loadTargets(options.targets);
  const rows: BenchRow[] = [];
  for (const target of targets) {
    /* Sequentially and in filename order: the renders are CPU-bound, and a run
       whose numbers depend on how many cores were free is not a benchmark. */
    rows.push(await runTarget(target, options));
  }
  return rows;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rows = await runBench(options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    const report = markdownReport(rows, options);
    process.stdout.write(`${report}\n`);
    if (options.out !== undefined) {
      writeFileSync(resolve(options.out), report, 'utf8');
      process.stdout.write(`\nwritten to ${options.out}\n`);
    }
  }

  const failed = rows.filter((row) => !row.pass);
  if (failed.length > 0 && options.strict) {
    process.stderr.write(`\n${String(failed.length)} target(s) missed their threshold: ${failed.map((row) => row.name).join(', ')}\n`);
    process.exitCode = 1;
  }
}

/* Only when executed directly, so importing this module in a test does not run a
   benchmark. `pathToFileURL` rather than string surgery: on Windows the argv path
   is `C:\...` and a hand-built `file://` URL disagrees with `import.meta.url`. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
