/**
 * The playground.
 *
 * One rule organizes the whole component: **the source text is the state**.
 * Sliders rewrite it, the gallery swaps it, the prompt bar produces it, and
 * everything else — the parse, the validation, the compile, the render, the
 * pictures, the export — is derived from it on every keystroke. Nothing is cached
 * that could disagree with what the editor shows, which is the only way an audition
 * loop stays trustworthy.
 *
 * The generated recipe gets no privileges. It arrives as an ordinary editor buffer,
 * is judged by the same validator, and is exported by the same panel — which is the
 * whole argument for a text format: a sound a model wrote and a sound a human wrote
 * are the same kind of thing.
 *
 * Where the gallery reads from is a choice with consequences, so it is explicit in
 * the sidebar rather than inferred: `examples/` is the writable reference set,
 * the bank is the shared store the agent takes few-shot examples from. See
 * `lib/catalog.ts`.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_SEED,
  codegen,
  declaredDurationMs,
  parseWithDiagnostics,
  validate,
  type CodegenResult,
  type RenderResult,
} from '@txt2sfx/core';
import { extractProfile, humanReadableDiff, soundDistance } from '@txt2sfx/analyzer';
import { optimize } from '@txt2sfx/optimizer';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { Compare } from './components/Compare.js';
import { Diagnostics } from './components/Diagnostics.js';
import { Editor } from './components/Editor.js';
import { ExportPanel } from './components/ExportPanel.js';
import { FitPreview } from './components/FitPreview.js';
import { Gallery } from './components/Gallery.js';
import { PromptBar } from './components/PromptBar.js';
import { Sliders } from './components/Sliders.js';
import { StableAudio } from './components/StableAudio.js';
import { Timeline } from './components/Timeline.js';
import { Visualizer } from './components/Visualizer.js';
import { renderSignalFor, targetFromBuffer } from './lib/agent.js';
import { decodeAudioFile, type Reference } from './lib/analysis.js';
import { BankError, DEFAULT_BANK_URL, bankClient, type BankHealth } from './lib/bank.js';
import { bridge } from './lib/bridge.js';
import { bankEntries, exampleEntries, mergeCatalog, type Entry } from './lib/catalog.js';
import { bundledRecipes, canSave, fetchRecipes, saveRecipe } from './lib/examples.js';
import { playBuffer, playLive, type Playback } from './lib/engine.js';
import { render } from './lib/engine.js';
import { fetchRender, renderTarget } from './lib/stable-audio.js';
import { applySlot, collectSlots, type Slot } from './lib/slots.js';

/** How long to wait after the last edit before re-rendering offline. */
const RENDER_DEBOUNCE_MS = 140;

/** How long to wait after the last edit before an auto-play retrigger. */
const AUTOPLAY_DEBOUNCE_MS = 260;

/** Which store the gallery lists below this session's recipes. */
type Store = 'examples' | 'bank';

/**
 * Budget for a fit started by hand.
 *
 * Deliberately larger than the one a generate run uses: this is the answer to "the
 * search was still improving when it ran out", so giving it the same budget again
 * would be pointless. Watch the progress line rather than the clock — a population
 * of renders per generation is the cost.
 */
const FIT_GENERATIONS = 60;
const FIT_POPULATION = 20;

/**
 * How firmly a hand-started fit is held to the recipe in the editor.
 *
 * The same values the prompt bar uses, for the same reason and then one more. The
 * search optimizes a distance, and the distance is peak-normalized and onset-aligned:
 * it cannot tell "this sound, closer" from "a different sound that scores well", so
 * left free it takes the second trade and the recipe comes back a stranger. The extra
 * reason here is that this button is pressed *on a recipe someone is editing* — the
 * numbers are being refined, and a search that rewrites all of them at once has
 * answered a question nobody asked.
 */
const FIT_ANCHOR = 0.25;
const FIT_SPREAD = 0.25;

export function App(): React.JSX.Element {
  const [examples, setExamples] = useState<readonly Entry[]>(() => exampleEntries(bundledRecipes()));
  /** Recipes that exist only in this tab: generated, or not yet saved anywhere. */
  const [session, setSession] = useState<readonly Entry[]>([]);
  const [store, setStore] = useState<Store>('examples');
  const [bankUrl, setBankUrl] = useState(DEFAULT_BANK_URL);
  const [bankHealth, setBankHealth] = useState<BankHealth | null>(null);
  const [bankList, setBankList] = useState<readonly Entry[]>([]);
  const [bankNonce, setBankNonce] = useState(0);

  /* The prompt lives here rather than inside the prompt bar because two engines
     answer it: our loop, and — under dev — the diffusion model that renders the
     reference. Asking each of them a slightly different sentence would make the
     comparison meaningless, so there is one sentence. */
  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState<string>(() => bundledRecipes()[0]?.name ?? '');
  /** Editor buffers, keyed by recipe name. Absent means "as stored". */
  const [edits, setEdits] = useState<Readonly<Record<string, string>>>({});
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [autoPlay, setAutoPlay] = useState(true);
  const [saveName, setSaveName] = useState(selected);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [publishPrompt, setPublishPrompt] = useState('');
  const [rendered, setRendered] = useState<RenderResult | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  /* The reference lives in memory only: it is the user's file, and a playground
     has no business copying it anywhere. It outlives recipe switches on purpose —
     comparing several candidates against one target is the normal workflow. */
  const [reference, setReference] = useState<Reference | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  /** Progress of a hand-started fit, or its verdict. Null when none has run. */
  const [fitting, setFitting] = useState<string | null>(null);
  /** Whether one is running now — the status text is prose and cannot be asked. */
  const [fitRunning, setFitRunning] = useState(false);
  /** The candidate currently winning it, so the wait is watchable. */
  const [fitBest, setFitBest] = useState<string | null>(null);

  const playback = useRef<Playback | null>(null);
  const fitAbort = useRef<AbortController | null>(null);
  const lastPlayed = useRef<string>('');

  /* Ask the dev endpoint what is actually on disk. The bundled snapshot only
     refreshes when the dev server restarts, so a recipe saved in an earlier
     session would otherwise be missing from the gallery. */
  useEffect(() => {
    let cancelled = false;
    void fetchRecipes().then((list) => {
      if (!cancelled && list.length > 0) setExamples(exampleEntries(list));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const bank = useMemo(() => bankClient(bankUrl), [bankUrl]);

  /* The bank is optional. Health decides whether the agent gets few-shot examples
     at all, so it is asked first and the listing only follows a live answer —
     otherwise a wrong URL costs two failed requests instead of one.
     Re-probed when the sidebar switches to the bank, because "I just started the
     server" is the common reason for looking: making the user find the refresh
     button to be told what the click already asked would be its own small insult.
     Not polled, though — repeatedly calling a URL somebody typed is noise. */
  useEffect(() => {
    let cancelled = false;
    void bank.health().then(async (health) => {
      if (cancelled) return;
      setBankHealth(health);
      if (health === null) {
        setBankList([]);
        return;
      }
      const listed = await bank.list();
      if (!cancelled) setBankList(bankEntries(listed));
    });
    return () => {
      cancelled = true;
    };
  }, [bank, bankNonce, store]);

  const stored = store === 'bank' ? bankList : examples;
  const entries = useMemo(() => mergeCatalog(session, stored), [session, stored]);
  const pristine = useMemo(() => new Map(entries.map((entry) => [entry.name, entry.source])), [entries]);
  const source = edits[selected] ?? pristine.get(selected) ?? '';
  const dirty = useMemo(
    () => Object.keys(edits).filter((name) => pristine.has(name) && edits[name] !== pristine.get(name)),
    [edits, pristine],
  );
  const current = useMemo(() => entries.find((entry) => entry.name === selected), [entries, selected]);

  const parsed = useMemo(() => parseWithDiagnostics(source), [source]);
  const ast = parsed.ast;
  const slots = useMemo(() => (ast === null ? [] : collectSlots(ast)), [ast]);
  /* The same invariants the agent loop enforces, applied to hand edits too. A
     playground that let you write a 400 ms `pop` in silence would teach the wrong
     thing about what the pipeline accepts. */
  const issues = useMemo(() => (ast === null ? [] : validate(ast)), [ast]);

  /** Codegen can throw on a compile-time contract the parser cannot see. */
  const code = useMemo<CodegenResult | null>(() => {
    if (ast === null) return null;
    try {
      return codegen(ast, { seed });
    } catch {
      return null;
    }
  }, [ast, seed]);

  /* --- rendering ---------------------------------------------------------- */

  useEffect(() => {
    if (ast === null) {
      setRendered(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void render(ast, { seed })
        .then((result) => {
          if (cancelled) return;
          setRendered(result);
          setRenderError(null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setRendered(null);
          setRenderError(String(error));
        });
    }, RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ast, seed]);

  /* --- playback ---------------------------------------------------------- */

  const stop = useCallback(() => {
    playback.current?.stop();
    playback.current = null;
  }, []);

  const play = useCallback(() => {
    if (ast === null) return;
    stop();
    playback.current = playLive(ast, { seed }).playback;
  }, [ast, seed, stop]);

  const loop = useCallback(() => {
    if (rendered === null) return;
    stop();
    playback.current = playBuffer(rendered.buffer, { loop: true });
  }, [rendered, stop]);

  /* Retrigger while a knob moves: the point of the sliders is hearing the
     change, and reaching for Play after every nudge defeats it. */
  useEffect(() => {
    if (!autoPlay || ast === null) return;
    if (lastPlayed.current === '') {
      lastPlayed.current = source;
      return;
    }
    if (lastPlayed.current === source) return;
    const timer = window.setTimeout(() => {
      lastPlayed.current = source;
      play();
    }, AUTOPLAY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [source, autoPlay, ast, play]);

  useEffect(() => stop, [stop]);

  const loadReference = useCallback((file: File) => {
    setReferenceError(null);
    void decodeAudioFile(file)
      .then((buffer) => setReference({ name: file.name, buffer }))
      .catch((error: unknown) => {
        setReference(null);
        setReferenceError(`could not decode ${file.name}: ${String(error)}`);
      });
  }, []);

  const clearReference = useCallback(() => {
    setReference(null);
    setReferenceError(null);
  }, []);

  /* --- editing ----------------------------------------------------------- */

  const setSource = useCallback(
    (next: string) => {
      setEdits((current) => ({ ...current, [selected]: next }));
    },
    [selected],
  );

  const onSlotChange = useCallback(
    (slot: Slot, value: number) => {
      setSource(applySlot(source, slot, value));
    },
    [source, setSource],
  );

  const select = useCallback(
    (name: string) => {
      stop();
      setSelected(name);
      setSaveName(name);
      setSaveStatus(null);
      lastPlayed.current = '';
    },
    [stop],
  );

  const revert = useCallback(() => {
    setEdits((current) => {
      const next = { ...current };
      delete next[selected];
      return next;
    });
    lastPlayed.current = '';
  }, [selected]);

  /* --- generation --------------------------------------------------------- */

  const onGenerated = useCallback(
    (recipe: { name: string; source: string; prompt: string }) => {
      stop();
      setSession((current) => [
        ...current.filter((entry) => entry.name !== recipe.name),
        { name: recipe.name, source: recipe.source, origin: 'session', prompt: recipe.prompt },
      ]);
      setEdits((current) => {
        const next = { ...current };
        delete next[recipe.name];
        return next;
      });
      setSelected(recipe.name);
      setSaveName(recipe.name);
      setSaveStatus(null);
      setPublishPrompt(recipe.prompt);
      /* A sentinel that cannot equal a soundline, so the auto-play effect hears the
         new recipe instead of treating it as "already played". Hearing the answer
         is the point of asking. */
      lastPlayed.current = ' ';
    },
    [stop],
  );

  /* --- persistence -------------------------------------------------------- */

  const save = useCallback(() => {
    const name = saveName.trim();
    /* Renaming into a recipe that already exists overwrites someone else's work.
       Same-name saves — the common case — are never interrupted. */
    if (name !== selected && examples.some((entry) => entry.name === name)) {
      const proceed = window.confirm(`examples/${name}.soundline already exists. Overwrite it?`);
      if (!proceed) return;
    }
    void saveRecipe(name, source)
      .then((path) => {
        setExamples((current) =>
          exampleEntries([...current.filter((entry) => entry.name !== name), { name, source }]),
        );
        /* It is on disk now, so it is no longer a session-only recipe. */
        setSession((current) => current.filter((entry) => entry.name !== name));
        /* Only the name that was written becomes clean. Saving under a *different*
           name is "save a copy": the buffer you were editing keeps its edits and
           stays marked dirty, because dropping them here would delete work the
           user never asked to discard. */
        setEdits((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
        setSelected(name);
        setStore('examples');
        setSaveStatus(`saved ${path}`);
      })
      .catch((error: unknown) => setSaveStatus(String(error)));
  }, [saveName, source, selected, examples]);

  /**
   * Publish the current buffer to the bank.
   *
   * The profile is measured here because the server has no audio stack and will
   * refuse a recipe without one — and measuring it from the render on screen means
   * the stored fingerprint belongs to the sound that was auditioned, not to a
   * re-render nobody heard.
   */
  const publish = useCallback(() => {
    if (rendered === null) {
      setSaveStatus('nothing rendered yet — fix the recipe first');
      return;
    }
    const name = saveName.trim() === '' ? selected : saveName.trim();
    const prompt = publishPrompt.trim() === '' ? name.replace(/-/g, ' ') : publishPrompt.trim();
    const profile = extractProfile({
      samples: Float32Array.from(rendered.buffer.getChannelData(0)),
      sampleRate: rendered.buffer.sampleRate,
    });

    setSaveStatus(`publishing to ${bank.baseUrl}…`);
    void bank
      .publish({ name, prompt, soundline: source, profile })
      .then((result) => {
        setSaveStatus(
          result.created
            ? `published as #${String(result.recipe.id)}${result.warnings.length === 0 ? '' : ` (${String(result.warnings.length)} warning(s))`}`
            : `already in the bank as #${String(result.recipe.id)} — nothing was created`,
        );
        /* Refresh so the bank gallery shows it, and mark the buffer clean by
           adopting the text that was actually stored. */
        setBankNonce((n) => n + 1);
        setSession((current) =>
          current.map((entry) =>
            entry.name === name ? { ...entry, source, prompt, id: result.recipe.id } : entry,
          ),
        );
        setEdits((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
      })
      .catch((error: unknown) => {
        if (error instanceof BankError) {
          const detail = error.issues.map((issue) => `${issue.rule}: ${issue.hint}`).join(' · ');
          setSaveStatus(`${error.message}${detail === '' ? '' : ` — ${detail}`}`);
          return;
        }
        setSaveStatus(String(error));
      });
  }, [bank, publishPrompt, rendered, saveName, selected, source]);

  /* --- fitting by hand ---------------------------------------------------- */

  /**
   * Run the optimizer on what is in the editor, against the loaded reference.
   *
   * The same search the agent loop runs, reachable without a model. Two reasons it
   * earns a button: a generate run stops when its generation budget ends even while
   * the search is still improving (by design — see the loop's hard rule), and this
   * is how you give it more; and after hand-editing a recipe, refitting is the
   * difference between "my structure is wrong" and "my numbers are wrong".
   */
  const fit = useCallback(() => {
    if (ast === null || reference === null || fitRunning) return;
    const controller = new AbortController();
    fitAbort.current = controller;
    setFitRunning(true);
    setFitBest(null);
    setFitting('fitting…');
    void optimize({
      source,
      target: targetFromBuffer(reference.buffer),
      render: renderSignalFor(seed),
      generations: FIT_GENERATIONS,
      populationSize: FIT_POPULATION,
      anchor: FIT_ANCHOR,
      initialSpread: FIT_SPREAD,
      signal: controller.signal,
      onGeneration: (report) => {
        /* The distance, not the fitness: the fitness carries the anchor and the
           clipping penalty, and a live number that ends up disagreeing with the
           verdict two lines below it is worse than no live number. */
        setFitting(
          `generation ${String(report.generation)}/${String(FIT_GENERATIONS)} · distance ${report.distance.toFixed(3)}`,
        );
        setFitBest(report.source);
      },
    })
      .then((result) => {
        /* Writing the fitted text back is the whole point: the search works in the
           space of writable recipes, so what it found *is* a recipe. This runs after
           a cancelled fit too — the optimizer returns the best individual it had
           reached, and Stop is meant to cost the rest of the wait and nothing else. */
        if (result.slots.length > 0) setSource(result.source);
        setFitting(
          `${result.initialDistance.toFixed(3)} → ${result.distance.toFixed(3)} (${result.de.stopped})${result.slots.length === 0 ? ' — no ~slots to fit' : ''}`,
        );
      })
      .catch((error: unknown) => setFitting(String(error)))
      .finally(() => {
        if (fitAbort.current === controller) fitAbort.current = null;
        setFitRunning(false);
        setFitBest(null);
      });
  }, [ast, fitRunning, reference, seed, setSource, source]);

  /**
   * Stop the hand fit where it stands.
   *
   * The signal reaches the search itself, which checks it before every candidate
   * render, so this ends within one render rather than at the end of the generation
   * budget — and the `then` above still writes back what it found.
   */
  const stopFit = useCallback(() => {
    fitAbort.current?.abort();
  }, []);

  /* The bridge API is installed once, so it reaches the current `fit` through a ref
     for the same reason `measure` reads `live`. */
  const fitRef = useRef(fit);
  fitRef.current = fit;

  /* --- the devtools bridge (dev only) ------------------------------------- */

  /**
   * Everything the bridge reads, in a ref rather than a closure.
   *
   * Learned the hard way: with the API built from closure values, a caller that
   * asked for `measure()` right after a run got the *previous* render's numbers,
   * because the effect that installed it had not re-run yet. Stale measurements are
   * worse than none — they look like results, and a conclusion drawn from the wrong
   * recipe is a wasted iteration at best.
   */
  const live = useRef({ source, rendered, ast, code, issues, reference, entries });
  live.current = { source, rendered, ast, code, issues, reference, entries };

  /**
   * `window.txt2sfx`: drive and measure the playground from a debugger.
   *
   * Two halves. The *model* half comes from `lib/bridge.ts` — `request`, `reply`,
   * `fail` — and lets an agent holding devtools answer the loop by hand, which is
   * the only way to tell "the model wrote a bad recipe" apart from "our prompt,
   * validator or feedback is at fault". The *measurement* half is here, because
   * this is where the render, the validator and the reference already live: reading
   * the recipe, measuring the buffer on screen, and getting the same diff
   * directives the loop would send back.
   *
   * Installed only under `vite dev`. Everything it exposes is already reachable by
   * clicking; a global that answers a live model loop is an instrument, not a
   * feature, and a static build has no business shipping one.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const api = {
      version: 1,

      /* --- the model half --- */
      request: () => bridge.request(),
      system: () => bridge.system(),
      reply: (id: number, text: string) => bridge.reply(id, text),
      fail: (id: number, message: string) => bridge.fail(id, message),
      run: (nextPrompt: string, opts: { target?: boolean } = {}) => bridge.run(nextPrompt, opts),

      /* --- the editor half --- */
      recipe: () => live.current.source,
      setRecipe: (text: string) => setSource(text),
      select,
      names: () => live.current.entries.map((entry) => entry.name),
      /** Refit the current buffer to the reference — more generations, by hand. */
      fit: () => fitRef.current(),

      /**
       * Everything measurable about what is on screen right now.
       *
       * `directives` are the analyzer's own instructions — the exact strings the
       * loop puts in a repair message — so a hand-driven iteration sees what the
       * model would have seen instead of a wall of numbers.
       */
      measure: () => {
        const now = live.current;
        if (now.rendered === null) return { error: 'nothing rendered yet' };
        const signal = {
          samples: Float32Array.from(now.rendered.buffer.getChannelData(0)),
          sampleRate: now.rendered.buffer.sampleRate,
        };
        const profile = extractProfile(signal);
        const reference = now.reference;
        const target =
          reference === null
            ? null
            : {
                samples: Float32Array.from(reference.buffer.getChannelData(0)),
                sampleRate: reference.buffer.sampleRate,
              };
        return {
          profile,
          recipe: now.source,
          peak: now.rendered.peak,
          clipped: now.rendered.clipped,
          durationMs: now.rendered.durationMs,
          bytes: now.code?.bytes ?? null,
          withinBudget: now.code?.withinBudget ?? null,
          issues: now.issues,
          ...(target === null || now.ast === null
            ? {}
            : (() => {
                const targetProfile = extractProfile(target);
                return {
                  reference: reference?.name,
                  /* The optimizer's own fitness, so a hand-driven iteration is
                     comparing the same number the search would minimize. */
                  distance: soundDistance({ signal, profile }, { signal: target, profile: targetProfile }),
                  targetProfile,
                  directives: humanReadableDiff(profile, targetProfile, now.ast),
                };
              })()),
        };
      },

      /**
       * Load a reference by URL — under dev, `/@fs/<absolute path>` reaches any file
       * the server is allowed to read, so a sample in Downloads needs no file picker.
       */
      loadReference: async (url: string): Promise<string> => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url} → HTTP ${String(response.status)}`);
        const blob = await response.blob();
        const name = url.split('/').pop() ?? 'reference';
        loadReference(new File([blob], name));
        return name;
      },
      /**
       * Render a target with Stable Audio and load it, in one call.
       *
       * The hand-driven loop's missing half: `measure()` reports a distance only
       * when there is something to be distant from, and finding a WAV of "a heavy
       * door slamming" by hand is the slow step. Resolves once the render is the
       * reference, so `run(prompt, { target: true })` can follow immediately.
       */
      target: async (
        text: string,
        opts: { seconds?: number; seed?: number } = {},
      ): Promise<string> => {
        const file = await renderTarget({ prompt: text, ...opts });
        loadReference(await fetchRender(file));
        return file;
      },

      clearReference,
      reference: () => {
        const loaded = live.current.reference;
        return loaded === null ? null : { name: loaded.name, durationMs: loaded.buffer.duration * 1000 };
      },
    };

    (window as unknown as Record<string, unknown>)['txt2sfx'] = api;
    return () => {
      delete (window as unknown as Record<string, unknown>)['txt2sfx'];
    };
    /* Installed once. Everything time-varying is read through `live`, so the object
       on `window` never goes stale and never has to be re-fetched by a caller. */
  }, [clearReference, loadReference, select, setSource]);

  /* Ctrl/Cmd+Enter plays, Ctrl/Cmd+S saves. Space is off limits — it belongs to
     the textarea, and an editor that swallows spaces is not an editor. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        play();
      } else if (event.key.toLowerCase() === 's' && canSave) {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [play, save]);

  /* --- render ------------------------------------------------------------ */

  const warnings: string[] = [];
  if (rendered?.clipped === true) {
    warnings.push(
      `mix peaks at ${rendered.peak.toFixed(3)}, above the ${String(GLOBAL_LIMITS.maxPeak)} limit — lower a layer's gain rather than normalizing`,
    );
  }
  if (ast !== null && rendered !== null) {
    const declared = declaredDurationMs(ast);
    const actual = rendered.durationMs - 50;
    if (actual > declared * 1.15) {
      warnings.push(`sound runs ~${String(Math.round(actual))}ms but the header declares ${String(Math.round(declared))}ms`);
    }
  }
  if (code !== null && !code.withinBudget) {
    warnings.push(`export is ${String(code.bytes)} B, over the ${String(GLOBAL_LIMITS.maxExportBytes)} B budget`);
  }
  if (renderError !== null) warnings.push(renderError);
  if (referenceError !== null) warnings.push(referenceError);

  const isDirty = dirty.includes(selected);
  const demoRecipes = useMemo(
    () => entries.map((entry) => ({ name: entry.name, soundline: entry.source })),
    [entries],
  );
  const takenNames = useMemo(() => entries.map((entry) => entry.name), [entries]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          txt2sfx <span className="brand-sub">soundline playground</span>
        </div>

        <div className="transport">
          <button type="button" className="primary" onClick={play} disabled={ast === null}>
            ▶ Play
          </button>
          <button type="button" onClick={loop} disabled={rendered === null}>
            ↻ Loop
          </button>
          <button type="button" onClick={stop}>
            ■ Stop
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              name="autoplay"
              checked={autoPlay}
              onChange={(e) => setAutoPlay(e.target.checked)}
            />
            auto
          </label>
          <label className="seed">
            seed
            <input
              type="number"
              name="seed"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.valueAsNumber || 0))}
            />
          </label>
          <button type="button" title="new random seed" onClick={() => setSeed(Math.floor(Math.random() * 0xffff))}>
            rnd
          </button>
        </div>

        <div className="stats">
          {rendered === null ? (
            <span className="stat muted">—</span>
          ) : (
            <>
              <span className={rendered.clipped ? 'stat bad' : 'stat'}>peak {rendered.peak.toFixed(3)}</span>
              <span className="stat">{Math.round(rendered.durationMs)}ms</span>
            </>
          )}
          {code === null ? null : (
            <span className={code.withinBudget ? 'stat' : 'stat warn'}>{code.bytes}B</span>
          )}
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="store-switch">
              <button
                type="button"
                className={store === 'examples' ? 'selected' : ''}
                onClick={() => setStore('examples')}
              >
                examples
              </button>
              <button type="button" className={store === 'bank' ? 'selected' : ''} onClick={() => setStore('bank')}>
                bank
              </button>
            </div>
            {store === 'bank' ? (
              <>
                <input
                  className="save-name"
                  name="bank-url"
                  value={bankUrl}
                  aria-label="bank server URL"
                  onChange={(e) => setBankUrl(e.target.value)}
                />
                <div className="save-status">
                  {bankHealth === null
                    ? 'offline — run `pnpm --filter @txt2sfx/server dev`'
                    : `${String(bankHealth.recipes)} recipes · ${bankHealth.grammar}`}
                  <button type="button" className="link" onClick={() => setBankNonce((n) => n + 1)}>
                    refresh
                  </button>
                </div>
              </>
            ) : null}
          </div>

          <Gallery entries={entries} selected={selected} dirty={dirty} onSelect={select} />

          <div className="sidebar-foot">
            <input
              className="save-name"
              name="recipe-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              aria-label="recipe name"
            />
            <div className="sidebar-buttons">
              <button type="button" className="primary" onClick={save} disabled={!canSave}>
                Save
              </button>
              <button type="button" onClick={revert} disabled={!isDirty}>
                Revert
              </button>
            </div>
            {canSave ? null : <div className="hint">Static build — use “Copy soundline”.</div>}
            <input
              className="save-name"
              name="publish-prompt"
              value={publishPrompt}
              placeholder={current?.prompt ?? 'prompt this recipe answers'}
              aria-label="prompt this recipe answers"
              onChange={(e) => setPublishPrompt(e.target.value)}
            />
            <button type="button" onClick={publish} disabled={ast === null || rendered === null}>
              Publish to bank
            </button>
            {saveStatus === null ? null : <div className="save-status">{saveStatus}</div>}
          </div>
        </aside>

        <main className="main">
          <section className="pane pane-wide">
            <PromptBar
              prompt={prompt}
              onPromptChange={setPrompt}
              recipes={demoRecipes}
              bank={bankHealth === null ? null : bank.recipes}
              seed={seed}
              reference={reference}
              takenNames={takenNames}
              onGenerated={onGenerated}
            />
          </section>

          <section className="pane">
            <Editor source={source} errors={parsed.errors} onChange={setSource} />
            <Diagnostics errors={parsed.errors} issues={issues} warnings={warnings} />
          </section>

          <section className="pane">
            <Visualizer
              buffer={rendered?.buffer ?? null}
              declaredMs={ast === null ? 0 : declaredDurationMs(ast)}
              maxPeak={GLOBAL_LIMITS.maxPeak}
            />
            <Timeline ast={ast} totalMs={rendered?.durationMs ?? 0} />
          </section>

          <section className="pane">
            <div className="pane-head">
              <h2>Slots</h2>
              <div className="pane-head-actions">
                {fitting === null ? null : <span className="fit-status">{fitting}</span>}
                {fitRunning ? (
                  <button type="button" onClick={stopFit} title="stop the search and keep the best it found">
                    ■ Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={fit}
                    disabled={reference === null || ast === null || slots.length === 0}
                    title={
                      reference === null
                        ? 'load a reference in the Compare panel first'
                        : `fit every ~slot to ${reference.name} (${String(FIT_GENERATIONS)} generations)`
                    }
                  >
                    ⌖ Fit to reference
                  </button>
                )}
              </div>
            </div>
            {/* A fit is a minute of one number moving, and the number cannot be
                listened to. The leader can. */}
            {fitBest === null ? null : <FitPreview source={fitBest} seed={seed} onTake={stopFit} />}
            <Sliders slots={slots} layerNames={ast?.layers.map((l) => l.name) ?? []} onChange={onSlotChange} />
          </section>

          <section className="pane">
            <h2>Export</h2>
            <ExportPanel name={selected} source={source} code={code} buffer={rendered?.buffer ?? null} />
          </section>

          <section className="pane pane-wide">
            <h2>Compare with a reference</h2>
            {/* Where a reference can come from besides a file: the same prompt,
                rendered by a diffusion model on this machine. A target, not a
                competitor — see `components/StableAudio.tsx`. */}
            <StableAudio prompt={prompt} onRendered={loadReference} />
            <Compare
              candidateName={selected}
              candidate={rendered?.buffer ?? null}
              reference={reference}
              onLoadReference={loadReference}
              onClearReference={clearReference}
            />
          </section>
        </main>
      </div>
    </div>
  );
}
