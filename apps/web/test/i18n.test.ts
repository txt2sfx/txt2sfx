/**
 * The dictionary, and the two ways a translated interface breaks silently.
 *
 * The first is a **placeholder that does not survive translation**. `{count}` typed as
 * `{cout}` in one of nine files produces a sentence with a literal brace in it, on a
 * screen nobody on the team reads. Nothing else in the build notices: it is a valid
 * string, in a valid object, under a valid key. So every locale's placeholders are
 * compared against English's, per key, as a set.
 *
 * The second is a **key that resolves to nothing**. TypeScript already stops a locale
 * from inventing a key English does not have — `Partial<Record<Key, string>>` sees to
 * that — but it cannot stop an empty string, which renders as a missing button.
 *
 * What is deliberately *not* asserted is completeness: a locale is allowed to be behind,
 * because `t()` falls back to English word by word. A test that demanded every key in
 * every language would make adding a string a nine-file change, and the predictable
 * result of that is nine machine translations committed to satisfy a test.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { LANGUAGES, lang, setLang, t } from '../src/lib/i18n.js';
import { en, type Key } from '../src/lib/locales/en.js';
import { de } from '../src/lib/locales/de.js';
import { es } from '../src/lib/locales/es.js';
import { fr } from '../src/lib/locales/fr.js';
import { ja } from '../src/lib/locales/ja.js';
import { ko } from '../src/lib/locales/ko.js';
import { pt } from '../src/lib/locales/pt.js';
import { ru } from '../src/lib/locales/ru.js';
import { zh } from '../src/lib/locales/zh.js';

const CATALOGUES: readonly (readonly [string, Partial<Readonly<Record<Key, string>>>])[] = [
  ['de', de],
  ['es', es],
  ['fr', fr],
  ['ja', ja],
  ['ko', ko],
  ['pt', pt],
  ['ru', ru],
  ['zh', zh],
];

/** The `{name}` placeholders a template carries, order-insensitive. */
function placeholders(template: string): ReadonlySet<string> {
  return new Set([...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? ''));
}

describe('the dictionaries', () => {
  it('offers a catalogue for every language in the menu, and a menu entry for every catalogue', () => {
    const offered = LANGUAGES.map((entry) => entry.code).sort();
    expect(offered).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh']);
    /* Every entry is labelled in its own language, not in English — the reader who needs
       this menu is the one who cannot read the rest of the page. */
    for (const entry of LANGUAGES) {
      expect(entry.label.trim()).not.toBe('');
      expect(entry.short).toMatch(/^[A-Z]{2}$/);
    }
  });

  for (const [code, catalogue] of CATALOGUES) {
    it(`keeps ${code}'s placeholders identical to English's`, () => {
      for (const [key, translated] of Object.entries(catalogue)) {
        const source = en[key as Key];
        expect([...placeholders(translated)].sort()).toEqual([...placeholders(source)].sort());
      }
    });

    it(`never lets ${code} resolve a key to nothing`, () => {
      for (const translated of Object.values(catalogue)) expect(translated.trim()).not.toBe('');
    });
  }

  /* The syntax the user has to type is not prose. A locale that "translated" the example
     would be teaching a recipe the parser rejects. */
  it('leaves the soundline syntax out of the strings that teach it', () => {
    for (const [, catalogue] of CATALOGUES) {
      const teach = catalogue['slots.teachAfter'];
      if (teach !== undefined) expect(teach).toContain('{example}');
    }
  });
});

describe('t()', () => {
  it('falls back to English word by word rather than showing a key', () => {
    setLang('ru');
    try {
      expect(t('gallery.generate')).toBe('Сгенерировать');
      /* `mode.hsv` is the same three letters everywhere; what matters is that a key a
         locale happens not to override still comes out as a sentence. */
      expect(t('soundline.title')).toBe('SOUNDLINE');
    } finally {
      setLang('en');
    }
  });

  it('substitutes placeholders and leaves unknown ones standing', () => {
    expect(t('run.steps', { count: 4 })).toBe('4 steps');
    /* Named, not positional: a translator reorders a sentence freely. */
    expect(t('export.of', { budget: '2,048 B', used: '874 B' })).toBe('874 B of 2,048 B');
    /* A visible `{count}` names the bug; the word "undefined" would be read as a typo. */
    expect(t('run.steps')).toBe('{count} steps');
  });

  it('reports and remembers the language it was switched to', () => {
    setLang('ja');
    try {
      expect(lang()).toBe('ja');
      expect(t('nav.studio')).toBe('スタジオ');
    } finally {
      setLang('en');
      expect(lang()).toBe('en');
    }
  });
});
