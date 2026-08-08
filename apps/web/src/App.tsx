/**
 * The playground.
 *
 * One rule organizes the whole thing: **the source text is the state**. Sliders rewrite
 * it, the catalog swaps it, the prompt row produces it, an agent over the bridge sets
 * it, and everything else — the parse, the validation, the compile, the render, the
 * pictures, the metrics, the export — is derived from it on every keystroke. Nothing is
 * cached that could disagree with what the editor shows, which is the only way an
 * audition loop stays trustworthy.
 *
 * The generated recipe gets no privileges. It arrives as an ordinary editor buffer, is
 * judged by the same validator, and is exported by the same panel — which is the whole
 * argument for a text format: a sound a model wrote and a sound a human wrote are the
 * same kind of thing.
 *
 * ## What the redesign changed, structurally
 *
 * The old layout was one screen of stacked panels. This one is three screens — a catalog,
 * a studio and a share view — and the reason is not fashion. Every panel was permanently
 * on screen, so the first thing a visitor saw was an editor for a language they had not
 * heard of, and the compare view, which is the most expensive thing here, ran its FFTs
 * whether or not anyone was looking at them. Splitting them puts the claim first, makes
 * the expensive views opt-in, and gives a sound somewhere to be *finished* rather than
 * merely open.
 *
 * ## Two ways an agent reaches this page
 *
 * `window.txt2sfx` is unchanged and still dev-only: a global that answers a live model
 * loop is a debugging instrument. What is new is the bridge — a daemon on loopback that
 * relays between this tab and a coding agent over MCP, in both directions. The handlers
 * are registered here for the same reason the devtools API is: this is where the render,
 * the validator and the reference already live. See `lib/bridge-client.ts` and
 * `docs/BRIDGE.md`.
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
import { BridgeDialog } from './components/BridgeDialog.js';
import { Header, type Screen } from './components/Header.js';
import type { BKind } from './components/ComparePanel.js';
import type { RailMode } from './components/Rail.js';
import type { StudioView } from './components/PromptRow.js';
import { Gallery, type GalleryItem } from './screens/Gallery.js';
import { Share } from './screens/Share.js';
import { Studio } from './screens/Studio.js';
import { renderSignalFor, targetFromBuffer } from './lib/agent.js';
import { decodeAudioFile, metricsOf, signalOf, type Reference } from './lib/analysis.js';
import { bankClient, DEFAULT_BANK_URL, type BankHealth } from './lib/bank.js';
import { bridge } from './lib/bridge.js';
import { bridgeClient, type BridgeStatus } from './lib/bridge-client.js';
import { bankEntries, exampleEntries, mergeCatalog, type Entry } from './lib/catalog.js';
import { download, formatById, type Format } from './lib/download.js';
import { playBuffer, playLive, render, type Playback } from './lib/engine.js';
import { bundledRecipes, canSave, fetchRecipes, saveRecipe } from './lib/examples.js';
import { useI18n } from './lib/i18n.js';
import { renderLayers } from './lib/layers.js';
import { loadLibrary, saveLibrary, type Library } from './lib/library.js';
import { clearShareFromLocation, sharedFromLocation } from './lib/share.js';
import { applySlot, collectSlots, type Slot } from './lib/slots.js';
import { renderTarget, stableAudioStatus, stableAudioSupported } from './lib/stable-audio.js';
import { DEFAULT_PROVIDER, useGenerate, type ProviderSettings } from './lib/useGenerate.js';

/** How long to wait after the last edit before re-rendering offline. */
const RENDER_DEBOUNCE_MS = 140;

/** How long to wait after the last edit before an auto-play retrigger. */
const AUTOPLAY_DEBOUNCE_MS = 260;

/**
 * Budget for a fit started by hand.
 *
 * Deliberately larger than the one a generate run uses: this is the answer to "the search
 * was still improving when it ran out", so giving it the same budget again would be
 * pointless. Watch the progress line rather than the clock — a population of renders per
 * generation is the cost.
 */
const FIT_GENERATIONS = 60;
const FIT_POPULATION = 20;

/**
 * How firmly a hand-started fit is held to the recipe in the editor.
 *
 * The same values a generate run uses, for the same reason and then one more. The search
 * optimizes a distance, and the distance is peak-normalized and onset-aligned: it cannot
 * tell "this sound, closer" from "a different sound that scores well", so left free it
 * takes the second trade and the recipe comes back a stranger. The extra reason here is
 * that this button is pressed *on a recipe someone is editing* — the numbers are being
 * refined, and a search that rewrites all of them at once has answered a question nobody
 * asked.
 */
const FIT_ANCHOR = 0.25;
const FIT_SPREAD = 0.25;

export function App(): React.JSX.Element {
  const { t } = useI18n();

  /* --- the catalog -------------------------------------------------------- */

  const [examples, setExamples] = useState<readonly Entry[]>(() => exampleEntries(bundledRecipes()));
  /** Recipes that exist only in this tab: generated, shared in, or not yet saved. */
  const [session, setSession] = useState<readonly Entry[]>([]);
  const [bankList, setBankList] = useState<readonly Entry[]>([]);
  const [bankUrl] = useState(DEFAULT_BANK_URL);
  const [bankHealth, setBankHealth] = useState<BankHealth | null>(null);
  const [bankNonce, setBankNonce] = useState(0);
  const [library, setLibrary] = useState<Library>(() => loadLibrary());

  /* --- navigation --------------------------------------------------------- */

  const [screen, setScreen] = useState<Screen>('gallery');
  const [view, setView] = useState<StudioView>('sound');
  const [railMode, setRailMode] = useState<RailMode>('recent');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [bridgeOpen, setBridgeOpen] = useState(false);

  /* --- the recipe --------------------------------------------------------- */

  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState<string>(() => bundledRecipes()[0]?.name ?? '');
  /** Editor buffers, keyed by recipe name. Absent means "as stored". */
  const [edits, setEdits] = useState<Readonly<Record<string, string>>>({});
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [rendered, setRendered] = useState<RenderResult | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [playingName, setPlayingName] = useState<string | null>(null);
  const [formatId, setFormatId] = useState('js');
  const [status, setStatus] = useState<string | null>(null);
  const [settings, setSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER);

  /* --- comparison --------------------------------------------------------- */

  /* The reference lives in memory only: it is the user's file, and a playground has no
     business copying it anywhere. It outlives recipe switches on purpose — comparing
     several candidates against one target is the normal workflow. */
  const [reference, setReference] = useState<Reference | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [bKind, setBKind] = useState<BKind>('take');
  const [take, setTake] = useState<{ name: string; buffer: AudioBuffer } | null>(null);
  const [layerBuffers, setLayerBuffers] = useState<readonly (AudioBuffer | null)[]>([]);
  const [modelAvailable, setModelAvailable] = useState(false);

  /* --- fitting ------------------------------------------------------------ */

  const [fitting, setFitting] = useState<string | null>(null);
  const [fitRunning, setFitRunning] = useState(false);

  /* --- bridge ------------------------------------------------------------- */

  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>(() => bridgeClient.current());

  const playback = useRef<Playback | null>(null);
  const fitAbort = useRef<AbortController | null>(null);
  const lastPlayed = useRef<string>('');
  const stopTimer = useRef<number | null>(null);

  /* --- catalog loading ---------------------------------------------------- */

  /* Ask the dev endpoint what is actually on disk. The bundled snapshot only refreshes
     when the dev server restarts, so a recipe saved in an earlier session would otherwise
     be missing. */
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

  /* The bank is optional. Health decides whether the agent gets few-shot examples at all,
     so it is asked first and the listing only follows a live answer — otherwise a wrong
     URL costs two failed requests instead of one. Not polled: repeatedly calling a URL
     somebody typed is noise. */
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
  }, [bank, bankNonce]);

  useEffect(() => {
    if (!stableAudioSupported) return;
    void stableAudioStatus().then((next) => setModelAvailable(next?.ready === true));
  }, []);

  /* A link that carries a recipe becomes a session entry and opens in the studio, playing
     itself. The payload is dropped from the address bar immediately: leaving it there
     means every later reload re-imports the same sound over whatever the user has since
     edited. */
  useEffect(() => {
    const shared = sharedFromLocation();
    if (shared === null) return;
    clearShareFromLocation();
    setSession((current) => [
      ...current.filter((entry) => entry.name !== shared.name),
      { name: shared.name, source: shared.source, origin: 'session', prompt: shared.prompt },
    ]);
    setSelected(shared.name);
    setPrompt(shared.prompt);
    setScreen('studio');
    lastPlayed.current = ' ';
  }, []);

  /* --- derived ------------------------------------------------------------ */

  const entries = useMemo(
    () => mergeCatalog(session, [...examples, ...bankList.filter((b) => !examples.some((e) => e.name === b.name))]),
    [session, examples, bankList],
  );
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
  /* The same invariants the agent loop enforces, applied to hand edits too. A playground
     that let you write a 400 ms `pop` in silence would teach the wrong thing about what
     the pipeline accepts. */
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

  /**
   * The catalog as the gallery and the rail want it.
   *
   * The declared duration rather than the measured one, because this list is built for
   * every recipe in the catalog and measuring them all would mean rendering them all —
   * which `useBars` already does lazily, per card, for the picture. A number that is
   * cheap and honest about being the header's claim beats one that stalls the list.
   */
  const items = useMemo<readonly GalleryItem[]>(
    () =>
      entries.map((entry) => {
        const parsedEntry = parseWithDiagnostics(edits[entry.name] ?? entry.source);
        return {
          name: entry.name,
          source: edits[entry.name] ?? entry.source,
          /* A recipe from `examples/` has no recorded prompt — it was written, not asked
             for — but it does have the author's own comment above the header, and that
             comment is a better description than anything derivable from the name. Using
             it means the reference set reads like the rest of the catalog instead of like
             ten rows of "no prompt recorded". */
          prompt: entry.prompt ?? (parsedEntry.ast?.leading.join(' ').trim() ?? ''),
          category: parsedEntry.ast?.category ?? entry.category,
          durationMs: parsedEntry.ast === null ? 0 : declaredDurationMs(parsedEntry.ast),
          origin: entry.origin,
          editedAt: library.touched[entry.name],
          trashed: library.trashed.includes(entry.name),
        };
      }),
    [entries, edits, library],
  );

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

  /* Per-layer renders, for the compare view's `tracks` and `hsv` colour modes. Only while
     that view is open: four extra offline renders per keystroke is a real cost and nobody
     on the soundline view can see the result. */
  useEffect(() => {
    if (ast === null || screen !== 'studio' || view !== 'compare') {
      setLayerBuffers([]);
      return;
    }
    let cancelled = false;
    void renderLayers(ast, seed).then((results) => {
      if (!cancelled) setLayerBuffers(results.map((result) => result?.buffer ?? null));
    });
    return () => {
      cancelled = true;
    };
  }, [ast, seed, screen, view]);

  /* --- playback ----------------------------------------------------------- */

  const stop = useCallback(() => {
    playback.current?.stop();
    playback.current = null;
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
    stopTimer.current = null;
    setPlayingName(null);
  }, []);

  /** Play a named recipe's own text — used by the gallery, where nothing is "current". */
  const playNamed = useCallback(
    (name: string, text: string) => {
      if (playingName === name) {
        stop();
        return;
      }
      stop();
      const result = parseWithDiagnostics(text);
      if (result.ast === null) {
        setStatus(t('app.doesNotParse', { name }));
        return;
      }
      const live = playLive(result.ast, { seed });
      playback.current = live.playback;
      setPlayingName(name);
      stopTimer.current = window.setTimeout(() => setPlayingName(null), live.ir.durationSec * 1000 + 200);
    },
    [playingName, seed, stop, t],
  );

  const play = useCallback(() => {
    if (ast === null) return;
    playNamed(selected, source);
  }, [ast, playNamed, selected, source]);

  const loop = useCallback(() => {
    if (rendered === null) return;
    stop();
    playback.current = playBuffer(rendered.buffer, { loop: true });
    setPlayingName(selected);
  }, [rendered, selected, stop]);

  /* Retrigger while a knob moves: the point of the sliders is hearing the change, and
     reaching for Play after every nudge defeats it. */
  useEffect(() => {
    if (ast === null || screen !== 'studio' || view !== 'sound') return;
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
  }, [source, ast, play, screen, view]);

  useEffect(() => stop, [stop]);

  /* --- the reference and the B side --------------------------------------- */

  const loadReference = useCallback((file: File) => {
    setReferenceError(null);
    void decodeAudioFile(file)
      .then((buffer) => setReference({ name: file.name, buffer }))
      .catch((error: unknown) => {
        setReference(null);
        setReferenceError(t('warn.decodeFail', { file: file.name, error: String(error) }));
      });
  }, [t]);

  /**
   * Render the current recipe again with a different seed.
   *
   * The question this answers is specific to procedural audio and cannot be asked of a
   * file: how much of what you are hearing is the design, and how much is one draw from a
   * noise generator? A recipe whose two takes differ more than A differs from a reference
   * is not a sound, it is a distribution.
   */
  const newTake = useCallback(() => {
    if (ast === null) return;
    const other = (seed + 1 + Math.floor(Math.random() * 0xfff)) & 0xffff;
    void render(ast, { seed: other })
      .then((result) => setTake({ name: t('app.take', { seed: other }), buffer: result.buffer }))
      .catch(() => setTake(null));
  }, [ast, seed, t]);

  const b = bKind === 'take' ? take : reference;

  /* --- editing ------------------------------------------------------------ */

  const touch = useCallback((name: string) => {
    setLibrary((current) => {
      const next = { ...current, touched: { ...current.touched, [name]: Date.now() } };
      saveLibrary(next);
      return next;
    });
  }, []);

  const setSource = useCallback(
    (next: string) => {
      setEdits((current) => ({ ...current, [selected]: next }));
      touch(selected);
    },
    [selected, touch],
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
      setStatus(null);
      lastPlayed.current = '';
    },
    [stop],
  );

  const open = useCallback(
    (name: string) => {
      select(name);
      setPrompt(entries.find((entry) => entry.name === name)?.prompt ?? '');
      setScreen('studio');
      setView('sound');
    },
    [entries, select],
  );

  const trash = useCallback((name: string) => {
    setLibrary((current) => {
      const trashed = current.trashed.includes(name)
        ? current.trashed.filter((entry) => entry !== name)
        : [...current.trashed, name];
      const next = { ...current, trashed };
      saveLibrary(next);
      return next;
    });
  }, []);

  /* --- generation --------------------------------------------------------- */

  const onGenerated = useCallback(
    (recipe: { name: string; source: string; prompt: string }) => {
      stop();
      setSession((currentSession) => [
        ...currentSession.filter((entry) => entry.name !== recipe.name),
        { name: recipe.name, source: recipe.source, origin: 'session', prompt: recipe.prompt },
      ]);
      setEdits((currentEdits) => {
        const next = { ...currentEdits };
        delete next[recipe.name];
        return next;
      });
      setSelected(recipe.name);
      touch(recipe.name);
      /* A sentinel that cannot equal a soundline, so the auto-play effect hears the new
         recipe instead of treating it as "already played". Hearing the answer is the
         point of asking. */
      lastPlayed.current = ' ';
    },
    [stop, touch],
  );

  const demoRecipes = useMemo(
    () => entries.map((entry) => ({ name: entry.name, soundline: entry.source })),
    [entries],
  );
  const takenNames = useMemo(() => entries.map((entry) => entry.name), [entries]);

  const generation = useGenerate({
    recipes: demoRecipes,
    bank: bankHealth === null ? null : bank.recipes,
    seed,
    reference: b,
    takenNames,
    onGenerated,
  });

  /** From the gallery: put the prompt in the studio and start immediately. */
  const generateFromGallery = useCallback(
    (text: string) => {
      setPrompt(text);
      setScreen('studio');
      setView('sound');
      generation.start(text, settings);
    },
    [generation, settings],
  );

  /* --- persistence -------------------------------------------------------- */

  const save = useCallback(() => {
    void saveRecipe(selected, source)
      .then((path) => {
        setExamples((currentExamples) =>
          exampleEntries([...currentExamples.filter((entry) => entry.name !== selected), { name: selected, source }]),
        );
        setSession((currentSession) => currentSession.filter((entry) => entry.name !== selected));
        setEdits((currentEdits) => {
          const next = { ...currentEdits };
          delete next[selected];
          return next;
        });
        setStatus(t('app.saved', { path }));
      })
      .catch((error: unknown) => setStatus(String(error)));
  }, [selected, source, t]);

  /**
   * Publish the current buffer to the bank.
   *
   * The profile is measured here because the server has no audio stack and will refuse a
   * recipe without one — and measuring it from the render on screen means the stored
   * fingerprint belongs to the sound that was auditioned, not to a re-render nobody heard.
   */
  const publish = useCallback(async (): Promise<string> => {
    if (rendered === null) return t('app.nothingRendered');
    const profile = extractProfile({
      samples: Float32Array.from(rendered.buffer.getChannelData(0)),
      sampleRate: rendered.buffer.sampleRate,
    });
    const result = await bank.publish({
      name: selected,
      prompt: prompt.trim() === '' ? (current?.prompt ?? selected.replace(/-/g, ' ')) : prompt.trim(),
      soundline: source,
      profile,
    });
    setBankNonce((n) => n + 1);
    return t(result.created ? 'app.published' : 'app.alreadyPublished', { id: result.recipe.id });
  }, [bank, current, prompt, rendered, selected, source, t]);

  /* --- fitting by hand ---------------------------------------------------- */

  /**
   * Run the optimizer on what is in the editor, against B.
   *
   * The same search the agent loop runs, reachable without a model. Two reasons it earns
   * a button: a generate run stops when its generation budget ends even while the search
   * is still improving (by design — see the loop's hard rule), and this is how you give
   * it more; and after hand-editing a recipe, refitting is the difference between "my
   * structure is wrong" and "my numbers are wrong".
   */
  const fit = useCallback(() => {
    if (ast === null || b === null || fitRunning) return;
    const controller = new AbortController();
    fitAbort.current = controller;
    setFitRunning(true);
    setFitting(t('slots.fitting'));
    void optimize({
      source,
      target: targetFromBuffer(b.buffer),
      render: renderSignalFor(seed),
      generations: FIT_GENERATIONS,
      populationSize: FIT_POPULATION,
      anchor: FIT_ANCHOR,
      initialSpread: FIT_SPREAD,
      signal: controller.signal,
      onGeneration: (report) => {
        /* The distance, not the fitness: the fitness carries the anchor and the clipping
           penalty, and a live number that ends up disagreeing with the verdict two lines
           below it is worse than no live number. */
        setFitting(
          t('slots.generation', {
            n: report.generation,
            total: FIT_GENERATIONS,
            distance: report.distance.toFixed(3),
          }),
        );
      },
    })
      .then((result) => {
        /* Writing the fitted text back is the whole point: the search works in the space
           of writable recipes, so what it found *is* a recipe. This runs after a cancelled
           fit too — the optimizer returns the best individual it had reached, and Stop is
           meant to cost the rest of the wait and nothing else. */
        if (result.slots.length > 0) setSource(result.source);
        setFitting(
          `${result.initialDistance.toFixed(3)} → ${result.distance.toFixed(3)} (${result.de.stopped})${result.slots.length === 0 ? t('slots.noSlots') : ''}`,
        );
      })
      .catch((error: unknown) => setFitting(String(error)))
      .finally(() => {
        if (fitAbort.current === controller) fitAbort.current = null;
        setFitRunning(false);
      });
  }, [ast, b, fitRunning, seed, setSource, source, t]);

  const stopFit = useCallback(() => fitAbort.current?.abort(), []);

  const fitBlocked =
    b === null
      ? t('blocked.noB')
      : ast === null
        ? t('blocked.noParse')
        : slots.length === 0
          ? t('blocked.noSlots')
          : null;

  /* --- downloading -------------------------------------------------------- */

  /* Returns the promise rather than firing and forgetting: MP3 and M4A are encoded, and
     the split button needs to know when that has finished so it can say so and refuse a
     second press in the meantime. */
  const onDownload = useCallback(
    async (format: Format): Promise<void> => {
      const subject =
        view === 'model' && b !== null && bKind === 'model'
          ? { name: b.name.replace(/\.[^.]+$/, ''), source, code, buffer: b.buffer }
          : { name: selected, source, code, buffer: rendered?.buffer ?? null };
      setStatus(await download(subject, format));
    },
    [b, bKind, code, rendered, selected, source, view],
  );

  /* --- the devtools bridge and the agent bridge --------------------------- */

  /**
   * Everything either bridge reads, in a ref rather than a closure.
   *
   * Learned the hard way: with the API built from closure values, a caller that asked for
   * `measure()` right after a run got the *previous* render's numbers, because the effect
   * that installed it had not re-run yet. Stale measurements are worse than none — they
   * look like results, and a conclusion drawn from the wrong recipe is a wasted iteration
   * at best.
   */
  const live = useRef({ source, rendered, ast, code, issues, reference: b, entries, selected, prompt, seed });
  live.current = { source, rendered, ast, code, issues, reference: b, entries, selected, prompt, seed };

  const actions = useRef({ setSource, select, open, fit, play, loop, onGenerated, publish, save, loadReference });
  actions.current = { setSource, select, open, fit, play, loop, onGenerated, publish, save, loadReference };

  /** Everything measurable about what is on screen right now, as plain data. */
  const measure = useCallback((): Record<string, unknown> => {
    const now = live.current;
    if (now.rendered === null) return { error: 'nothing rendered yet' };
    const signal = {
      samples: Float32Array.from(now.rendered.buffer.getChannelData(0)),
      sampleRate: now.rendered.buffer.sampleRate,
    };
    const profile = extractProfile(signal);
    const target =
      now.reference === null
        ? null
        : {
            samples: Float32Array.from(now.reference.buffer.getChannelData(0)),
            sampleRate: now.reference.buffer.sampleRate,
          };
    return {
      recipe: now.source,
      name: now.selected,
      profile,
      peak: now.rendered.peak,
      clipped: now.rendered.clipped,
      durationMs: now.rendered.durationMs,
      bytes: now.code?.bytes ?? null,
      withinBudget: now.code?.withinBudget ?? null,
      issues: now.issues,
      metrics: metricsOf(signalOf(now.rendered.buffer)),
      ...(target === null || now.ast === null
        ? {}
        : (() => {
            const targetProfile = extractProfile(target);
            return {
              reference: now.reference?.name,
              /* The optimizer's own fitness, so a hand-driven iteration is comparing the
                 same number the search would minimize. */
              distance: soundDistance({ signal, profile }, { signal: target, profile: targetProfile }),
              targetProfile,
              /* The analyzer's own instructions — the exact strings the loop puts in a
                 repair message — so a hand-driven iteration sees what the model would
                 have seen instead of a wall of numbers. */
              directives: humanReadableDiff(profile, targetProfile, now.ast),
            };
          })()),
    };
  }, []);

  /**
   * Register what an agent may do to this tab, and stay connected.
   *
   * Installed once, everything time-varying read through `live`/`actions`, for the reason
   * spelled out above. Unlike `window.txt2sfx` this is *not* dev-only: a static build
   * served on a laptop is exactly the case where an agent with no dev server still wants
   * an ear, and the daemon it talks to is the user's own process on loopback.
   */
  useEffect(() => {
    const unsubscribe = bridgeClient.onStatus(setBridgeStatus);

    bridgeClient.handle('playground.state', () => {
      const now = live.current;
      return {
        name: now.selected,
        soundline: now.source,
        prompt: now.prompt,
        seed: now.seed,
        issues: now.issues,
        peak: now.rendered?.peak ?? null,
        clipped: now.rendered?.clipped ?? null,
        durationMs: now.rendered?.durationMs ?? null,
        bytes: now.code?.bytes ?? null,
        reference: now.reference === null ? null : { name: now.reference.name },
        names: now.entries.map((entry) => entry.name),
      };
    });

    bridgeClient.handle('playground.audition', async (params) => {
      const text = String(params['soundline'] ?? '');
      const name = String(params['name'] ?? 'from-agent');
      if (text.trim() !== '') {
        actions.current.onGenerated({ name, source: text, prompt: String(params['prompt'] ?? '') });
      }
      /* Give React a frame to commit the new buffer before playing it, so what is heard
         and what is on screen are the same recipe. */
      await new Promise((resolve) => window.setTimeout(resolve, 30));
      if (params['loop'] === true) actions.current.loop();
      else actions.current.play();
      const now = live.current;
      return { durationMs: now.rendered?.durationMs ?? null, peak: now.rendered?.peak ?? null };
    });

    bridgeClient.handle('playground.render', async (params) => {
      const text = String(params['soundline'] ?? '');
      const parsedNow = parseWithDiagnostics(text);
      if (parsedNow.ast === null) {
        return { error: parsedNow.errors.map((e) => e.message), issues: [] };
      }
      const useSeed = typeof params['seed'] === 'number' ? params['seed'] : live.current.seed;
      const result = await render(parsedNow.ast, { seed: useSeed });
      const signal = {
        samples: Float32Array.from(result.buffer.getChannelData(0)),
        sampleRate: result.buffer.sampleRate,
      };
      let compiled: CodegenResult | null = null;
      try {
        compiled = codegen(parsedNow.ast, { seed: useSeed });
      } catch {
        compiled = null;
      }
      return {
        peak: result.peak,
        clipped: result.clipped,
        durationMs: result.durationMs,
        profile: extractProfile(signal),
        metrics: metricsOf(signal),
        bytes: compiled?.bytes ?? null,
        withinBudget: compiled?.withinBudget ?? null,
        issues: validate(parsedNow.ast),
      };
    });

    bridgeClient.handle('playground.open', (params) => {
      const name = String(params['name'] ?? 'from-agent');
      actions.current.onGenerated({
        name,
        source: String(params['soundline'] ?? ''),
        prompt: String(params['prompt'] ?? ''),
      });
      setScreen('studio');
      setView('sound');
      return { name };
    });

    bridgeClient.handle('playground.compare', () => measure());

    bridgeClient.handle('playground.fit', async (params) => {
      const text = String(params['soundline'] ?? live.current.source);
      if (live.current.reference === null) throw new Error('no B side is loaded in this tab to fit against');
      const result = await optimize({
        source: text,
        target: targetFromBuffer(live.current.reference.buffer),
        render: renderSignalFor(live.current.seed),
        generations: typeof params['generations'] === 'number' ? params['generations'] : FIT_GENERATIONS,
        populationSize: FIT_POPULATION,
        anchor: FIT_ANCHOR,
        initialSpread: FIT_SPREAD,
      });
      if (result.slots.length > 0) actions.current.setSource(result.source);
      return {
        soundline: result.source,
        initialDistance: result.initialDistance,
        distance: result.distance,
        stopped: result.de.stopped,
      };
    });

    bridgeClient.handle('playground.publish', () => actions.current.publish());
    bridgeClient.handle('playground.save', () => {
      actions.current.save();
      return { ok: canSave };
    });

    bridgeClient.start();
    return () => {
      unsubscribe();
      bridgeClient.stop();
    };
  }, [measure]);

  /* Tell the daemon what this tab is holding, so an agent's `sfx_open` can name a recipe
     that exists rather than guessing. Throttled by React's own batching; the payload is
     a list of short strings. */
  useEffect(() => {
    bridgeClient.announce(takenNames, selected);
  }, [takenNames, selected]);

  /**
   * `window.txt2sfx`: drive and measure the playground from a debugger.
   *
   * Installed only under `vite dev`. Everything it exposes is now also reachable over the
   * bridge, but the two serve different people: this one answers a *human* holding
   * devtools, which is still the fastest way to tell "the model wrote a bad recipe" apart
   * from "our prompt, validator or feedback is at fault".
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const api = {
      version: 2,
      request: () => bridge.request(),
      system: () => bridge.system(),
      reply: (id: number, text: string) => bridge.reply(id, text),
      fail: (id: number, message: string) => bridge.fail(id, message),
      run: (nextPrompt: string) => {
        setPrompt(nextPrompt);
        setScreen('studio');
        generation.start(nextPrompt, { ...settings, kind: 'bridge' });
      },
      recipe: () => live.current.source,
      setRecipe: (text: string) => actions.current.setSource(text),
      select: (name: string) => actions.current.select(name),
      names: () => live.current.entries.map((entry) => entry.name),
      fit: () => actions.current.fit(),
      measure,
      loadReference: async (url: string): Promise<string> => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url} → HTTP ${String(response.status)}`);
        const blob = await response.blob();
        const name = url.split('/').pop() ?? 'reference';
        actions.current.loadReference(new File([blob], name));
        return name;
      },
      target: async (text: string, opts: { seconds?: number; seed?: number } = {}): Promise<string> => {
        /* The render arrives in the response and is never written to `out/`, so there is
           nothing to fetch afterwards — only a name to report back. */
        const file = await renderTarget({ prompt: text, ...opts });
        actions.current.loadReference(file);
        setBKind('model');
        return file.name;
      },
      bridge: () => bridgeClient.current(),
    };

    (window as unknown as Record<string, unknown>)['txt2sfx'] = api;
    return () => {
      delete (window as unknown as Record<string, unknown>)['txt2sfx'];
    };
    /* Installed once. Everything time-varying is read through `live`/`actions`, so the
       object on `window` never goes stale and never has to be re-fetched by a caller. */
  }, [measure]);

  /* Ctrl/Cmd+Enter plays, Ctrl/Cmd+S saves. Space is off limits — it belongs to the
     textarea, and an editor that swallows spaces is not an editor. */
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

  /* --- warnings ----------------------------------------------------------- */

  const warnings: string[] = [];
  if (rendered?.clipped === true) {
    warnings.push(t('warn.clipped', { peak: rendered.peak.toFixed(3), limit: GLOBAL_LIMITS.maxPeak }));
  }
  if (ast !== null && rendered !== null) {
    const declared = declaredDurationMs(ast);
    const actual = rendered.durationMs - 50;
    if (actual > declared * 1.15) {
      warnings.push(t('warn.longer', { actual: Math.round(actual), declared: Math.round(declared) }));
    }
  }
  if (code !== null && !code.withinBudget) {
    warnings.push(t('warn.overBudget', { bytes: code.bytes, budget: GLOBAL_LIMITS.maxExportBytes }));
  }
  if (renderError !== null) warnings.push(renderError);
  if (referenceError !== null) warnings.push(referenceError);

  /* --- render ------------------------------------------------------------- */

  return (
    <div className="app">
      <Header
        screen={screen}
        onScreen={(next) => {
          stop();
          setScreen(next);
        }}
        bridge={bridgeStatus}
        onOpenBridge={() => setBridgeOpen(true)}
      />

      {screen === 'gallery' ? (
        <Gallery
          items={items}
          seed={seed}
          prompt={prompt}
          onPromptChange={setPrompt}
          onGenerate={generateFromGallery}
          query={query}
          onQueryChange={setQuery}
          filter={filter}
          onFilterChange={setFilter}
          onboarded={library.onboarded}
          onDismissOnboarding={() => {
            setLibrary((currentLibrary) => {
              const next = { ...currentLibrary, onboarded: true };
              saveLibrary(next);
              return next;
            });
          }}
          playing={playingName}
          onOpen={open}
          onPlay={(name) => playNamed(name, items.find((item) => item.name === name)?.source ?? '')}
          onTrash={trash}
        />
      ) : null}

      {screen === 'studio' ? (
        <Studio
          items={items}
          selected={selected}
          dirty={dirty}
          railMode={railMode}
          onRailMode={setRailMode}
          onSelect={select}
          /* The selected row plays the editor's text, not the stored one — the rail
             shows the working set, and a row that sounds unlike what is on screen
             would be a lie about which sound you are looking at. */
          onRailPlay={(name) =>
            name === selected
              ? play()
              : playNamed(name, items.find((item) => item.name === name)?.source ?? '')
          }
          railPlaying={playingName}
          onTrash={trash}
          onNew={() => {
            setPrompt('');
            setScreen('gallery');
            setFilter('all');
            setQuery('');
          }}
          source={source}
          onSourceChange={setSource}
          ast={ast}
          errors={parsed.errors}
          issues={issues}
          warnings={warnings}
          code={code}
          rendered={rendered}
          seed={seed}
          slots={slots}
          onSlotChange={onSlotChange}
          view={view}
          onView={setView}
          prompt={prompt}
          onPromptChange={setPrompt}
          settings={settings}
          onSettingsChange={setSettings}
          generation={generation}
          agentReady={bridgeStatus.health?.agent.connected === true}
          playing={playingName === selected}
          onPlay={play}
          onLoop={loop}
          formatId={formatId}
          onFormat={setFormatId}
          onDownload={onDownload}
          onShare={() => setScreen('share')}
          b={b}
          bKind={bKind}
          onBKind={setBKind}
          candidateLayers={layerBuffers}
          modelAvailable={modelAvailable}
          onLoadFile={loadReference}
          onNewTake={newTake}
          onModelRendered={(file) => {
            setBKind('model');
            loadReference(file);
          }}
          fitting={fitting}
          fitRunning={fitRunning}
          fitBlocked={fitBlocked}
          onFit={fit}
          onStopFit={stopFit}
          maxPeak={GLOBAL_LIMITS.maxPeak}
        />
      ) : null}

      {screen === 'share' ? (
        <Share
          name={selected}
          /* Falls through to the catalog row, which carries the recipe's own leading
             comment when no prompt was ever recorded — a share card with the author's
             one-line description on it beats one with the file name repeated twice. */
          prompt={prompt === '' ? (items.find((item) => item.name === selected)?.prompt ?? '') : prompt}
          source={source}
          category={ast?.category}
          code={code}
          rendered={rendered}
          durationMs={ast === null ? 0 : declaredDurationMs(ast)}
          playing={playingName === selected}
          onPlay={play}
          onBack={() => setScreen('studio')}
          formatId={formatId}
          onFormat={setFormatId}
          onDownload={onDownload}
        />
      ) : null}

      {bridgeOpen ? (
        <BridgeDialog
          status={bridgeStatus}
          onClose={() => setBridgeOpen(false)}
          onRecheck={() => bridgeClient.recheck()}
          onUrlChange={(url) => bridgeClient.retarget(url)}
        />
      ) : null}

      {status === null ? null : (
        <div className="toast" role="status" onClick={() => setStatus(null)}>
          {status}
        </div>
      )}

      {/* The seed belongs to the whole session rather than to a panel: a recipe auditioned
          under one seed and exported under another is two different sounds with one name. */}
      <div className="seedbar mono">
        <label>
          {t('app.seed')}
          <input
            type="number"
            name="seed"
            value={seed}
            onChange={(event) => setSeed(Number(event.target.valueAsNumber || 0))}
          />
        </label>
        <button type="button" title={t('app.rndTitle')} onClick={() => setSeed(Math.floor(Math.random() * 0xffff))}>
          {t('app.rnd')}
        </button>
        {canSave ? (
          <button type="button" onClick={save} title={t('app.saveTitle')}>
            {t('app.save')}
          </button>
        ) : null}
        <button type="button" onClick={() => void publish().then(setStatus)} disabled={rendered === null}>
          {t('app.publish')}
        </button>
      </div>
    </div>
  );
}
