/**
 * The generate run, as a hook.
 *
 * ## Why this moved out of a component
 *
 * In the previous layout there was one prompt box, it lived in one panel, and the
 * panel owned the run. The new layout has two entry points — the gallery's hero box
 * starts a run and then navigates to the studio, and the studio's own row restarts
 * it — and one run must survive that navigation. A run owned by a component that
 * unmounts is a run that dies halfway through an optimizer fit, which is a minute of
 * the user's time and a whole population of renders thrown away.
 *
 * So the run lives above both screens and this hook is its interface. Nothing about
 * the loop changed: the events, the budgets and the reasoning behind them are the
 * ones argued out in the old `PromptBar` and are reproduced here because they are
 * still the reasons.
 *
 * ## The log is not debug output
 *
 * `generateSound` emits an event per stage, and the stages *are* the argument of the
 * project: the validator caught a category violation, the render caught clipping, the
 * optimizer moved the numbers, and the model was asked again only when there was
 * something it could act on. The new design has no log panel in it, and dropping the
 * log to match would have deleted the one place where the pipeline explains itself. It
 * is kept, as a strip that is one line while idle and the full stage list while
 * running — see `components/RunStrip.tsx`.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { generateSound, type GenerateResult, type LLMProvider, type RecipeSource } from '@txt2sfx/agent';
import {
  chooseProvider,
  describeEvent,
  providerFor,
  recipeName,
  renderSignalFor,
  targetFromBuffer,
} from './agent.js';
import { canRemember, keystore } from './keystore.js';
import { t } from './i18n.js';

/**
 * Optimizer budget for a run started from the browser.
 *
 * Smaller than the benchmark's 24 × 60, but **not** small enough to break the loop's
 * hard rule, which an earlier 16 × 14 did: the stall window is a third of the budget,
 * so 14 generations could never produce `stopped: 'stalled'`, and the one branch that
 * asks the model to redesign a topology the numbers cannot rescue was unreachable. A
 * run then ended with "distance 0.51, still improving" and no second opinion — exactly
 * the case the rule exists for. 44 generations give a stall window of 15, which a
 * genuinely flat search reaches.
 *
 * `anchor` and `initialSpread` keep the search on the recipe the model designed. Both
 * were added the first time a run was watched end to end: a `game-bubble-pop` accepted
 * as "a bit eight-bit but right" came back, after 44 quiet generations, as a completely
 * different sound with a better number. The metric is peak-normalized and onset-aligned,
 * so a broadband wash with the right envelope and centroid can beat a recognizable pop;
 * a spread of 0.25 starts the population around the design and an anchor of 0.25 makes
 * wandering off it cost something. Neither is a wall.
 */
const OPTIMIZER = { generations: 44, populationSize: 16, anchor: 0.25, initialSpread: 0.25 } as const;

/**
 * Trips through the model.
 *
 * Five, not three. A parse error and a validator rejection are ordinary first moves —
 * both are cheap, neither renders anything — but with three trips they consume the whole
 * budget and the run ends on its first *measured* attempt, with no iteration left for
 * the restructure the measurement just argued for.
 */
const MAX_ITERATIONS = 5;

/**
 * Everything the model settings hold.
 *
 * No `kind`: who answers is *derived* from whether an agent is attached and whether a
 * key has been pasted — see `chooseProvider` in `lib/agent.ts` for why that stopped
 * being a question the user is asked.
 */
export interface ProviderSettings {
  /** The user's Gemini key. Used only when no coding agent is attached. */
  readonly apiKey: string;
  /** Empty means "whatever the provider's default is". */
  readonly model: string;
  readonly remember: boolean;
  readonly matchReference: boolean;
}

/** The state a fresh tab starts in: no key, and whatever the bridge happens to hold. */
export const DEFAULT_SETTINGS: ProviderSettings = {
  apiKey: '',
  model: '',
  remember: false,
  matchReference: false,
};

/** What a run needs to know that is not in the settings. */
export interface RunContext {
  /** Whether a coding agent is attached to the bridge right now. */
  readonly attached: boolean;
  /**
   * Answer with this instead of the derived provider.
   *
   * The one caller is the dev-only devtools instrument (`window.txt2sfx.run`), which
   * parks the request on the page for whoever is holding the console. It is deliberately
   * *not* a provider kind: an escape hatch nobody can reach from the interface does not
   * belong in a table the interface reads.
   */
  readonly provider?: LLMProvider;
}

/** What the hook needs from the app around it. */
export interface GenerateDeps {
  /** Few-shot source for the model. `null` when no bank is reachable. */
  readonly bank: RecipeSource | null;
  readonly seed: number;
  readonly reference: { readonly name: string; readonly buffer: AudioBuffer } | null;
  /** Names already in the catalog, so a generated recipe never overwrites one. */
  readonly takenNames: readonly string[];
  readonly onGenerated: (recipe: { name: string; source: string; prompt: string }) => void;
}

/** Everything a screen needs to show and drive a run. */
export interface Generation {
  readonly running: boolean;
  /** Stop was asked for and the search has not noticed yet. Usually one render. */
  readonly stopping: boolean;
  readonly log: readonly string[];
  /** The search's live line, kept out of the log so it updates instead of piling up. */
  readonly progress: string | null;
  /** The candidate currently winning the fit — playable while the search continues. */
  readonly best: { readonly source: string; readonly distance: number } | null;
  readonly result: GenerateResult | null;
  readonly error: string | null;
  /** Non-empty when a key is remembered on this machine, so the checkbox tells truth. */
  readonly storedKeys: readonly string[];
  readonly start: (prompt: string, settings: ProviderSettings, context: RunContext) => void;
  readonly cancel: () => void;
  /** Keep the fit's current leader and end the run. */
  readonly take: (prompt: string) => void;
  readonly forgetKey: () => void;
  readonly loadKey: () => Promise<string | null>;
}

/** The one name the keystore files a remembered key under. */
const KEY_NAME = 'gemini';

/**
 * What a run says when nothing on this page can answer it.
 *
 * Read at call time rather than captured, so it is in the language the tab is showing
 * now and not the one it started in.
 */
const NO_MODEL = (): string => t('run.noModel');

export function useGenerate(deps: GenerateDeps): Generation {
  const [log, setLog] = useState<readonly string[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [best, setBest] = useState<{ source: string; distance: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storedKeys, setStoredKeys] = useState<readonly string[]>([]);

  const abort = useRef<AbortController | null>(null);
  /** The leader was taken by hand, so the run's own result must not be filed twice. */
  const taken = useRef(false);
  /**
   * Everything the run reads, behind a ref.
   *
   * `start` must not be re-created when the catalog changes, because the gallery calls
   * it and then navigates — a `start` that was rebuilt between the click and the effect
   * would run against the previous catalog. Same hazard, same fix, as the bridge API in
   * `App`: read the current values, do not close over them.
   */
  const live = useRef(deps);
  live.current = deps;

  useEffect(() => {
    if (!canRemember) return;
    let cancelled = false;
    void keystore.names().then((names) => {
      if (!cancelled) setStoredKeys(names);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback((prompt: string, settings: ProviderSettings, context: RunContext) => {
    const { bank, seed, reference, takenNames, onGenerated } = live.current;
    const kind = chooseProvider(settings, context.attached);
    const provider = context.provider ?? providerFor(settings, context.attached);
    if (provider === null) {
      /* Reported rather than thrown, and reported *here* rather than guarded at every
         button: the three entry points into a run are the gallery's hero box, the
         studio's row and the bridge, and only the first two can grey a button out. */
      setError(NO_MODEL());
      return;
    }

    const controller = new AbortController();
    abort.current = controller;
    taken.current = false;
    setRunning(true);
    setStopping(false);
    setLog([]);
    setResult(null);
    setError(null);
    setBest(null);

    /* Persist on use, not on every keystroke: a key that was actually sent to a vendor
       is one the user meant, while a half-pasted one is not worth storing. */
    if (settings.remember && canRemember && settings.apiKey.trim() !== '' && kind === 'gemini') {
      void keystore.save(KEY_NAME, settings.apiKey.trim()).then(() => {
        setStoredKeys((names) => (names.includes(KEY_NAME) ? names : [...names, KEY_NAME]));
      });
    }

    const target =
      settings.matchReference && reference !== null ? targetFromBuffer(reference.buffer) : undefined;

    void generateSound({
      prompt,
      provider,
      render: renderSignalFor(seed),
      maxIterations: MAX_ITERATIONS,
      optimizer: OPTIMIZER,
      /* One cheap call turns "большой камень плюхнулся в озеро" into keywords the bank's
         FTS index can actually match. Without it retrieval silently falls back to
         top-rated recipes and the model learns from unrelated examples. Gemini only: a
         call to a hosted model is a hundred milliseconds, where the same question put to
         an attached coding agent spends a whole turn of somebody's session on picking
         three search words. */
      rewriteQuery: kind === 'gemini' && context.provider === undefined,
      ...(bank === null ? {} : { bank }),
      ...(target === undefined ? {} : { target }),
      onEvent: (event) => {
        if (controller.signal.aborted) return;
        if (event.type === 'generation') {
          setProgress(
            `fitting generation ${String(event.generation)}/${String(OPTIMIZER.generations)} · distance ${event.distance.toFixed(3)}${event.diversity < 0.01 ? ' · converged' : ''}`,
          );
          setBest({ source: event.source, distance: event.distance });
          return;
        }
        setProgress(null);
        setLog((lines) => [...lines, describeEvent(event)]);
      },
      signal: controller.signal,
    })
      .then((outcome) => {
        setResult(outcome);
        /* A cancelled run still produced something, and the optimizer returns the best
           individual it had reached rather than abandoning it. Discarding that on the way
           out would make Stop cost the user the whole wait they had just decided to cut. */
        if (controller.signal.aborted) {
          setLog((lines) => [
            ...lines,
            taken.current
              ? '● taken — the candidate is in the studio, tune it with the sliders'
              : '● stopped — keeping the best the search had reached',
          ]);
        }
        /* Anything that parsed is worth handing over, accepted or not: a recipe that is
           valid but 0.3 from the target is the starting point for the sliders, and
           throwing it away would waste the run. */
        if (outcome.soundline !== '' && !taken.current) {
          onGenerated({
            /* The name comes out of the recipe's own header, not out of the prompt: the
               model named the thing it built and chose its category, and both are already
               validated. See `recipeName`. */
            name: recipeName(outcome.soundline, prompt, takenNames),
            source: outcome.soundline,
            prompt,
          });
        }
      })
      .catch((failure: unknown) => {
        /* An abort mid-request arrives here as a rejection. That is a cancellation, not a
           fault, and reporting the fetch's own wording would blame the run for doing what
           it was told. */
        if (controller.signal.aborted) {
          setLog((lines) => [...lines, '● cancelled before anything was measured']);
          return;
        }
        setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (abort.current === controller) abort.current = null;
        setProgress(null);
        setBest(null);
        setRunning(false);
        setStopping(false);
      });
  }, []);

  /**
   * Ask the run to stop, and wait for it to actually stop.
   *
   * Deliberately not `setRunning(false)` here. An earlier version did, and it lied: the
   * abort signal reached the model call and nothing else, so the optimizer kept rendering
   * a population per generation while the UI said the run was over — a cancelled fit that
   * still owned the machine. The signal now reaches the search, which checks it before
   * every render, so the honest thing is to show `stopping` for the one render it takes.
   */
  const cancel = useCallback(() => {
    if (abort.current === null) return;
    setStopping(true);
    abort.current.abort();
  }, []);

  const take = useCallback(
    (prompt: string) => {
      if (best === null) return;
      taken.current = true;
      live.current.onGenerated({
        name: recipeName(best.source, prompt, live.current.takenNames),
        source: best.source,
        prompt,
      });
      cancel();
    },
    [best, cancel],
  );

  const forgetKey = useCallback(() => {
    void keystore.forget(KEY_NAME).then(() => {
      setStoredKeys((names) => names.filter((name) => name !== KEY_NAME));
    });
  }, []);

  const loadKey = useCallback(
    async (): Promise<string | null> => (canRemember ? keystore.load(KEY_NAME) : null),
    [],
  );

  return {
    running,
    stopping,
    log,
    progress,
    best,
    result,
    error,
    storedKeys,
    start,
    cancel,
    take,
    forgetKey,
    loadKey,
  };
}
