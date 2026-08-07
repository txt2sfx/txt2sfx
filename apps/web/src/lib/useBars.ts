/**
 * Bar heights for a recipe, rendered in the background.
 *
 * ## The problem
 *
 * The gallery is a grid of cards and every card shows the sound's actual waveform.
 * That is twelve offline renders on the way to first paint, and the alternative — a
 * shape derived from `decay` and `delay` — was rejected in `lib/layers.ts` for a
 * reason that applies twice as hard here: a card is how a sound is recognised in a
 * list, and a card that shows an idealised envelope rather than the render is
 * showing the wrong sound.
 *
 * ## What this does about it
 *
 * A render is cheap (a millisecond or two for anything in this catalog) but not free,
 * and twelve of them contending for the main thread at mount is a visible stutter. So:
 * a shared cache keyed by the exact `(source, seed, count)`, a queue that keeps at
 * most a few in flight, and a deterministic placeholder in the meantime. The
 * placeholder is shaped like a decaying burst so a half-loaded grid reads as *loading*
 * rather than as twelve identical sounds, and it is derived from the recipe's name so
 * it does not reshuffle on every repaint.
 *
 * The cache is keyed by source text, which means editing a recipe produces a new key
 * and a fresh render — correct by construction, and the reason nothing here needs
 * invalidating.
 *
 * @packageDocumentation
 */

import { useEffect, useState } from 'react';
import { parse } from '@txt2sfx/core';
import { render } from './engine.js';
import { bars, ghostBars } from './layers.js';

/** Finished renders. Bounded, because an editing session would otherwise never stop growing. */
const CACHE = new Map<string, Float32Array>();

/** Recipes that failed to parse or render — remembered so they are not retried per repaint. */
const FAILED = new Set<string>();

const CACHE_LIMIT = 200;

/** How many offline renders may be in flight. Enough to fill a screen, few enough to stay smooth. */
const CONCURRENCY = 4;

const queue: (() => void)[] = [];
let active = 0;

function pump(): void {
  while (active < CONCURRENCY) {
    const next = queue.shift();
    if (next === undefined) return;
    active++;
    next();
  }
}

function done(): void {
  active--;
  pump();
}

const waiting = new Map<string, Promise<Float32Array | null>>();

/** Render `source` and reduce it to `count` bars. One render per distinct key, ever. */
export function barsFor(source: string, seed: number, count: number): Promise<Float32Array | null> {
  const key = `${String(seed)}|${String(count)}|${source}`;
  const hit = CACHE.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  if (FAILED.has(key)) return Promise.resolve(null);
  const pending = waiting.get(key);
  if (pending !== undefined) return pending;

  const promise = new Promise<Float32Array | null>((resolve) => {
    queue.push(() => {
      let ast;
      try {
        ast = parse(source);
      } catch {
        FAILED.add(key);
        done();
        resolve(null);
        return;
      }
      void render(ast, { seed })
        .then((result) => {
          const values = bars(result.buffer, count);
          CACHE.set(key, values);
          while (CACHE.size > CACHE_LIMIT) {
            const oldest = CACHE.keys().next();
            if (oldest.done === true) break;
            CACHE.delete(oldest.value);
          }
          resolve(values);
        })
        .catch(() => {
          FAILED.add(key);
          resolve(null);
        })
        .finally(() => {
          waiting.delete(key);
          done();
        });
    });
    pump();
  });

  waiting.set(key, promise);
  return promise;
}

/** What a card knows about its own waveform. */
export interface BarsState {
  readonly values: Float32Array;
  /** False while the placeholder is showing, so the card can dim it. */
  readonly ready: boolean;
}

/**
 * Bars for one recipe, with a placeholder until they arrive.
 *
 * `placeholderKey` should be something stable and human — the recipe name — so two
 * cards do not get the same ghost.
 */
export function useBars(source: string, seed: number, count: number, placeholderKey: string): BarsState {
  const key = `${String(seed)}|${String(count)}|${source}`;
  const [state, setState] = useState<BarsState>(() => {
    const hit = CACHE.get(key);
    return hit === undefined
      ? { values: ghostBars(placeholderKey, count), ready: false }
      : { values: hit, ready: true };
  });

  useEffect(() => {
    const cached = CACHE.get(key);
    if (cached !== undefined) {
      setState({ values: cached, ready: true });
      return;
    }
    setState({ values: ghostBars(placeholderKey, count), ready: false });

    let cancelled = false;
    void barsFor(source, seed, count).then((values) => {
      if (cancelled || values === null) return;
      setState({ values, ready: true });
    });
    return () => {
      cancelled = true;
    };
  }, [key, source, seed, count, placeholderKey]);

  return state;
}
