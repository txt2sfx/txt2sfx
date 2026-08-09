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
import { AccountPill } from './components/AccountPill.js';
import { BridgeDialog } from './components/BridgeDialog.js';
import { CommentsDialog } from './components/CommentsDialog.js';
import { Header, type Screen } from './components/Header.js';
import type { BKind } from './components/ComparePanel.js';
import type { RailMode } from './components/Rail.js';
import type { StudioView } from './components/PromptRow.js';
import { Gallery, type GalleryItem } from './screens/Gallery.js';
import { Loop } from './screens/Loop.js';
import { Share } from './screens/Share.js';
import { Studio } from './screens/Studio.js';
import { chooseProvider, providerFor, recipeName, renderSignalFor, targetFromBuffer } from './lib/agent.js';
import { decodeAudioFile, metricsOf, signalOf, type Reference } from './lib/analysis.js';
import { useAccount } from './lib/account.js';
import { BankError, bankClient, DEFAULT_BANK_URL, type BankHealth } from './lib/bank.js';
import { bridge } from './lib/bridge.js';
import { bridgeClient, type BridgeStatus } from './lib/bridge-client.js';
import { bankEntries, exampleEntries, mergeCatalog, presetEntries, type Entry } from './lib/catalog.js';
import { download, loadFormat, saveFormat, type Format } from './lib/download.js';
import { fetchPreview, type FreesoundSound } from './lib/freesound.js';
import { playBuffer, playLive, render, type Playback } from './lib/engine.js';
import { bundledRecipes, canSave, fetchRecipes, saveRecipe } from './lib/examples.js';
import { bundledPresets } from './lib/presets.js';
import { useI18n } from './lib/i18n.js';
import { renderLayers } from './lib/layers.js';
import { loadLibrary, saveLibrary, type Library } from './lib/library.js';
import { startRecording, type Recorder } from './lib/record.js';
import {
  MASTER_KINDS,
  MASTER_REST,
  anchorMasters,
  applyMaster,
  atRest,
  moveMaster,
  type MasterAnchor,
  type MasterKind,
  type MasterPositions,
} from './lib/master.js';
import { loadSession, saveSession } from './lib/session.js';
import { clearShareFromLocation, sharedFromLocation } from './lib/share.js';
import { applySlot, collectSlots, type Slot } from './lib/slots.js';
import { vary } from './lib/variation.js';
import { modelStatus, renderTarget } from './lib/stable-audio.js';
import { DEFAULT_SETTINGS, useGenerate, type ProviderSettings } from './lib/useGenerate.js';
import { useLoop } from './lib/useLoop.js';
import { useSearch } from './lib/useSearch.js';

/** How long to wait after the last edit before re-rendering offline. */
const RENDER_DEBOUNCE_MS = 140;

/** How long to wait after the last edit before an auto-play retrigger. */
const AUTOPLAY_DEBOUNCE_MS = 260;

/**
 * How long to wait after the last keystroke in the gallery's search box before asking
 * the bank.
 *
 * The pace of typing rather than of rendering, so it is more than double
 * {@link RENDER_DEBOUNCE_MS}: a search is a round trip to another host, and every
 * character sent while a word is still being typed is an answer that is already stale
 * when it arrives. 300 ms is about the longest gap inside a word at ordinary typing
 * speed, so it fires when somebody stops rather than when they pause.
 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * How long to wait after the last edit before writing this tab's unsaved recipes down.
 *
 * The write is a `JSON.stringify` of the whole unsaved working set, and a slider drag
 * produces an edit per frame; half a second means a drag costs one write instead of sixty.
 * Losing the last half-second of typing to a reload is invisible next to losing the recipe,
 * which is what persisting it at all is for.
 */
const SESSION_SAVE_DEBOUNCE_MS = 500;

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
  /**
   * Recipes that exist only in this tab: generated, shared in, or not yet saved.
   *
   * Restored from `localStorage`, which is the one place in the playground where content
   * rather than a preference is persisted — see `lib/session.ts` for why unsaved work is
   * the exception to that rule.
   */
  const [session, setSession] = useState<readonly Entry[]>(() =>
    loadSession().map((recipe) => ({ ...recipe, origin: 'session' as const })),
  );
  /**
   * The shipped catalog, bundled at build time.
   *
   * Not state: nothing can change it while the tab is open — a preset is read-only
   * by contract, and saving an edited one writes a copy into `examples/`.
   */
  const presets = useMemo<readonly Entry[]>(() => presetEntries(bundledPresets()), []);
  const [bankList, setBankList] = useState<readonly Entry[]>([]);
  const [bankUrl] = useState(DEFAULT_BANK_URL);
  const [bankHealth, setBankHealth] = useState<BankHealth | null>(null);
  const [bankNonce, setBankNonce] = useState(0);
  /** Which listed recipes this viewer has liked. Answered with the listing itself. */
  const [liked, setLiked] = useState<ReadonlySet<number>>(() => new Set());
  /** The recipe whose thread is open, if any. */
  const [discussing, setDiscussing] = useState<{ id: number; name: string; soundline: string } | null>(null);
  /**
   * The session token.
   *
   * A ref, not state: the bank client reads it through a getter at call time, so the
   * client stays the same object across a sign-in and the effects keyed on it — the
   * gallery listing among them — do not all re-run.
   */
  const sessionToken = useRef<string | null>(null);
  const [library, setLibrary] = useState<Library>(() => loadLibrary());

  /* --- navigation --------------------------------------------------------- */

  const [screen, setScreen] = useState<Screen>('gallery');
  const [view, setView] = useState<StudioView>('sound');
  const [railMode, setRailMode] = useState<RailMode>('recent');
  /**
   * The gallery's search box and category chip.
   *
   * React state and not the address bar, deliberately. There is no router here — screens
   * are a `useState` — and the URL is already carrying two payloads that must survive a
   * reload untouched: a shared recipe and the auth hand-off code (`lib/share.ts`,
   * `code` / `return`). Adding `?q=` next to those buys a shareable search nobody asked
   * for and risks colliding with the two mechanisms that *are* load-bearing.
   */
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [bridgeOpen, setBridgeOpen] = useState(false);

  /* --- the recipe --------------------------------------------------------- */

  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState<string>(() => bundledRecipes()[0]?.name ?? '');
  /**
   * A run was started from the gallery and has not produced a recipe yet.
   *
   * `selected` cannot express this. It always names *some* recipe — the first bundled one
   * in a fresh tab — so arriving in the studio from the gallery's prompt box used to open
   * a stranger's `metal-door-slam` with an editor, a slider rack and an Export card under
   * it, none of which had anything to do with the sentence just typed. The screen said
   * "here is a sound" while the sound was still being written.
   *
   * So the studio has a second state, and it lasts exactly until there is something real
   * to show: {@link onGenerated} clears it, and so does picking a recipe from the rail —
   * which is the way out when a run comes back with nothing.
   */
  const [composing, setComposing] = useState(false);
  /** Editor buffers, keyed by recipe name. Absent means "as stored". */
  const [edits, setEdits] = useState<Readonly<Record<string, string>>>({});
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [rendered, setRendered] = useState<RenderResult | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [playingName, setPlayingName] = useState<string | null>(null);
  const [looping, setLooping] = useState(false);
  /* Two menus, two memories, both read from `localStorage` on the way in — the argument
     for keeping them apart, and for MP3 rather than the JavaScript as the default, is in
     `lib/download.ts`. */
  const [formatId, setFormatId] = useState(() => loadFormat('sound'));
  const [modelFormatId, setModelFormatId] = useState(() => loadFormat('model'));
  /* A third menu, and a third memory. The loop's list is JS / TS / MIDI / WAV / MP3 —
     a `soundline` entry there would export one note of it, which is the same class of
     lie the two existing menus are kept apart to avoid. */
  const [loopFormatId, setLoopFormatId] = useState(() => loadFormat('loop'));
  const [status, setStatus] = useState<string | null>(null);
  const [settings, setSettings] = useState<ProviderSettings>(DEFAULT_SETTINGS);

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
  const [libraryLoaded, setLibraryLoaded] = useState(false);

  /* The open microphone, in a ref because it is a device and not something the interface
     draws — what the interface draws is `recording`, and the two must not be able to
     disagree: a stale copy of a stopped recorder would keep a capture running with no way
     left to end it. */
  const recorder = useRef<Recorder | null>(null);
  /* Between the press and the user's answer to the permission prompt there is no recorder
     yet and nothing on screen has changed, so a second press would ask for a second
     stream and leave the first one running with nobody holding it. */
  const opening = useRef(false);
  const [recording, setRecording] = useState(false);

  /* --- who answers -------------------------------------------------------- */

  /* Declared before the screens that read it, because *every* screen reads it: the
     prompt row's label, the soundtrack composer, the captioning step and the dialog all
     ask the same question, and the answer is derived rather than chosen. */
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>(() => bridgeClient.current());

  /**
   * Who answers a prompt in this tab, decided in one place.
   *
   * The prompt row's label, the button's disabled state, the dialog's headline, the
   * captioning step and NeurosLoop's composer all read this one value — the alternative
   * is five copies of the same `if`, and the day they disagree the interface is lying
   * about which model is about to be spent.
   */
  const agentReady = bridgeStatus.health?.agent.connected === true;
  const model = chooseProvider(settings, agentReady);

  /* --- the library -------------------------------------------------------- */

  /* Above the screens for the reason the run is: the Search tab unmounts every time
     someone switches to Compare to look at what they just found, and a result list —
     never mind a pasted key — that died on a tab switch would make the two unusable
     together, which is the whole workflow. */
  const search = useSearch({ bankUrl });

  /* --- the soundtrack screen ---------------------------------------------- */

  /* Above the screens for the same reason the search is: the arrangements and the mixed
     buffer are minutes of composing and a few hundred offline renders, and losing them
     to a tab switch would make the screen unusable next to the other two. It shares the
     session seed, so a soundtrack and a sound effect auditioned in the same sitting are
     drawn from the same noise.

     The provider is handed in as a factory rather than as an object: the key can be
     pasted while the screen is open, and a provider built at mount would carry the key
     the tab started with — which was empty. */
  const loopState = useLoop({ seed, model, provider: () => providerFor(settings, agentReady) });

  /* --- fitting ------------------------------------------------------------ */

  const [fitting, setFitting] = useState<string | null>(null);
  const [fitRunning, setFitRunning] = useState(false);

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

  const bank = useMemo(() => bankClient(bankUrl, { token: () => sessionToken.current }), [bankUrl]);
  const account = useAccount(bank, sessionToken);

  /* The bank is optional. Health decides whether the agent gets few-shot examples at all,
     and whether the gallery's search is answered by a server or by this page, so it is
     asked first and the listing only follows a live answer — otherwise a wrong URL costs
     two failed requests instead of one. Not polled: repeatedly calling a URL somebody
     typed is noise. */
  useEffect(() => {
    let cancelled = false;
    void bank.health().then((health) => {
      if (!cancelled) setBankHealth(health);
    });
    return () => {
      cancelled = true;
    };
  }, [bank, bankNonce, account.account]);

  /**
   * The bank's half of the gallery, which is also the search.
   *
   * One effect owns the listing rather than two, and that is the whole design here: a
   * listing fired at mount and a search debounced behind it are two requests whose
   * answers arrive in whatever order the network chose, and the last one to land wins.
   * With a single owner, the query and the category are simply part of what is asked
   * for, and cancelling the previous timer cancels the previous question.
   *
   * The server answers it because the index is there — `q` runs against FTS5 over
   * prompts and tags, which a page holding a hundred of the bank's recipes does not
   * have. When the bank is down this effect clears its half and the gallery filters the
   * bundle by substring, exactly as it always did.
   */
  useEffect(() => {
    if (bankHealth === null) {
      setBankList([]);
      return;
    }
    let cancelled = false;
    const q = query.trim();
    const category = filter === 'all' || filter === 'trash' ? undefined : filter;

    const ask = (): void => {
      void bank
        .list({ ...(q === '' ? {} : { q }), ...(category === undefined ? {} : { category }) })
        .then((listed) => {
          if (cancelled) return;
          setBankList(bankEntries(listed.recipes));
          setLiked(listed.liked);
        });
    };

    /* Only typing needs the delay. A chip click and the first listing are single events,
       and making the catalog appear a third of a second after the screen does would be
       paying the cost of debouncing without the reason for it. */
    const timer = window.setTimeout(ask, q === '' ? 0 : SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bank, bankHealth, bankNonce, account.account, query, filter]);

  /* Re-asked whenever the bridge's state changes, not once at mount: the ordinary way
     this goes from "no model" to "ready" is somebody running `npx txt2sfx-bridge` while
     the tab is already open, and a Compare panel still saying the model is missing
     afterwards would be lying about something they just fixed. */
  useEffect(() => {
    let cancelled = false;
    void modelStatus().then((next) => {
      if (!cancelled) setModelAvailable(next?.ready === true);
    });
    return () => {
      cancelled = true;
    };
  }, [bridgeStatus.state]);

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

  /**
   * The catalog, in falling order of authority: session, examples, bank, preset.
   *
   * Each store only contributes a name the ones before it did not claim. Presets are
   * last because the bank ships them too, with an id, a rating and a comment thread
   * the bundled copy does not have — but they are *present*, which is what makes the
   * gallery a catalog rather than an empty page when there is no bank to ask.
   */
  const entries = useMemo(() => {
    const stored: Entry[] = [...examples];
    for (const list of [bankList, presets]) {
      for (const entry of list) {
        if (!stored.some((seen) => seen.name === entry.name)) stored.push(entry);
      }
    }
    return mergeCatalog(session, stored);
  }, [session, examples, bankList, presets]);
  const pristine = useMemo(() => new Map(entries.map((entry) => [entry.name, entry.source])), [entries]);
  /**
   * The last recipe that was selected while it was still in the catalog.
   *
   * The bank half of the catalog is now the answer to the gallery's search box, so it can
   * stop containing a recipe that is open in the studio — go back, type something else,
   * return, and the editor would have emptied itself under a name that is still selected.
   * Holding the entry costs one reference and makes the studio depend on what was opened
   * rather than on what a search on another screen is currently listing. Written during
   * render, like the bridge's `live` ref above and for the same reason: it must be correct
   * for *this* pass, not for the one after an effect.
   */
  const held = useRef<Entry | null>(null);
  const current = useMemo(() => entries.find((entry) => entry.name === selected), [entries, selected]);
  if (current !== undefined) held.current = current;
  const source =
    edits[selected] ??
    pristine.get(selected) ??
    (held.current?.name === selected ? held.current.source : '');
  const dirty = useMemo(
    () => Object.keys(edits).filter((name) => pristine.has(name) && edits[name] !== pristine.get(name)),
    [edits, pristine],
  );

  const parsed = useMemo(() => parseWithDiagnostics(source), [source]);
  const ast = parsed.ast;
  const slots = useMemo(() => (ast === null ? [] : collectSlots(ast)), [ast]);

  /* Which masters have anything to turn. Derived here rather than inside the card so the
     three probe transforms run once per edit instead of once per render — each of them
     parses the recipe, which is cheap but not free at sixty frames of a drag. */
  const masterAvailable = useMemo<Readonly<Record<MasterKind, boolean>>>(
    () =>
      Object.fromEntries(
        MASTER_KINDS.map((kind) => [kind, applyMaster(source, kind, 1).touched > 0]),
      ) as Record<MasterKind, boolean>,
    [source],
  );

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
          ...(entry.id === undefined
            ? {}
            : {
                bankId: entry.id,
                likes: entry.rating ?? 0,
                liked: liked.has(entry.id),
                comments: entry.comments ?? 0,
                ...(entry.author === undefined ? {} : { author: entry.author }),
              }),
        };
      }),
    [entries, edits, library, liked],
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
    setLooping(false);
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

  /* A loop has no end of its own to stop it, so the button that starts one is the only
     thing that can end it: pressing it again is the off switch, not a restart. */
  const loop = useCallback(() => {
    if (rendered === null) return;
    if (looping) {
      stop();
      return;
    }
    stop();
    playback.current = playBuffer(rendered.buffer, { loop: true });
    setPlayingName(selected);
    setLooping(true);
  }, [looping, rendered, selected, stop]);

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

  /**
   * Decode a file and make it the B side.
   *
   * Returns the reference it loaded, and null when the decode failed. Not for the
   * callers that only press a button — every one of them ignores it — but for the
   * microphone, which has to fit against what it just recorded and cannot read that out
   * of `reference` in the same tick it was set. Handing back the value is cheaper than a
   * second decoding path, and this stays the one place that knows what B is.
   */
  const loadReference = useCallback(
    (file: File, fromLibrary = false): Promise<Reference | null> => {
      setReferenceError(null);
      /* Remembered here rather than derived from `bKind`, which is a *label* for what is
         loaded and moves whenever someone flips a chip to read a different hint. The
         Compare panel needs the fact — is the thing on screen a library recording — to
         decide whether its Library chip should go looking for one. */
      setLibraryLoaded(fromLibrary);
      return decodeAudioFile(file)
        .then((buffer) => {
          const loaded: Reference = { name: file.name, buffer };
          setReference(loaded);
          return loaded;
        })
        .catch((error: unknown) => {
          setReference(null);
          setReferenceError(t('warn.decodeFail', { file: file.name, error: String(error) }));
          return null;
        });
    },
    [t],
  );

  /**
   * Take a search result and make it the B side.
   *
   * The preview is fetched here rather than in the panel because this is where the
   * reference lives, and because the road a library sound takes must be the same one a
   * dropped file takes — one decode, one failure message, one place that knows what B is.
   */
  const useSound = useCallback(
    async (sound: FreesoundSound): Promise<void> => {
      const file = await fetchPreview(sound);
      loadReference(file, true);
      setBKind('library');
    },
    [loadReference],
  );

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

  /**
   * The recipe the master knobs are measured against, and where they stand on it.
   *
   * A ref and not state: it must be readable and writable inside the same event that
   * writes the source. The positions are duplicated into state below because those the
   * interface *does* draw, and the anchor is not a thing a render can depend on — it is
   * only ever consulted by the handler that is about to replace it.
   *
   * `null` means "whatever the editor holds is the new zero", which is the state after
   * every edit that did not come from a master. The anchor is not taken eagerly on load
   * because most recipes are opened, listened to and closed without a knob being touched,
   * and an anchor nobody used is a string held for nothing.
   */
  const masterAnchor = useRef<MasterAnchor | null>(null);
  const [masters, setMasters] = useState<MasterPositions>(MASTER_REST);

  /** Forget the base and put the knobs back in the middle, without touching the text. */
  const restMasters = useCallback(() => {
    masterAnchor.current = null;
    setMasters((current) => (atRest(current) ? current : MASTER_REST));
  }, []);

  /**
   * Re-anchor whenever the text moved under the knobs.
   *
   * Typing, a fit, a variation, a generated recipe, opening another one: all of them
   * leave `source` different from what the anchor produced, and a knob still claiming
   * "×2 of a base" that nothing on screen resembles any more would be the lie the old jog
   * was avoiding. Comparing texts rather than counting edits means every one of those
   * paths is covered without any of them having to know the masters exist.
   */
  useEffect(() => {
    if (masterAnchor.current?.source !== source) restMasters();
  }, [source, restMasters]);

  const onMaster = useCallback(
    (kind: MasterKind, position: number) => {
      const held = masterAnchor.current;
      const anchor = held !== null && held.source === source ? held : anchorMasters(source);
      const moved = moveMaster(anchor, kind, position);
      masterAnchor.current = moved;
      setMasters(moved.positions);
      setSource(moved.source);
    },
    [source, setSource],
  );

  const onVariation = useCallback(() => {
    setSource(vary(source, (Math.random() * 0x100000000) >>> 0));
  }, [source, setSource]);

  const select = useCallback(
    (name: string) => {
      stop();
      setSelected(name);
      setStatus(null);
      /* Naming a recipe by hand ends the wait for one, however that wait started. It is
         the only way out of the composing state when a run comes back with nothing. */
      setComposing(false);
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

  /**
   * Take a soundline that arrived from somewhere else into this session.
   *
   * Used by a comment that carries a counter-proposal. It becomes a session recipe —
   * this tab's, unsaved, and marked as such in the gallery — rather than overwriting
   * the recipe it was a reply to, which is somebody else's.
   */
  const adopt = useCallback(
    (name: string, source_: string) => {
      stop();
      setSession((currentSession) => [
        ...currentSession.filter((entry) => entry.name !== name),
        { name, source: source_, origin: 'session' as const, prompt: '' },
      ]);
      setSelected(name);
      setComposing(false);
      setScreen('studio');
      setView('sound');
    },
    [stop],
  );

  /**
   * Like or unlike a published recipe.
   *
   * Optimistic, and then corrected by the number the bank answers with: the round trip
   * is a hundred milliseconds and a heart that fills only after it reads as a broken
   * button. A refusal — no session, or too many likes too fast — puts the heart back
   * and says why, because a silent revert is indistinguishable from a bug.
   */
  const like = useCallback(
    (item: GalleryItem) => {
      const id = item.bankId;
      if (id === undefined) return;
      const next = !(item.liked ?? false);

      setLiked((current) => {
        const updated = new Set(current);
        if (next) updated.add(id);
        else updated.delete(id);
        return updated;
      });
      setBankList((current) =>
        current.map((entry) =>
          entry.id === id ? { ...entry, rating: Math.max(0, (entry.rating ?? 0) + (next ? 1 : -1)) } : entry,
        ),
      );

      void bank
        .setLiked(id, next)
        .then((answer) => {
          setBankList((current) => current.map((entry) => (entry.id === id ? { ...entry, rating: answer.rating } : entry)));
          account.refresh();
        })
        .catch((error: unknown) => {
          setLiked((current) => {
            const updated = new Set(current);
            if (next) updated.delete(id);
            else updated.add(id);
            return updated;
          });
          setBankNonce((n) => n + 1);
          setStatus(error instanceof BankError ? error.message : String(error));
        });
    },
    [account, bank],
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
      /* There is a recipe now, so the skeleton has something to become. */
      setComposing(false);
      touch(recipe.name);
      /* A sentinel that cannot equal a soundline, so the auto-play effect hears the new
         recipe instead of treating it as "already played". Hearing the answer is the
         point of asking. */
      lastPlayed.current = ' ';
    },
    [stop, touch],
  );

  const takenNames = useMemo(() => entries.map((entry) => entry.name), [entries]);

  const generation = useGenerate({
    bank: bankHealth === null ? null : bank.recipes,
    seed,
    reference: b,
    takenNames,
    onGenerated,
  });

  /* A key remembered on a previous visit, put back in the field. Never overwrites a key
     already typed — what is in the box is the user's most recent intent, and what is in
     the store is history. Once, at mount: the keystore is the only source and it does not
     change behind the tab's back. */
  useEffect(() => {
    let cancelled = false;
    void generation.loadKey().then((secret) => {
      if (cancelled || secret === null) return;
      setSettings((current) => (current.apiKey === '' ? { ...current, apiKey: secret } : current));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * From the gallery: put the prompt in the studio and start immediately.
   *
   * The studio opens *composing* rather than on whatever recipe happened to be selected.
   * What the reader asked for does not exist yet, and the honest screen for that is the
   * prompt, the loop explaining itself, and a placeholder where the answer will land.
   */
  const generateFromGallery = useCallback(
    (text: string) => {
      setPrompt(text);
      setComposing(true);
      setScreen('studio');
      setView('sound');
      generation.start(text, settings, { attached: agentReady });
    },
    [agentReady, generation, settings],
  );

  /* --- persistence -------------------------------------------------------- */

  /**
   * File what the editor holds as a new recipe of this session.
   *
   * The masters are why this exists. They are anchored on the recipe as it was opened, so
   * a shifted recipe is a *view* of that one — reversible, and only one at a time. Fork is
   * how a view becomes a thing: the text is copied under its own name, the copy becomes
   * the selection, and the knobs re-anchor on it, which is what puts them back in the
   * middle. Keeping the original untouched is the point; without it, "make this one an
   * octave down as well" means giving up the sound it started from.
   *
   * A session entry rather than a file or a bank record, exactly like `adopt`: this is a
   * candidate somebody is working on, and both of the durable stores are deliberate acts
   * with their own buttons. The text is copied byte for byte — the header keeps the name
   * the model chose, and only the catalog entry is suffixed, which is the same split
   * `recipeName` already makes for a generated recipe.
   */
  const fork = useCallback(() => {
    if (source.trim() === '') return;
    const name = recipeName(source, prompt, takenNames);
    setSession((currentSession) => [...currentSession, { name, source, origin: 'session' as const, prompt }]);
    setSelected(name);
    touch(name);
    restMasters();
    setStatus(t('master.forked', { name }));
  }, [prompt, restMasters, source, t, takenNames, touch]);

  /* Keep this tab's unsaved recipes across a reload. A generated recipe cost a model call
     and a population of renders per generation of the fit, and until it is saved to
     `examples/` or published it exists nowhere else — a reload used to take all of them.
     The editor buffer is folded into the entry rather than stored beside it: a session
     recipe has no stored version anywhere, so what the editor shows *is* the recipe. Runs
     on mount too, which rewrites what was just read — harmless, and cheaper than a flag
     whose only job is to skip one write. */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveSession(
        session.map((entry) => ({
          name: entry.name,
          source: edits[entry.name] ?? entry.source,
          prompt: entry.prompt ?? '',
        })),
      );
    }, SESSION_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [session, edits]);

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
   *
   * `refOverride` exists for the one caller that has a reference React has not committed
   * yet: record → Fit decodes the recording and fits to it inside the same handler, and
   * reading `b` there would read the *previous* B — the same stale-closure trap the
   * bridge's ref is there to avoid, and one that would silently fit to the wrong sound
   * rather than fail. Every other caller passes nothing and gets `b` as before. It is
   * never wired straight to an `onClick`, which would pass a mouse event.
   */
  const fit = useCallback((refOverride?: Reference) => {
    const target = refOverride ?? b;
    if (ast === null || target === null || fitRunning) return;
    const controller = new AbortController();
    fitAbort.current = controller;
    setFitRunning(true);
    setFitting(t('slots.fitting'));
    void optimize({
      source,
      target: targetFromBuffer(target.buffer),
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

  /* Why a fit cannot run *for reasons the recipe owns*. Split out because record → Fit
     is about to supply the B side itself: "no B loaded" would disable that button in
     exactly the case it exists for, while a recipe that does not parse or has no slots
     blocks it for real. */
  const recordFitBlocked = ast === null ? t('blocked.noParse') : slots.length === 0 ? t('blocked.noSlots') : null;

  const fitBlocked = b === null ? t('blocked.noB') : recordFitBlocked;

  /* --- the microphone ----------------------------------------------------- */

  /**
   * One press starts a recording, the next one ends it and loads it as B.
   *
   * Both controls in the panel call this, and the press that *stops* decides whether a
   * fit follows — so starting from the chip and stopping from `record → Fit` does what
   * the button that was pressed last says, rather than what the recording was opened
   * for. There is one recorder, so there is one place to ask.
   *
   * The refusal path is the reference's own: no microphone, no permission and a file
   * that will not decode are the same event as far as the user is concerned — B is not
   * loaded, and the reason is printed where the other one is.
   */
  const onRecord = useCallback(
    (thenFit: boolean) => {
      const running = recorder.current;
      if (running === null) {
        if (opening.current) return;
        opening.current = true;
        setReferenceError(null);
        void startRecording()
          .then((next) => {
            recorder.current = next;
            setRecording(true);
          })
          .catch((error: unknown) => {
            recorder.current = null;
            setRecording(false);
            setReferenceError(t('warn.micDenied', { error: String(error) }));
          })
          .finally(() => {
            opening.current = false;
          });
        return;
      }
      /* Cleared before the stop resolves: the microphone is released inside `stop()`, and
         a second press arriving while the file is being assembled must start a new
         recording rather than await the old one. */
      recorder.current = null;
      setRecording(false);
      void running
        .stop()
        .then(async (file) => {
          const loaded = await loadReference(file);
          if (loaded === null) return;
          setBKind('record');
          /* The decoded buffer, not `b`: this render's `b` is still whatever B was
             before the recording, and state set two lines up is not readable here. */
          if (thenFit) fit(loaded);
        })
        .catch((error: unknown) => setReferenceError(t('warn.micDenied', { error: String(error) })));
    },
    [fit, loadReference, t],
  );

  /* A recording outliving the page would keep the microphone open with nothing left to
     close it. Cancel rather than stop: an unmounting tab has nowhere to put the file. */
  useEffect(() => () => recorder.current?.cancel(), []);

  /* --- downloading -------------------------------------------------------- */

  /* Choosing is what gets remembered, not downloading: a format picked and then not
     downloaded — because nothing was rendered yet — is still the answer to "what do you
     want next time". */
  const chooseFormat = useCallback((id: string): void => {
    setFormatId(id);
    saveFormat('sound', id);
  }, []);

  const chooseModelFormat = useCallback((id: string): void => {
    setModelFormatId(id);
    saveFormat('model', id);
  }, []);

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
      /* The one caller of the provider override: the request is parked on this object
         for whoever is holding devtools, which is a debugging instrument and therefore
         reachable from nowhere in the interface. */
      run: (nextPrompt: string) => {
        setPrompt(nextPrompt);
        setScreen('studio');
        generation.start(nextPrompt, settings, { attached: false, provider: bridge.provider() });
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
          /* Both transports, because they are two `AudioContext` graphs and only the
             user knows they are one application. Leaving a soundtrack looping under the
             gallery would be the single most annoying bug this screen could ship. */
          loopState.stop();
          setScreen(next);
        }}
        bridge={bridgeStatus}
        onOpenBridge={() => setBridgeOpen(true)}
        account={<AccountPill state={account} />}
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
          /* The bank's rows are the answer to the query only while there *is* a query;
             an empty box is a plain listing, and filtering that locally is what makes
             the trash chip and the category chips work offline and online alike. */
          serverFiltered={bankHealth !== null && query.trim() !== ''}
          allCategories={bankHealth !== null}
          canGenerate={model !== null}
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
          onLike={like}
          onComments={(item) => {
            if (item.bankId === undefined) return;
            setDiscussing({ id: item.bankId, name: item.name, soundline: item.source });
          }}
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
          masters={masters}
          masterAvailable={masterAvailable}
          onMaster={onMaster}
          onFork={fork}
          forkBlocked={source.trim() === '' ? t('master.forkBlocked') : null}
          onVariation={onVariation}
          view={view}
          onView={setView}
          prompt={prompt}
          onPromptChange={setPrompt}
          settings={settings}
          model={model}
          onOpenSettings={() => setBridgeOpen(true)}
          generation={generation}
          agentReady={agentReady}
          search={search}
          onUseSound={useSound}
          onStatus={setStatus}
          playing={playingName === selected}
          looping={looping && playingName === selected}
          onPlay={play}
          onLoop={loop}
          formatId={formatId}
          onFormat={chooseFormat}
          modelFormatId={modelFormatId}
          onModelFormat={chooseModelFormat}
          onDownload={onDownload}
          onShare={() => setScreen('share')}
          b={b}
          bKind={bKind}
          onBKind={setBKind}
          candidateLayers={layerBuffers}
          modelAvailable={modelAvailable}
          libraryLoaded={libraryLoaded}
          onModelReady={setModelAvailable}
          onLoadFile={loadReference}
          onNewTake={newTake}
          recording={recording}
          onRecord={onRecord}
          onModelRendered={(file) => {
            setBKind('model');
            loadReference(file);
          }}
          composing={composing}
          matchReference={settings.matchReference}
          onMatchReference={(next) => setSettings((current) => ({ ...current, matchReference: next }))}
          fitting={fitting}
          fitRunning={fitRunning}
          fitBlocked={fitBlocked}
          recordFitBlocked={recordFitBlocked}
          onFit={fit}
          onStopFit={stopFit}
          maxPeak={GLOBAL_LIMITS.maxPeak}
        />
      ) : null}

      {screen === 'loop' ? (
        <Loop
          state={loopState}
          seed={seed}
          formatId={loopFormatId}
          onFormat={(id) => {
            setLoopFormatId(id);
            saveFormat('loop', id);
          }}
          onStatus={setStatus}
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
          onFormat={chooseFormat}
          onDownload={onDownload}
        />
      ) : null}

      {discussing === null ? null : (
        <CommentsDialog
          bank={bank}
          account={account}
          recipe={discussing}
          onClose={() => {
            setDiscussing(null);
            /* The count on the card is part of the listing, so a reply that was just
               posted has to come from somewhere — re-listing is one request and keeps
               one source of truth rather than two counters drifting apart. */
            setBankNonce((n) => n + 1);
          }}
          onPlay={(name, source) => playNamed(name, source)}
          onOpen={(name, source) => {
            setDiscussing(null);
            adopt(name, source);
          }}
        />
      )}

      {bridgeOpen ? (
        <BridgeDialog
          status={bridgeStatus}
          onClose={() => setBridgeOpen(false)}
          onRecheck={() => bridgeClient.recheck()}
          onUrlChange={(url) => bridgeClient.retarget(url)}
          settings={settings}
          onSettingsChange={setSettings}
          model={model}
          keyStored={generation.storedKeys.length > 0}
          onForgetKey={generation.forgetKey}
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
        {/* The seed belongs to the soundtrack screen too — it is the draw every noise
            generator in every lane takes — but Save and Publish do not: they act on the
            studio's current recipe, and a Publish button under an arrangement nobody is
            looking at would publish something else entirely. */}
        {screen === 'loop' ? null : (
          <>
            {canSave ? (
              <button type="button" onClick={save} title={t('app.saveTitle')}>
                {t('app.save')}
              </button>
            ) : null}
            <button type="button" onClick={() => void publish().then(setStatus)} disabled={rendered === null}>
              {t('app.publish')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
