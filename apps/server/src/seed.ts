/**
 * Load the repository's soundline files into the bank: parse, render, measure, store.
 *
 * ## Two directories, two contracts
 *
 * `examples/` is the reference set — ten recipes the tests and the documentation are
 * pinned against. `presets/` is the catalog the playground ships with, some ninety sounds
 * whose whole job is to be there before anybody has an API key. They are seeded
 * together because the bank does not distinguish them, but they are *held* to
 * different standards, and the difference is one line of policy:
 * {@link SeedDirectory.requireCleanRender}.
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
 * A preset gets no such exemption. It is the first sound a new user hears, the peak
 * is measured here anyway, and `presets/README.md` states the contract: under
 * `--strict` a preset that clips is refused exactly like one that fails validation.
 * That is why the seeder is also the authoring tool for this directory — it is the
 * only place that reports a measured peak per file.
 *
 * ## The renderer used to be here and only here
 *
 * It is now in `render.ts`, shared with `POST /api/recipes` — the server measures
 * what it stores rather than trusting a posted profile, which is both the honest
 * thing to do and the reason a write costs real work. The seeder calls the same
 * function, so a reference recipe and a published one are measured identically.
 *
 * @packageDocumentation
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { SoundAST, ValidationIssue } from '@txt2sfx/shared';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { declaredDurationMs, hasErrors, parse, recipeMeta, validate } from '@txt2sfx/core';
import type { RecipeBank } from './db.js';
import { measure } from './render.js';
import { configFromEnv, openConfiguredBank } from './index.js';

/**
 * One directory of recipes and the contract its files are held to.
 *
 * A flag rather than a comparison against a known path: the caller says what it is
 * asking for, so a test seeding a temporary directory gets to choose the policy
 * instead of inheriting whichever one a string match happened to pick.
 */
export interface SeedDirectory {
  readonly path: string;
  /**
   * Whether `--strict` also refuses a recipe that clips.
   *
   * True for `presets/` and false for `examples/`. Both directories are validated
   * and measured either way; this only decides what `--strict` blocks on.
   */
  readonly requireCleanRender: boolean;
}

/** The reference set. Carries one deliberate validation error — see the header. */
export const EXAMPLES_DIR: SeedDirectory = {
  path: fileURLToPath(new URL('../../../examples', import.meta.url)),
  requireCleanRender: false,
};

/** The shipped catalog. Held to `presets/README.md`'s contract. */
export const PRESETS_DIR: SeedDirectory = {
  path: fileURLToPath(new URL('../../../presets', import.meta.url)),
  requireCleanRender: true,
};

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

/** What a recipe is stored as, whichever way it says it. */
interface StoredMeta {
  readonly prompt: string;
  readonly tags: readonly string[];
}

/**
 * The prompt and tags one recipe is filed under.
 *
 * Three sources in falling order of authority. `PROMPTS` covers `examples/`, whose
 * files carry no metadata of their own. A preset declares both in its own leading
 * comments, which is the whole point of `recipeMeta` — the description travels with
 * the recipe instead of living in a table here that nobody remembers to update. The
 * last fallback is for a directory that does neither: a searchable name beats an
 * empty prompt, which would silently rank against nothing.
 */
function metaFor(name: string, ast: SoundAST): StoredMeta {
  const listed = PROMPTS[name];
  if (listed !== undefined) return listed;
  const declared = recipeMeta(ast);
  if (declared.prompt !== null) return { prompt: declared.prompt, tags: declared.tags };
  return { prompt: name.replace(/-/g, ' '), tags: [name] };
}

/** What happened to one recipe. */
export interface SeedEntry {
  readonly name: string;
  readonly stored: boolean;
  readonly issues: readonly ValidationIssue[];
  /**
   * Measured peak amplitude, absent when the recipe was never rendered.
   *
   * A recipe already in the bank is skipped without rendering — that is what makes
   * a re-seed cheap — so "no peak" means "not measured this run", never "silent".
   */
  readonly peak?: number;
  /** Whether that peak exceeds `GLOBAL_LIMITS.maxPeak`. */
  readonly clipped?: boolean;
  /**
   * Why `--strict` refused this recipe, when it did.
   *
   * Absent both for a stored recipe and for one skipped because the bank already
   * had it — which is why the reason is recorded rather than inferred from
   * `stored === false`. A re-seed skips everything, and a report that called that
   * "refused" would describe a failure that did not happen.
   */
  readonly refused?: 'validation' | 'clipping';
}

/** What happened overall. */
export interface SeedReport {
  readonly entries: readonly SeedEntry[];
  readonly stored: number;
  readonly withErrors: readonly string[];
  readonly withWarnings: readonly string[];
  /**
   * Recipes measured above `GLOBAL_LIMITS.maxPeak`.
   *
   * Reported for every directory; only blocking for one that asked for a clean
   * render. This is the number an author of a preset is looking for.
   */
  readonly clipping: readonly string[];
}

/** Options of {@link seedBank}. */
export interface SeedOptions {
  /**
   * Refuse to store a recipe the validator rejects — and, in a directory that
   * requires a clean render, one that clips. Default false.
   */
  readonly strict?: boolean;
  /** Where to read recipes from. Defaults to `examples/` and then `presets/`. */
  readonly directories?: readonly SeedDirectory[];
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
  const directories = options.directories ?? [EXAMPLES_DIR, PRESETS_DIR];
  const entries: SeedEntry[] = [];

  for (const directory of directories) {
    const files = readdirSync(directory.path)
      .filter((file) => file.endsWith('.soundline'))
      .sort();

    for (const file of files) {
      const name = file.replace(/\.soundline$/, '');
      const source = readFileSync(join(directory.path, file), 'utf8').replace(/\r\n/g, '\n');
      const ast = parse(source);
      const issues = validate(ast);
      if (options.strict === true && hasErrors(issues)) {
        entries.push({ name, stored: false, issues, refused: 'validation' });
        continue;
      }

      /* Asked per name, not against a listing: `list` is capped, so deduplicating
         against one would start re-inserting silently once the bank outgrew the cap. */
      if (bank.hasName(name)) {
        entries.push({ name, stored: false, issues });
        continue;
      }

      /* The render happens before the decision to store, not after, because the
         clipping check needs it — and it is not wasted work either way: the profile
         is measured, never taken on trust. */
      const measured = await measure(ast);
      if (directory.requireCleanRender && options.strict === true && measured.clipped) {
        entries.push({ name, stored: false, issues, peak: measured.peak, clipped: measured.clipped, refused: 'clipping' });
        continue;
      }

      const meta = metaFor(name, ast);
      bank.insert({
        name,
        prompt: meta.prompt,
        soundline: source,
        profile: measured.profile,
        category: ast.category,
        tags: meta.tags,
        durationMs: declaredDurationMs(ast),
      });
      entries.push({ name, stored: true, issues, peak: measured.peak, clipped: measured.clipped });
    }
  }

  return {
    entries,
    stored: entries.filter((entry) => entry.stored).length,
    withErrors: entries.filter((entry) => hasErrors(entry.issues)).map((entry) => entry.name),
    withWarnings: entries
      .filter((entry) => entry.issues.length > 0 && !hasErrors(entry.issues))
      .map((entry) => entry.name),
    clipping: entries.filter((entry) => entry.clipped === true).map((entry) => entry.name),
  };
}

/**
 * The report as lines for a terminal.
 *
 * The measured peak is printed for every recipe that was rendered, not only for the
 * ones over the limit: this report is the authoring loop for `presets/`, and
 * "0.94" is worth seeing before it becomes "0.96" on someone else's machine.
 */
export function formatReport(report: SeedReport): string {
  const lines = [`seeded ${String(report.stored)} of ${String(report.entries.length)} recipes`];
  for (const entry of report.entries) {
    const state = entry.stored ? 'stored ' : entry.refused === undefined ? 'skipped' : 'REFUSED';
    const peak = entry.peak === undefined ? '' : ` peak ${entry.peak.toFixed(3)}${entry.clipped === true ? ' CLIPPING' : ''}`;
    const note =
      entry.issues.length === 0
        ? ''
        : ` — ${entry.issues.map((issue) => `${issue.severity} ${issue.rule}`).join(', ')}`;
    lines.push(`  ${state} ${entry.name}${peak}${note}`);
  }
  if (report.withErrors.length > 0) {
    /* Whether they were refused is the whole difference between the two modes, and
       saying "stored anyway" under `--strict` — where they were not — would be a
       report describing the run it is not in. */
    const refused = report.entries.some((entry) => entry.refused === 'validation');
    lines.push(`\n${String(report.withErrors.length)} recipe(s) carry validation errors: ${report.withErrors.join(', ')}.`);
    lines.push(
      refused
        ? "Refused, because this run is --strict. Without it they are stored and reported instead: the bank is\nthe repository's own reference set, and a missing recipe is a silent hole."
        : "They were stored anyway — the bank is the repository's own reference set, and a missing recipe\nis a silent hole. Re-run with --strict to refuse them instead.",
    );
  }
  if (report.clipping.length > 0) {
    lines.push(
      `\n${String(report.clipping.length)} recipe(s) render above the ${String(GLOBAL_LIMITS.maxPeak)} peak limit: ${report.clipping.join(', ')}.`,
      'Lower the loudest layer\'s gain in the recipe. Do not normalize the render — that hides which',
      'layer caused it. A preset must not clip at all; see presets/README.md.',
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const bank = openConfiguredBank(config);
  const strict = process.argv.includes('--strict');
  try {
    const report = await seedBank(bank, { strict });
    console.log(formatReport(report));
    /* Clipping fails the run as loudly as a validation error does, whichever
       directory it came from. In `presets/` the recipe was refused; in `examples/`
       it was stored, and a reference recipe that clips is still something CI should
       stop for — no example does today, and that is a property worth keeping. */
    if (strict && (report.withErrors.length > 0 || report.clipping.length > 0)) process.exitCode = 1;
  } finally {
    bank.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
