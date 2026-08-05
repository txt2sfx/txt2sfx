/**
 * Seeder tests.
 *
 * These render audio, so they are the slow ones here — and they are the reason the
 * seeder is worth testing at all: it is the only place in the server where the
 * audio stack runs, and the two things it can get wrong are both invisible. A
 * profile full of NaN looks like a profile, and a recipe quietly skipped for
 * failing validation looks like a bank that simply never had it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasErrors } from '@txt2sfx/core';
import { openBank, type RecipeBank } from '../src/db.js';
import { formatReport, seedBank } from '../src/seed.js';

let bank: RecipeBank;

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
      const report = await seedBank(bank);
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
      await seedBank(bank);
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
      await seedBank(bank);
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
      await seedBank(bank);
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
      await seedBank(bank);
      const coin = bank.list({ q: 'coin', limit: 1 })[0];
      bank.vote(coin?.id ?? 0, 1);

      const again = await seedBank(bank);
      expect(again.stored).toBe(0);
      expect(bank.count()).toBe(10);
      expect(bank.get(coin?.id ?? 0)?.rating).toBe(1);
    },
    180_000,
  );
});

describe('what the seeder says about validation', () => {
  it(
    'reports the recipes the validator objects to, and loads them anyway',
    async () => {
      const report = await seedBank(bank);
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
      const report = await seedBank(bank, { strict: true });
      expect(report.stored).toBe(9);
      expect(report.withErrors).toEqual(['helicopter']);
      expect(bank.list({ q: 'helicopter', limit: 1 })).toEqual([]);
    },
    120_000,
  );

  it(
    'puts the finding in the text a human reads, not only in the object',
    async () => {
      const text = formatReport(await seedBank(bank));
      expect(text).toContain('seeded 10 of 10 recipes');
      expect(text).toContain('error duration.contract');
      expect(text).toContain('--strict');
    },
    120_000,
  );
});
