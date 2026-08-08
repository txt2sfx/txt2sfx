/**
 * The corpus, written out as files.
 *
 * ## Why a bank that can be thrown away is a better bank
 *
 * Everything else in this project works with no service running: the playground is
 * static, a share link carries the whole recipe in its fragment, the export is a
 * function you paste. The bank is the one piece that is a server someone has to pay
 * for, and a corpus that only exists inside it would quietly make the project depend
 * on that server staying up — exactly the dependency the rest of the design refuses.
 *
 * So the bank publishes itself. `bank.jsonl` is one recipe per line with its
 * measured profile and its attribution; the `.soundline` files are the same recipes
 * in canonical form, which is what a human wants to read and what git wants to diff.
 * Run on a timer into a public repository, it means the corpus survives the service,
 * anybody can fork it, and the history of what the bank held is a git log rather
 * than a promise.
 *
 * Hidden rows are skipped. The dump is the public face of the bank, and moderation
 * that does not reach it is not moderation.
 *
 * ## What is not in it
 *
 * No email, because none is collected. No session, no token, no bucket, no report,
 * and no comment: the corpus is the sounds and who made them, and a discussion is
 * not something to republish somewhere its authors did not put it. Attribution is
 * the GitHub handle, which is the name they published under here.
 *
 * @packageDocumentation
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Recipe } from '@txt2sfx/shared';
import { parse, serialize } from '@txt2sfx/core';
import { configFromEnv, openConfiguredBank } from './index.js';
import type { RecipeBank } from './db.js';

/** What one dump did. */
export interface DumpReport {
  readonly directory: string;
  readonly recipes: number;
  /** Recipes whose stored text no longer re-serializes; written as stored. */
  readonly unparsed: readonly string[];
}

/**
 * A file name from a recipe.
 *
 * The id leads, because names are not unique — two people may both publish a
 * `laser`, and a dump where the second silently overwrites the first would lose a
 * recipe every time it ran.
 */
export function dumpFileName(recipe: Recipe): string {
  const slug = recipe.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${String(recipe.id).padStart(4, '0')}-${slug === '' ? 'recipe' : slug}.soundline`;
}

/** One JSONL line: everything the bank knows, in a stable field order. */
export function dumpLine(recipe: Recipe): string {
  return JSON.stringify({
    id: recipe.id,
    name: recipe.name,
    prompt: recipe.prompt,
    category: recipe.category,
    tags: recipe.tags,
    durationMs: recipe.durationMs,
    likes: recipe.rating,
    createdAt: recipe.createdAt,
    author: recipe.author?.login ?? null,
    parentId: recipe.parentId ?? null,
    fingerprint: recipe.fingerprint ?? null,
    soundline: recipe.soundline,
    profile: recipe.profile,
  });
}

/** Write the corpus into a directory, creating it if needed. */
export function dumpBank(bank: RecipeBank, directory: string): DumpReport {
  const recipes = bank.all();
  const sounds = join(directory, 'soundlines');
  mkdirSync(sounds, { recursive: true });

  const unparsed: string[] = [];
  for (const recipe of recipes) {
    /* Canonical form, so the diff between two dumps is a change in the sound and
       never a change in whitespace. A recipe the parser now rejects is written as
       stored and named in the report — losing it would be worse, and pretending it
       is canonical would be a lie. */
    let text: string;
    try {
      text = serialize(parse(recipe.soundline));
    } catch {
      text = recipe.soundline;
      unparsed.push(recipe.name);
    }
    writeFileSync(join(sounds, dumpFileName(recipe)), text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  }

  writeFileSync(
    join(directory, 'bank.jsonl'),
    recipes.map((recipe) => dumpLine(recipe)).join('\n') + (recipes.length > 0 ? '\n' : ''),
    'utf8',
  );

  writeFileSync(
    join(directory, 'README.md'),
    [
      '# txt2sfx recipe bank',
      '',
      'Every published recipe, dumped from the bank. Each `.soundline` is a complete,',
      'procedural sound: no samples, no dependencies, a few hundred bytes of text that',
      'compiles to Web Audio. `bank.jsonl` carries the same recipes with their measured',
      'acoustic profiles, their like counts and their attribution.',
      '',
      'This directory is generated. Edit recipes in the playground, not here.',
      '',
      `${String(recipes.length)} recipe(s).`,
      '',
    ].join('\n'),
    'utf8',
  );

  return { directory, recipes: recipes.length, unparsed };
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? process.env['TXT2SFX_DUMP_DIR'] ?? resolve('corpus');
  const bank = openConfiguredBank(configFromEnv());
  const report = dumpBank(bank, resolve(target));
  bank.close();
  process.stdout.write(
    `dumped ${String(report.recipes)} recipe(s) to ${report.directory}` +
      (report.unparsed.length === 0 ? '\n' : `; written as stored (no longer parse): ${report.unparsed.join(', ')}\n`),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
