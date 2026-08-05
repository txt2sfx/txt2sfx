/**
 * Load `examples/*.soundline` into the bank: parse, render, measure, store.
 *
 * ## Why the seeder validates but does not refuse
 *
 * `POST /api/recipes` rejects a soundline that breaks a physical invariant, and it
 * should — that is untrusted input arriving over HTTP. The seeder is not that. It
 * loads the repository's own reference set, and one of those recipes currently
 * carries a validation error on purpose: `helicopter` rings for about 4 s behind a
 * header claiming 1.5, which cannot be fixed by editing the header because 4 s is
 * past `cycle`'s own ceiling. Only a change to its DSP would fix it, and that is a
 * sound-design decision.
 *
 * So the seeder reports and loads. Refusing would leave the bank without its only
 * looped texture, and `GET /api/retrieve?prompt=helicopter rotor` would answer
 * nothing — a silent hole in the demonstration rather than a visible flaw in one
 * recipe. `--strict` flips it to refusing, which is the mode CI should use once the
 * finding has been resolved either way.
 *
 * ## The renderer is here and only here
 *
 * The server has no audio stack: it stores profiles, it does not measure them. The
 * seeder does, so `node-web-audio-api` is a devDependency of this package and is
 * imported nowhere else. Note the copy out of the `AudioBuffer` — `getChannelData`
 * returns a view into memory the native context owns, and holding it while
 * rendering the next recipe is how you get a profile full of NaN.
 *
 * @packageDocumentation
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { OfflineAudioContext as NodeOfflineAudioContext } from 'node-web-audio-api';
import type { SoundAST, ValidationIssue } from '@txt2sfx/shared';
import { declaredDurationMs, hasErrors, parse, renderSound, validate } from '@txt2sfx/core';
import { extractProfile } from '@txt2sfx/analyzer';
import type { RecipeBank } from './db.js';
import { configFromEnv, openConfiguredBank } from './index.js';

const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples', import.meta.url));

/**
 * The prompt each reference recipe answers.
 *
 * These matter more than they look: retrieval ranks against them, so they have to
 * read like something a person would actually type, not like a description of the
 * recipe. "coin pickup sound for a platformer" is a prompt; "two square-wave blips
 * a semitone apart" is documentation.
 */
const PROMPTS: Readonly<Record<string, { prompt: string; tags: readonly string[] }>> = {
  'bubble-pop': {
    prompt: 'bubble wrap pop, short and bright, for a casual puzzle game',
    tags: ['pop', 'bubble', 'puzzle', 'transient'],
  },
  coin: {
    prompt: 'coin pickup sound for a platformer, arcade style',
    tags: ['coin', 'pickup', 'arcade', 'reward'],
  },
  'door-creak': {
    prompt: 'old wooden door creaking open slowly, horror atmosphere',
    tags: ['door', 'creak', 'wood', 'hinge', 'horror'],
  },
  explosion: {
    prompt: 'big explosion with deep body and a long rumble tail',
    tags: ['explosion', 'blast', 'boom', 'rumble'],
  },
  'footstep-gravel': {
    prompt: 'footstep on gravel, crunchy, single step',
    tags: ['footstep', 'gravel', 'crunch', 'walk', 'foley'],
  },
  helicopter: {
    prompt: 'helicopter rotor loop, distant chopping blades',
    tags: ['helicopter', 'rotor', 'loop', 'engine', 'vehicle'],
  },
  laser: {
    prompt: 'sci-fi laser gun shot, descending zap',
    tags: ['laser', 'zap', 'shot', 'weapon', 'scifi'],
  },
  powerup: {
    prompt: 'power-up jingle, rising sweep with a sparkle on top',
    tags: ['powerup', 'jingle', 'reward', 'levelup'],
  },
  'sword-clash': {
    prompt: 'two swords clashing, metallic ring',
    tags: ['sword', 'metal', 'clash', 'impact', 'combat'],
  },
  'ui-click': {
    prompt: 'crisp ui click for a menu button',
    tags: ['ui', 'click', 'menu', 'button', 'interface'],
  },
};

/** Render one AST, copying the samples out of the native buffer. */
async function measure(ast: SoundAST): Promise<ReturnType<typeof extractProfile>> {
  const result = await renderSound(ast, {
    context: (options) => new NodeOfflineAudioContext(options) as unknown as OfflineAudioContext,
  });
  return extractProfile({
    samples: Float32Array.from(result.buffer.getChannelData(0)),
    sampleRate: result.buffer.sampleRate,
  });
}

/** What happened to one recipe. */
export interface SeedEntry {
  readonly name: string;
  readonly stored: boolean;
  readonly issues: readonly ValidationIssue[];
}

/** What happened overall. */
export interface SeedReport {
  readonly entries: readonly SeedEntry[];
  readonly stored: number;
  readonly withErrors: readonly string[];
  readonly withWarnings: readonly string[];
}

/** Options of {@link seedBank}. */
export interface SeedOptions {
  /** Refuse to store a recipe the validator rejects. Default false. */
  readonly strict?: boolean;
  /** Where to read recipes from. Defaults to the repository's `examples/`. */
  readonly directory?: string;
}

/**
 * Fill a bank from soundline files.
 *
 * Idempotent by name: a recipe already in the bank is left alone, so running the
 * seeder twice does not double every entry. Ratings and votes accumulated since the
 * first run therefore survive a re-seed, which is the behaviour anyone re-running
 * it after a schema change expects.
 */
export async function seedBank(bank: RecipeBank, options: SeedOptions = {}): Promise<SeedReport> {
  const directory = options.directory ?? EXAMPLES_DIR;
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.soundline'))
    .sort();

  const entries: SeedEntry[] = [];

  for (const file of files) {
    const name = file.replace(/\.soundline$/, '');
    const source = readFileSync(join(directory, file), 'utf8').replace(/\r\n/g, '\n');
    const ast = parse(source);
    const issues = validate(ast);
    const blocked = options.strict === true && hasErrors(issues);

    /* Asked per name, not against a listing: `list` is capped, so deduplicating
       against one would start re-inserting silently once the bank outgrew the cap. */
    if (blocked || bank.hasName(name)) {
      entries.push({ name, stored: false, issues });
      continue;
    }

    const meta = PROMPTS[name] ?? { prompt: name.replace(/-/g, ' '), tags: [name] };
    bank.insert({
      name,
      prompt: meta.prompt,
      soundline: source,
      profile: await measure(ast),
      category: ast.category,
      tags: meta.tags,
      durationMs: declaredDurationMs(ast),
    });
    entries.push({ name, stored: true, issues });
  }

  return {
    entries,
    stored: entries.filter((entry) => entry.stored).length,
    withErrors: entries.filter((entry) => hasErrors(entry.issues)).map((entry) => entry.name),
    withWarnings: entries
      .filter((entry) => entry.issues.length > 0 && !hasErrors(entry.issues))
      .map((entry) => entry.name),
  };
}

/** The report as lines for a terminal. */
export function formatReport(report: SeedReport): string {
  const lines = [`seeded ${String(report.stored)} of ${String(report.entries.length)} recipes`];
  for (const entry of report.entries) {
    const state = entry.stored ? 'stored ' : 'skipped';
    const note =
      entry.issues.length === 0
        ? ''
        : ` — ${entry.issues.map((issue) => `${issue.severity} ${issue.rule}`).join(', ')}`;
    lines.push(`  ${state} ${entry.name}${note}`);
  }
  if (report.withErrors.length > 0) {
    lines.push(
      `\n${String(report.withErrors.length)} recipe(s) carry validation errors: ${report.withErrors.join(', ')}.`,
      'They were stored anyway — the bank is the repository\'s own reference set, and a missing recipe',
      'is a silent hole. Re-run with --strict to refuse them instead.',
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const bank = openConfiguredBank(config);
  try {
    const report = await seedBank(bank, { strict: process.argv.includes('--strict') });
    console.log(formatReport(report));
    if (process.argv.includes('--strict') && report.withErrors.length > 0) process.exitCode = 1;
  } finally {
    bank.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
