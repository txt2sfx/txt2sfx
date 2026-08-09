/**
 * Seeder tests.
 *
 * These render audio, so they are the slow ones here — and they are the reason the
 * seeder is worth testing at all: it is the only place in the server where the
 * audio stack runs, and the two things it can get wrong are both invisible. A
 * profile full of NaN looks like a profile, and a recipe quietly skipped for
 * failing validation looks like a bank that simply never had it.
 *
 * Most tests name the directory they are about instead of taking the default. The
 * default is both directories, sixty renders, and every test that only wanted to
 * know something about `examples/` would otherwise pay for `presets/` as well —
 * five times over across this file. The default itself is covered once, by name.
 */

import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasErrors } from '@txt2sfx/core';
import { openBank, type RecipeBank } from '../src/db.js';
import { EXAMPLES_DIR, PRESETS_DIR, formatReport, seedBank } from '../src/seed.js';

let bank: RecipeBank;

const examplesOnly = { directories: [EXAMPLES_DIR] };

beforeEach(() => {
  bank = openBank(':memory:');
});

afterEach(() => {
  bank.close();
});

describe('seeding', () => {
  it(
    'loads every reference recipe',
    async () => {
      const report = await seedBank(bank, examplesOnly);
      expect(report.entries).toHaveLength(10);
      expect(report.stored).toBe(10);
      expect(bank.count()).toBe(10);
      expect(bank.list({ limit: 100 }).map((r) => r.name).sort()).toEqual([
        'bubble-pop',
        'coin',
        'door-creak',
        'explosion',
        'footstep-gravel',
        'helicopter',
        'laser',
        'powerup',
        'sword-clash',
        'ui-click',
      ]);
    },
    120_000,
  );

  it(
    'gives every recipe a real measured profile',
    async () => {
      await seedBank(bank, examplesOnly);
      for (const recipe of bank.list({ limit: 100 })) {
        expect(Number.isFinite(recipe.profile.peakHz)).toBe(true);
        expect(recipe.profile.peakHz).toBeGreaterThan(0);
        expect(recipe.profile.durationMs).toBeGreaterThan(0);
        expect(recipe.profile.rmsEnvelope).toHaveLength(64);
        expect(recipe.profile.centroidHz).toHaveLength(32);
      }
    },
    120_000,
  );

  it(
    'measures the transients as transients',
    async () => {
      await seedBank(bank, examplesOnly);
      const of = (name: string) => bank.list({ q: name, limit: 1 })[0];
      expect(of('bubble-pop')?.profile.durationMs).toBeLessThan(60);
      expect(of('ui-click')?.profile.durationMs).toBeLessThan(60);
      expect(of('explosion')?.profile.durationMs).toBeGreaterThan(500);
    },
    120_000,
  );

  it(
    'stores the declared duration in the column and the measured one in the profile',
    async () => {
      await seedBank(bank, examplesOnly);
      const helicopter = bank.list({ q: 'helicopter', limit: 1 })[0];
      /* Both facts survive: the header's contract and what the render actually
         does. Which is exactly the disagreement the validator reports. */
      expect(helicopter?.durationMs).toBe(1500);
      expect(helicopter?.profile.durationMs).toBeGreaterThan(3000);
    },
    120_000,
  );

  it(
    'is idempotent, so a re-seed does not double the bank or reset ratings',
    async () => {
      await seedBank(bank, examplesOnly);
      const coin = bank.list({ q: 'coin', limit: 1 })[0];
      bank.setRating(coin?.id ?? 0, 1);

      const again = await seedBank(bank, examplesOnly);
      expect(again.stored).toBe(0);
      expect(bank.count()).toBe(10);
      expect(bank.get(coin?.id ?? 0)?.rating).toBe(1);
    },
    180_000,
  );
});

describe('the shipped catalog', () => {
  /* One test for both halves on purpose. Each of these renders the whole catalog,
     and the second seed re-uses the first one's work: a recipe already in the bank
     is skipped without rendering, so `examples/` costs ten more renders here rather
     than another ninety-eight.

     The count is read from the directory rather than written down. `test/presets.test.ts`
     owns the manifest — it pins the exact names, which is the assertion that catches a
     rename — and duplicating the number here would only mean two files to edit for one
     preset, with the second failure saying nothing the first did not. */
  it(
    'renders every preset clean, and is seeded alongside examples by default',
    async () => {
      const catalogSize = readdirSync(PRESETS_DIR.path).filter((file) => file.endsWith('.soundline')).length;
      const presets = await seedBank(bank, { directories: [PRESETS_DIR], strict: true });
      expect(presets.entries).toHaveLength(catalogSize);
      expect(presets.stored).toBe(catalogSize);
      expect(presets.withErrors).toEqual([]);
      expect(presets.withWarnings).toEqual([]);
      expect(presets.clipping).toEqual([]);
      for (const entry of presets.entries) {
        expect(entry.peak, entry.name).toBeGreaterThan(0.02);
        expect(entry.peak, entry.name).toBeLessThanOrEqual(0.95);
      }

      /* The one thing a preset must not be is invisible to a search: it declares its
         own prompt and tags in its leading comments, and this is where they land. */
      const klaxon = bank.list({ q: 'klaxon', limit: 1 })[0];
      expect(klaxon?.prompt).toBe('sci-fi alarm klaxon, two alternating tones');
      expect(klaxon?.tags).toContain('siren');

      const both = await seedBank(bank);
      expect(both.entries).toHaveLength(catalogSize + 10);
      expect(both.stored).toBe(10);
      expect(bank.count()).toBe(catalogSize + 10);
    },
    600_000,
  );
});

describe('what the seeder says about validation', () => {
  it(
    'reports the recipes the validator objects to, and loads them anyway',
    async () => {
      const report = await seedBank(bank, examplesOnly);
      /* `helicopter` rings for about 4 s behind a header claiming 1.5 and cannot be
         brought into contract by editing the header — 4 s is past `cycle`'s own
         ceiling. Refusing it would leave the bank with no looped texture at all. */
      expect(report.withErrors).toEqual(['helicopter']);
      expect(report.withWarnings).toEqual(['sword-clash']);
      expect(bank.list({ q: 'helicopter', limit: 1 })).toHaveLength(1);

      const entry = report.entries.find((e) => e.name === 'helicopter');
      expect(entry?.stored).toBe(true);
      expect(hasErrors(entry?.issues ?? [])).toBe(true);
    },
    120_000,
  );

  it(
    'refuses them under --strict, which is what CI should use',
    async () => {
      const report = await seedBank(bank, { ...examplesOnly, strict: true });
      expect(report.stored).toBe(9);
      expect(report.withErrors).toEqual(['helicopter']);
      expect(bank.list({ q: 'helicopter', limit: 1 })).toEqual([]);
    },
    120_000,
  );

  it(
    'puts the finding in the text a human reads, not only in the object',
    async () => {
      const text = formatReport(await seedBank(bank, examplesOnly));
      expect(text).toContain('seeded 10 of 10 recipes');
      expect(text).toContain('error duration.contract');
      expect(text).toContain('--strict');
      /* The measured peak is in the line too — this report is the authoring loop
         for `presets/`, where the peak is the number being watched. */
      expect(text).toMatch(/stored {2}coin peak 0\.\d{3}/);
    },
    120_000,
  );
});
