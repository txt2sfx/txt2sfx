/**
 * The library search, as a hook.
 *
 * ## Why it lives above the panel
 *
 * For the reason `useGenerate` does, minus the minute-long fit: the panel unmounts
 * every time someone switches to Compare to look at what they just found, and a result
 * list that dies on a tab switch would make the two tabs unusable together — which is
 * the whole workflow. The key is the sharper case: it is a credential the user pasted,
 * and losing it on a tab switch would train them to leave it in a file somewhere.
 *
 * ## Three stages, and only the middle one is ours
 *
 * 1. **Write the query.** `searchQuery` from `@txt2sfx/agent` — the same stage the
 *    recipe bank uses, not a second one that says the same thing. Both indexes want
 *    English words for the material, the object and the event, and both would rather
 *    have the raw prompt than a failed rewrite, which is exactly that stage's stance.
 * 2. **Search.** `lib/freesound.ts`, filtered on the facts that are not text: licence
 *    and duration. Nothing about this step is a judgement.
 * 3. **Reorder.** `rankSounds` — an opinion about words, applied as a partial order.
 *    Rows it does not mention keep their place behind the ones it does, so a search
 *    can never show fewer results because a model was unhelpful.
 *
 * With no provider — the picker on `mock` and no agent attached — stages 1 and 3 are
 * skipped and the library's own relevance stands. That is a working search, not a
 * degraded one, and it is what someone with a Freesound key and no model key gets.
 *
 * ## Changing a filter does not spend a model call
 *
 * The words and the ranking notes from the last run are kept, so toggling `≤ 2 s` or
 * "all licences" re-runs the HTTP search and reuses both. A filter chip that quietly
 * cost a model call would be a filter chip nobody could afford to try.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { rankSounds, searchQuery, type LLMProvider } from '@txt2sfx/agent';
import { canRemember, keystore } from './keystore.js';
import {
  FreesoundError,
  searchFreesound,
  type FreesoundSound,
  type FreesoundFailure,
  type LengthFilter,
  type LicenceFilter,
} from './freesound.js';

/** Where the Freesound key is remembered, if the user asks for that. */
const KEYSTORE_NAME = 'freesound';

/** One row on screen: what the library returned, and why it is where it is. */
export interface SearchHit {
  readonly sound: FreesoundSound;
  /** The ranking model's reason, or empty when it had none for this one. */
  readonly note: string;
}

/** Why a search did not happen, in a form the panel can translate. */
export interface SearchFailure {
  readonly code: FreesoundFailure;
  /** The library's own words, for the line under the message. */
  readonly detail: string;
}

/** Everything the Search tab needs to show and drive a search. */
export interface LibrarySearch {
  readonly key: string;
  readonly setKey: (key: string) => void;
  readonly remember: boolean;
  readonly setRemember: (remember: boolean) => void;
  /** True when a key is sitting in the keystore, so the Forget button can appear. */
  readonly stored: boolean;
  readonly forget: () => void;

  readonly licence: LicenceFilter;
  readonly setLicence: (licence: LicenceFilter) => void;
  readonly maxSeconds: LengthFilter;
  readonly setMaxSeconds: (seconds: LengthFilter) => void;

  /** The words actually sent to the library, or null before the first search. */
  readonly words: string | null;
  /** True when those words came from a model rather than from the prompt as typed. */
  readonly rewritten: boolean;
  readonly hits: readonly SearchHit[];
  /** How many the library says it has, which is nearly always more than one page. */
  readonly total: number;
  readonly running: boolean;
  readonly error: SearchFailure | null;
  /** True once a search has finished, so "nothing found" can differ from "not searched". */
  readonly searched: boolean;

  readonly start: (prompt: string, provider: LLMProvider | null) => void;
  /** Re-run the last search under the current filters, spending no model call. */
  readonly refine: () => void;
  readonly cancel: () => void;
}

export function useSearch(): LibrarySearch {
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [stored, setStored] = useState(false);
  const [licence, setLicence] = useState<LicenceFilter>('cc0');
  const [maxSeconds, setMaxSeconds] = useState<LengthFilter>(null);
  const [words, setWords] = useState<string | null>(null);
  const [rewritten, setRewritten] = useState(false);
  const [hits, setHits] = useState<readonly SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<SearchFailure | null>(null);
  const [searched, setSearched] = useState(false);

  const abort = useRef<AbortController | null>(null);
  /** What a refine re-uses: the words that were searched and the notes that were earned. */
  const last = useRef<{ words: string; notes: ReadonlyMap<number, string> } | null>(null);
  /** Filters and key, read at call time — `run` must not be rebuilt for a chip. */
  const live = useRef({ key, licence, maxSeconds, remember });
  live.current = { key, licence, maxSeconds, remember };

  useEffect(() => {
    if (!canRemember) return;
    let cancelled = false;
    void keystore.load(KEYSTORE_NAME).then((secret) => {
      if (cancelled || secret === null) return;
      setStored(true);
      setRemember(true);
      /* Never over a key already typed: what is in the box is the user's most recent
         intent and a stored one is history. Same rule as the provider key field. */
      setKey((current) => (current === '' ? secret : current));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** One search, with the words already decided. */
  const run = useCallback(
    async (query: string, provider: LLMProvider | null, signal: AbortSignal): Promise<void> => {
      const page = await searchFreesound({
        key: live.current.key.trim(),
        query,
        licence: live.current.licence,
        maxSeconds: live.current.maxSeconds,
        signal,
      });

      /* Show the library's own order first, then reorder in place. A ranking call is a
         second round trip, and a list that appears only after it would make every
         search feel as slow as the slowest model. */
      const reuse = last.current?.words === query ? last.current.notes : null;
      setHits(page.sounds.map((sound) => ({ sound, note: reuse?.get(sound.id) ?? '' })));
      setTotal(page.count);
      setSearched(true);

      if (provider === null || page.sounds.length === 0) {
        last.current = { words: query, notes: reuse ?? new Map() };
        return;
      }

      const ranking = await rankSounds({
        prompt: query,
        candidates: page.sounds.map((s) => ({ id: s.id, name: s.name, seconds: s.seconds, tags: s.tags })),
        provider,
        signal,
      });
      if (signal.aborted) return;

      const notes = new Map(ranking.map((r) => [r.id, r.note]));
      last.current = { words: query, notes };
      /* A partial order: what the model named, in its order, then everything else in
         the library's. Nothing is dropped — see the note on `rankSounds`. */
      const named = ranking
        .map((r) => page.sounds.find((s) => s.id === r.id))
        .filter((s): s is FreesoundSound => s !== undefined);
      const rest = page.sounds.filter((s) => !notes.has(s.id));
      setHits([...named, ...rest].map((sound) => ({ sound, note: notes.get(sound.id) ?? '' })));
    },
    [],
  );

  /**
   * One search, from either door, with its whole lifecycle.
   *
   * `reuse` is what separates a fresh search from a filter change: when it is a string
   * that string is already the query, so no model is asked to write one and none is
   * asked to rank the answer — the notes from the last run are reapplied by id inside
   * {@link run}.
   */
  const launch = useCallback(
    (typed: string, provider: LLMProvider | null, reuse: string | null) => {
      if (live.current.key.trim() === '') return;

      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setRunning(true);
      setError(null);

      void (async () => {
        /* `searchQuery` never rejects: a rewrite that fails returns the prompt, which is
           what a search with no model would have used anyway. */
        const query =
          reuse ??
          (provider === null ? typed : await searchQuery({ prompt: typed, provider, signal: controller.signal }));
        if (controller.signal.aborted) return;
        setWords(query);
        if (reuse === null) setRewritten(query !== typed);
        /* A different question means the old notes are about a different list. */
        if (last.current !== null && last.current.words !== query) last.current = null;
        await run(query, reuse === null ? provider : null, controller.signal);
      })()
        .catch((failure: unknown) => {
          if (controller.signal.aborted) return;
          if (failure instanceof FreesoundError) {
            setError({ code: failure.code, detail: failure.message });
            return;
          }
          setError({ code: 'network', detail: failure instanceof Error ? failure.message : String(failure) });
        })
        .finally(() => {
          if (abort.current === controller) abort.current = null;
          setRunning(false);
        });

      /* Persist on use, not on every keystroke: a key that actually reached the library
         is one the user meant, while a half-pasted one is not worth storing. */
      const secret = live.current.key.trim();
      if (live.current.remember && canRemember && secret !== '') {
        void keystore.save(KEYSTORE_NAME, secret).then(() => setStored(true));
      }
    },
    [run],
  );

  const start = useCallback(
    (prompt: string, provider: LLMProvider | null) => {
      const typed = prompt.trim();
      if (typed !== '') launch(typed, provider, null);
    },
    [launch],
  );

  const refine = useCallback(() => {
    const previous = last.current?.words ?? words;
    if (previous !== null && previous !== '') launch(previous, null, previous);
  }, [launch, words]);

  const cancel = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setRunning(false);
  }, []);

  const forget = useCallback(() => {
    void keystore.forget(KEYSTORE_NAME).then(() => {
      setStored(false);
      setRemember(false);
      setKey('');
    });
  }, []);

  return {
    key,
    setKey,
    remember,
    setRemember,
    stored,
    forget,
    licence,
    setLicence,
    maxSeconds,
    setMaxSeconds,
    words,
    rewritten,
    hits,
    total,
    running,
    error,
    searched,
    start,
    refine,
    cancel,
  };
}
