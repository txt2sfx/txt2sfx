/**
 * The interface language.
 *
 * ## Why a module-level store and not a React context
 *
 * Half the user-visible strings in this app are produced outside the tree: `download()`
 * returns the sentence the toast shows, `copy()` reports what it put on the clipboard,
 * `App` builds its warnings as plain data before anything renders them. A context would
 * translate the components and leave those in English, and threading a translator through
 * five pure modules to fix it would be worse than the problem.
 *
 * So the language is one module-level value with a subscription. `t()` is importable from
 * anywhere, including modules that have never heard of React; {@link useI18n} wires the
 * same store into the tree with `useSyncExternalStore`, so a component re-renders when the
 * language changes and a non-component just reads the current value at call time.
 *
 * ## Falling back, word by word
 *
 * A missing translation resolves to English rather than to the key. A locale is therefore
 * always shippable at whatever completeness it has reached: an untranslated tooltip reads
 * as English, which is recoverable, where `slots.fitTitle` on screen is not.
 *
 * ## Choosing the first language
 *
 * Stored choice first — it is an explicit decision and outranks everything. Otherwise the
 * browser's own list, matched on the base subtag so `pt-PT` finds the Portuguese entry and
 * `zh-TW` finds the Chinese one. Failing both, English. The choice is written to
 * `localStorage` defensively, the same way `lib/library.ts` treats it: a preference must
 * never be able to stop the page from starting.
 *
 * @packageDocumentation
 */

import { useCallback, useSyncExternalStore } from 'react';
import { en, type Key } from './locales/en.js';
import { de } from './locales/de.js';
import { es } from './locales/es.js';
import { fr } from './locales/fr.js';
import { ja } from './locales/ja.js';
import { ko } from './locales/ko.js';
import { pt } from './locales/pt.js';
import { ru } from './locales/ru.js';
import { zh } from './locales/zh.js';

export type { Key } from './locales/en.js';

/**
 * The languages on offer, in the order the menu lists them.
 *
 * English first because it is the fallback and the language the recipes are written in;
 * the rest alphabetically by their own name, which is the only ordering that does not
 * privilege one reader's alphabet over another's. Each is labelled in itself — a reader
 * looking for their language cannot be expected to recognise its English name.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'de', label: 'Deutsch', short: 'DE' },
  { code: 'es', label: 'Español', short: 'ES' },
  { code: 'fr', label: 'Français', short: 'FR' },
  { code: 'pt', label: 'Português', short: 'PT' },
  { code: 'ru', label: 'Русский', short: 'RU' },
  { code: 'zh', label: '简体中文', short: 'ZH' },
  { code: 'ja', label: '日本語', short: 'JA' },
  { code: 'ko', label: '한국어', short: 'KO' },
] as const;

export type Lang = (typeof LANGUAGES)[number]['code'];

/** Every catalogue, keyed by language. Only `en` is complete by construction. */
const DICT: Readonly<Record<Lang, Partial<Readonly<Record<Key, string>>>>> = {
  en,
  de,
  es,
  fr,
  pt,
  ru,
  zh,
  ja,
  ko,
};

const STORAGE_KEY = 'txt2sfx.lang.v1';

/**
 * The BCP-47 tag a locale wants, where it is not the bare code.
 *
 * Used for `<html lang>` and for the `Intl` formatters. Both care about the difference:
 * `pt` is European Portuguese and this catalogue is Brazilian, and `zh` leaves the script
 * unstated where the strings are unambiguously simplified.
 */
const TAG: Partial<Readonly<Record<Lang, string>>> = { zh: 'zh-Hans', pt: 'pt-BR' };

/** The current language as a tag `Intl` and `<html lang>` understand. */
export function bcp47(): string {
  return TAG[current] ?? current;
}

function isLang(value: string): value is Lang {
  return LANGUAGES.some((entry) => entry.code === value);
}

/** The stored choice, or the closest of the browser's preferences, or English. */
function detect(): Lang {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null && isLang(stored)) return stored;
  } catch {
    /* Storage can be disabled entirely. A preference is not worth a blank page. */
  }
  const preferences = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? [navigator.language])];
  for (const preference of preferences) {
    const base = preference.toLowerCase().split('-')[0] ?? '';
    if (isLang(base)) return base;
  }
  return 'en';
}

let current: Lang = detect();
const listeners = new Set<() => void>();

/** The language in force right now. */
export function lang(): Lang {
  return current;
}

/**
 * Switch language.
 *
 * Also stamps `<html lang>`, which is not decoration: it is what a screen reader picks a
 * voice from and what the browser hyphenates by, and a page of Japanese announced as
 * English is worse than no attribute at all.
 */
export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  if (typeof document !== 'undefined') document.documentElement.lang = bcp47();
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* A language that does not survive a reload still works for this session. */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The string for `key`, with `{name}` placeholders substituted.
 *
 * An unknown placeholder is left standing rather than replaced with `undefined`: a visible
 * `{count}` names the bug, where the word "undefined" in the middle of a sentence looks
 * like a translation error and gets reported as one.
 */
export function t(key: Key, params?: Readonly<Record<string, string | number>>): string {
  const template = DICT[current][key] ?? en[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * The same store, from inside the tree.
 *
 * The returned `t` is a new function identity per language rather than per render, so a
 * component that lists it as a dependency re-runs when the language changes and not
 * otherwise.
 */
export function useI18n(): {
  readonly lang: Lang;
  readonly setLang: (next: Lang) => void;
  readonly t: typeof t;
} {
  const active = useSyncExternalStore(subscribe, lang, lang);
  const translate = useCallback<typeof t>((key, params) => t(key, params), [active]);
  return { lang: active, setLang, t: translate };
}

/* Stamp the initial choice, so the first paint is already labelled correctly. */
if (typeof document !== 'undefined') document.documentElement.lang = bcp47();
