/**
 * Guards on the documentation itself.
 *
 * The exhaustive parameter tables are generated (`llmsText`), so they cannot drift.
 * The hand-written docs can, and the failure is silent: a new primitive lands, every
 * test passes, and `docs/PRIMITIVES.md` quietly describes seven of eight. These are
 * the cheap checks that make that loud instead — plus the two claims the plan
 * explicitly asked the README to get right.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SOUND_CATEGORIES } from '@txt2sfx/shared';
import { EFFECT_NAMES, PRIMITIVE_NAMES } from '@txt2sfx/core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');

const DOCS = [
  'ARCHITECTURE.md',
  'SOUNDLINE_GRAMMAR.md',
  'PRIMITIVES.md',
  'ACOUSTIC_PROFILE.md',
  'AGENT_LOOP.md',
  'API.md',
];

describe('docs', () => {
  it('has every document the README and the plan promise', () => {
    for (const name of DOCS) expect(existsSync(`${ROOT}docs/${name}`), name).toBe(true);
    for (const name of ['README.md', 'CONTRIBUTING.md', 'ROADMAP.md', '.env.example']) {
      expect(existsSync(`${ROOT}${name}`), name).toBe(true);
    }
  });

  /* The drift guard. Adding a primitive means adding a row here, and this test is
     how you find out you forgot. */
  it('PRIMITIVES.md describes every primitive and every effect', () => {
    const text = read('docs/PRIMITIVES.md');
    for (const name of PRIMITIVE_NAMES) expect(text, name).toContain(`\`${name}\``);
    for (const name of EFFECT_NAMES) expect(text, name).toContain(`\`${name}`);
  });

  it('SOUNDLINE_GRAMMAR.md names every category, since each one is a contract', () => {
    const text = read('docs/SOUNDLINE_GRAMMAR.md');
    for (const category of SOUND_CATEGORIES) expect(text, category).toContain(category);
  });

  it('every relative link between docs points at a file that exists', () => {
    const files = ['README.md', 'CONTRIBUTING.md', 'ROADMAP.md', ...DOCS.map((name) => `docs/${name}`)];
    for (const file of files) {
      const text = read(file);
      const base = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
      for (const match of text.matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]*)?\)/g)) {
        const target = match[1] ?? '';
        /* Anchors and mailto are not files; everything else must resolve. */
        if (target === '' || target.startsWith('mailto:')) continue;
        const resolved = target.startsWith('/') ? target.slice(1) : `${base}${target}`;
        expect(existsSync(`${ROOT}${resolved}`), `${file} -> ${target}`).toBe(true);
      }
    }
  });

  /* §11 of the plan, twice over: the honest size claim, and no "always". */
  it('README states the export size honestly', () => {
    const text = read('README.md');
    expect(text).toContain('300–1000 bytes');
    expect(text).toMatch(/not a guarantee/);
    expect(text.toLowerCase()).not.toContain('always under a kilobyte');
  });

  it('README keeps the honesty-about-limits section', () => {
    const text = read('README.md');
    expect(text).toContain('Honesty about limits');
    /* The weakness that matters most for expectations. */
    expect(text.toLowerCase()).toContain('voice');
  });

  it('.env.example lists both provider keys and no value for either', () => {
    const text = read('.env.example');
    for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) {
      expect(text).toContain(`${name}=\n`);
    }
  });

  it('every example recipe is documented as a reference in exactly one place', () => {
    /* The count is asserted elsewhere; here the point is that the docs and the
       directory agree, so a new example cannot arrive undocumented. */
    const examples = readdirSync(`${ROOT}examples`).filter((file) => file.endsWith('.soundline'));
    const profiles = read('docs/ACOUSTIC_PROFILE.md');
    for (const file of examples) {
      const name = file.replace('.soundline', '');
      expect(profiles, name).toContain(`| ${name} |`);
    }
  });
});
