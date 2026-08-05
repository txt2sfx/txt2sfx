/**
 * Text in, soundline out — the front door of the playground.
 *
 * The panel owns the run and nothing else: the provider choice, the key, and the
 * log of what the loop did. The recipe it produces is handed up, and from there it
 * is an ordinary editor buffer like any other, because the whole point of a text
 * format is that a generated recipe and a hand-written one are the same kind of
 * thing.
 *
 * The prompt itself belongs to `App`: under dev a second engine answers the same
 * sentence to produce the reference (see `components/StableAudio.tsx`), and a
 * comparison between two engines given two different sentences is worthless.
 *
 * ## The key
 *
 * A `password` input, React state, passed to the provider factory when Generate is
 * pressed and held nowhere else: no module cache, and the providers do not read the
 * environment. By default closing the tab forgets it.
 *
 * **Remember** is opt-in per provider and encrypts before storing — AES-GCM under a
 * non-extractable `CryptoKey` in IndexedDB, never `localStorage` (see
 * `lib/keystore.ts`, including what that does and does not protect against). It is a
 * checkbox rather than a default because it is the user's credential and the trade is
 * theirs to make, and there is a Forget button next to it because a security feature
 * you cannot undo is a trap.
 *
 * ## What the log is for
 *
 * `generateSound` emits an event per stage, and the stages are the argument of the
 * whole project: the validator caught a category violation, the render caught
 * clipping, the optimizer moved the numbers, and the model was only asked again
 * when there was something it could act on. A spinner would hide exactly that.
 *
 * ## Watching the fit, and leaving with it
 *
 * A fit against a reference is the one stage that takes a minute, and it used to be
 * a minute of one number moving. That is the wrong thing to watch: the failure mode
 * of a metric-driven search is a candidate that scores better and sounds like
 * something else, which a falling number cannot show. So the leader of each
 * generation comes back as a recipe, and `FitPreview` renders and plays it while the
 * search continues. Stop reaches the search itself now, and keeps the best it had
 * reached; `⤓ take it` does the same in one click, because a leader that is already
 * the sound someone wanted should not have to survive another thirty generations.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { generateSound, type GenerateResult, type RecipeSource } from '@txt2sfx/agent';
import {
  demoProvider,
  describeEvent,
  keyedProvider,
  needsKey,
  providerOptions,
  recipeName,
  renderSignalFor,
  targetFromBuffer,
  type DemoRecipe,
  type ProviderKind,
} from '../lib/agent.js';
import { bridge } from '../lib/bridge.js';
import { canRemember, keystore } from '../lib/keystore.js';
import { FitPreview } from './FitPreview.js';

/** What the panel needs from the app around it. */
export interface PromptBarProps {
  /** The prompt, owned by `App` so the reference can be rendered from the same text. */
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  /** Recipes the mock provider may answer with — whatever the gallery is showing. */
  readonly recipes: readonly DemoRecipe[];
  /** Few-shot source for the real providers. `null` when no bank is reachable. */
  readonly bank: RecipeSource | null;
  /** Compile seed, so a generated sound sounds here like it does everywhere else. */
  readonly seed: number;
  /** A decoded reference, when one is loaded in the Compare panel. */
  readonly reference: { readonly name: string; readonly buffer: AudioBuffer } | null;
  /** Names already in the gallery, so a generated recipe never overwrites one. */
  readonly takenNames: readonly string[];
  readonly onGenerated: (recipe: { name: string; source: string; prompt: string }) => void;
}

/**
 * Optimizer budget for a run started from the browser.
 *
 * Smaller than the benchmark's 24 × 60, but **not** small enough to break the
 * loop's hard rule, which an earlier 16 × 14 did: the stall window is a third of
 * the budget, so 14 generations could never produce `stopped: 'stalled'`, and the
 * one branch that asks the model to redesign a topology the numbers cannot rescue
 * was unreachable. A run then ended with "distance 0.51, still improving" and no
 * second opinion — exactly the case the rule exists for. 44 generations give a
 * stall window of 15, which a genuinely flat search reaches.
 *
 * The cost is real: every generation is a population's worth of offline renders on
 * the UI thread. That is what the per-generation progress line is for.
 *
 * `anchor` and `initialSpread` are the two settings that keep the search on the
 * recipe the model designed, and they were added the first time a run was watched
 * end to end: a `game-bubble-pop` that was accepted as "a bit eight-bit but right"
 * came back, after 44 quiet generations, as a completely different sound with a
 * better number. Both causes were structural rather than unlucky. Fifteen of the
 * sixteen starting individuals were uniform samples over every slot's full range,
 * so the design survived as one individual in a population whose centre of mass
 * was somewhere else entirely within a few generations; and the fitness had no
 * term for staying itself, while the metric it does have is peak-normalized and
 * onset-aligned — a broadband wash with the right envelope and centroid can beat a
 * recognizable pop. A spread of 0.25 starts the population around the design; an
 * anchor of 0.25 makes wandering off it cost something. Neither is a wall: a
 * candidate that is genuinely much closer still wins.
 */
const OPTIMIZER = { generations: 44, populationSize: 16, anchor: 0.25, initialSpread: 0.25 } as const;

/**
 * Trips through the model.
 *
 * Five, not three. A parse error and a validator rejection are ordinary first
 * moves — both are cheap, neither renders anything — but with three trips they
 * consume the whole budget and the run ends on its first *measured* attempt, with
 * no iteration left for the restructure the measurement just argued for.
 */
const MAX_ITERATIONS = 5;

export function PromptBar({
  prompt,
  onPromptChange,
  recipes,
  bank,
  seed,
  reference,
  takenNames,
  onGenerated,
}: PromptBarProps): React.JSX.Element {
  const [kind, setKind] = useState<ProviderKind>('mock');
  const [apiKey, setApiKey] = useState('');
  /* Empty means "whatever the provider's default is". Editable because vendors
     retire model ids on their own schedule, and being told to edit a source file
     when a 404 says `no longer available to new users` is a poor answer. */
  const [model, setModel] = useState('');
  const [matchReference, setMatchReference] = useState(false);
  /** Opt-in persistence, per provider. See `lib/keystore.ts` for the honest limits. */
  const [remember, setRemember] = useState(false);
  const [stored, setStored] = useState<readonly string[]>([]);
  const [log, setLog] = useState<readonly string[]>([]);
  /** The search's live line, kept out of the log so it updates instead of piling up. */
  const [progress, setProgress] = useState<string | null>(null);
  /**
   * The candidate currently winning the fit.
   *
   * Kept here rather than left in the event stream because it is the answer to the
   * question a fit used to leave unanswerable: *what does it sound like now*. The
   * search is a minute of numbers moving; the recipe behind the numbers is a sound
   * that can be played and looked at while it moves (see `FitPreview`).
   */
  const [best, setBest] = useState<{ source: string; distance: number } | null>(null);
  const [running, setRunning] = useState(false);
  /** Stop has been asked for and the search has not noticed yet. Usually one render. */
  const [stopping, setStopping] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abort = useRef<AbortController | null>(null);
  /** The leader was taken by hand, so the run's own result must not be filed twice. */
  const taken = useRef(false);

  const options = providerOptions(import.meta.env.DEV);
  const option = options.find((entry) => entry.kind === kind);
  const useTarget = matchReference && reference !== null;
  const blocked = prompt.trim() === '' || (needsKey(kind) && apiKey.trim() === '');

  /**
   * Start a run from explicit values rather than from state.
   *
   * The button passes what the form holds; the devtools bridge passes what it was
   * asked for. Reading state inside would make the second caller depend on a React
   * update having already flushed, which is the kind of race that shows up as "it
   * ran with the previous prompt".
   */
  const start = useCallback(
    (config: {
      prompt: string;
      kind: ProviderKind;
      apiKey: string;
      model: string;
      useTarget: boolean;
    }) => {
      const { prompt, kind, apiKey, model } = config;
      const controller = new AbortController();
      abort.current = controller;
      taken.current = false;
      setRunning(true);
      setStopping(false);
      setLog([]);
      setResult(null);
      setError(null);
      setBest(null);

      const provider =
        kind === 'mock'
          ? demoProvider({ prompt, recipes })
          : kind === 'bridge'
            ? bridge.provider()
            : keyedProvider(kind, apiKey, { model: model.trim() });

      /* Persist on use, not on every keystroke: a key that was actually sent to a
         vendor is one the user meant, while a half-pasted one is not worth storing. */
      if (remember && canRemember && apiKey.trim() !== '' && (kind === 'gemini' || kind === 'anthropic')) {
        void keystore.save(kind, apiKey.trim()).then(() => {
          setStored((names) => (names.includes(kind) ? names : [...names, kind]));
        });
      }

      const target =
        config.useTarget && reference !== null ? targetFromBuffer(reference.buffer) : undefined;

      void generateSound({
      prompt,
      provider,
      render: renderSignalFor(seed),
      maxIterations: MAX_ITERATIONS,
      optimizer: OPTIMIZER,
      /* One cheap call turns "большой камень плюхнулся в озеро" into keywords the
         bank's FTS index can actually match. Without it retrieval silently falls
         back to top-rated recipes and the model learns from unrelated examples.
         Only for the two hosted providers: the mock answers from local recipes and
         has no idea what a keyword is, and the devtools bridge would spend a whole
         human turn on it — the bridge exists to debug the *recipe* half. */
      rewriteQuery: kind === 'gemini' || kind === 'anthropic',
      ...(bank === null ? {} : { bank }),
      ...(target === undefined ? {} : { target }),
      onEvent: (event) => {
        if (controller.signal.aborted) return;
        if (event.type === 'generation') {
          setProgress(
            `⚙ fitting generation ${String(event.generation)}/${String(OPTIMIZER.generations)} · distance ${event.distance.toFixed(3)}${event.diversity < 0.01 ? ' · converged' : ''}`,
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
        /* A cancelled run still produced something, and the optimizer now returns
           the best individual it had reached rather than abandoning it. Discarding
           that on the way out — which is what the old `aborted` guard here did —
           made Stop cost the user the whole wait they had just decided to cut. */
        if (controller.signal.aborted) {
          setLog((lines) => [
            ...lines,
            taken.current
              ? '● taken — the candidate is in the gallery, tune it with the sliders'
              : '● stopped — keeping the best the search had reached',
          ]);
        }
        /* Anything that parsed is worth handing over, accepted or not: a recipe
           that is valid but 0.3 from the target is the starting point for the
           sliders, and throwing it away would waste the run. */
        if (outcome.soundline !== '' && !taken.current) {
          onGenerated({
            name: recipeName(prompt, takenNames),
            source: outcome.soundline,
            prompt,
          });
        }
      })
      .catch((failure: unknown) => {
        /* An abort mid-request arrives here as a rejection. That is a cancellation,
           not a fault, and reporting the fetch's own wording as an error would blame
           the run for doing what it was told. */
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
    },
    [bank, onGenerated, recipes, reference, remember, seed, takenNames],
  );

  const run = useCallback(
    () => start({ prompt, kind, apiKey, model, useTarget }),
    [start, prompt, kind, apiKey, model, useTarget],
  );

  /* Which providers have a remembered key, so the checkbox reflects reality rather
     than a default. Asked once: the answer only changes through this panel. */
  useEffect(() => {
    if (!canRemember) return;
    let cancelled = false;
    void keystore.names().then((names) => {
      if (!cancelled) setStored(names);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* Fill the field from storage when the provider changes to one that has a key.
     Never overwrites something already typed — a key in the box is the user's most
     recent intent, and a stored one is history. */
  useEffect(() => {
    if (!canRemember || !stored.includes(kind)) {
      setRemember(false);
      return;
    }
    setRemember(true);
    let cancelled = false;
    void keystore.load(kind).then((secret) => {
      if (!cancelled && secret !== null) setApiKey((current) => (current === '' ? secret : current));
    });
    return () => {
      cancelled = true;
    };
  }, [kind, stored]);

  const forgetKey = useCallback(() => {
    void keystore.forget(kind).then(() => {
      setStored((names) => names.filter((name) => name !== kind));
      setRemember(false);
      setApiKey('');
    });
  }, [kind]);

  /* The devtools bridge can start a run without the form. Dev-only by construction:
     nothing installs `window.txt2sfx` in a static build (see `App.tsx`). */
  useEffect(() => {
    bridge.setRunner((nextPrompt, runOptions) => {
      const wantsTarget = runOptions.target === true && reference !== null;
      onPromptChange(nextPrompt);
      setKind('bridge');
      setMatchReference(wantsTarget);
      start({ prompt: nextPrompt, kind: 'bridge', apiKey: '', model: '', useTarget: wantsTarget });
    });
  }, [onPromptChange, reference, start]);

  /**
   * Ask the run to stop, and wait for it to actually stop.
   *
   * Deliberately not `setRunning(false)` here. The old version did, and it lied:
   * the abort signal reached the model call and nothing else, so the optimizer kept
   * rendering a population per generation on this thread while the panel said the
   * run was over — a cancelled fit that still owned the machine. The signal now
   * reaches the search, which checks it before every render, so the honest thing is
   * to show `stopping` for the one render it takes and let the promise's `finally`
   * declare the run finished.
   */
  const cancel = useCallback(() => {
    if (abort.current === null) return;
    setStopping(true);
    abort.current.abort();
  }, []);

  /**
   * Keep the candidate on screen and end the run.
   *
   * The third thing missing from a long fit, after seeing and hearing it: leaving
   * with it. A leader that is already the sound the user wanted has no reason to
   * spend thirty more generations drifting, and the Slots panel is the same search
   * by hand and audible immediately.
   */
  const take = useCallback(() => {
    if (best === null) return;
    taken.current = true;
    onGenerated({ name: recipeName(prompt, takenNames), source: best.source, prompt });
    cancel();
  }, [best, cancel, onGenerated, prompt, takenNames]);

  return (
    <div className="prompt">
      <form
        className="prompt-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (!running && !blocked) run();
        }}
      >
        <input
          className="prompt-input"
          type="text"
          name="prompt"
          value={prompt}
          placeholder="a heavy metal door slamming shut in a corridor"
          aria-label="describe the sound"
          onChange={(event) => onPromptChange(event.target.value)}
        />
        {running ? (
          <button type="button" onClick={cancel} disabled={stopping}>
            {stopping ? '■ stopping…' : '■ Stop'}
          </button>
        ) : (
          <button type="submit" className="primary" disabled={blocked}>
            ✦ Generate
          </button>
        )}
      </form>

      <div className="prompt-controls">
        <label className="prompt-field">
          model
          <select
            name="provider"
            value={kind}
            onChange={(event) => setKind(event.target.value as ProviderKind)}
          >
            {options.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        {option?.needsKey === true ? (
          <label className="prompt-field prompt-model">
            model id
            <input
              type="text"
              name="model-id"
              value={model}
              placeholder={option.defaultModel ?? 'default'}
              aria-label="model id"
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
        ) : null}

        {option?.needsKey === true ? (
          <label className="prompt-field prompt-key">
            key
            <input
              type="password"
              name="api-key"
              value={apiKey}
              /* `off` is advisory and Chrome ignores it on password fields: it
                 offered a saved website password for this box. `new-password`
                 is the hint browsers actually honour, and an API key is closer
                 to a new secret than to a stored login anyway. */
              autoComplete="new-password"
              placeholder={`your ${kind} key — this tab only`}
              aria-label={`${kind} API key`}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        ) : null}

        {option?.needsKey === true && canRemember ? (
          <label
            className="toggle"
            title="Encrypted with a non-extractable key in IndexedDB — not localStorage. Any script on this origin could still use it: see lib/keystore.ts."
          >
            <input
              type="checkbox"
              name="remember-key"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            remember
            {stored.includes(kind) ? (
              <button type="button" className="link" onClick={forgetKey}>
                forget
              </button>
            ) : null}
          </label>
        ) : null}

        <label className="toggle" title={reference === null ? 'load a reference in the Compare panel first' : ''}>
          <input
            type="checkbox"
            name="match-reference"
            checked={useTarget}
            disabled={reference === null}
            onChange={(event) => setMatchReference(event.target.checked)}
          />
          match reference
        </label>

        <span className="prompt-note">
          {option?.needsKey === true
            ? `key lives in this tab only, and goes nowhere but ${kind}${option.keySource === undefined ? '' : ` · get one at ${option.keySource}`}`
            : kind === 'bridge'
              ? 'the request waits for window.txt2sfx.reply(id, text) — no network'
              : 'answers from the recipes in the gallery — no network, no key'}
        </span>
      </div>

      {log.length === 0 && result === null && error === null ? null : (
        <div className="prompt-log">
          {log.map((line, index) => (
            <div className="prompt-log-line" key={`${String(index)}-${line}`}>
              {line}
            </div>
          ))}
          {progress === null ? null : <div className="prompt-log-line live">{progress}</div>}
          {error === null ? null : <div className="prompt-log-line bad">✗ {error}</div>}
          {result === null ? null : <Verdict result={result} hadTarget={useTarget} />}
        </div>
      )}

      {/* Outside the log on purpose: the log is a scrolling column with a ceiling,
          and a picture that has to be scrolled into view is a picture nobody sees. */}
      {best === null || !running ? null : <FitPreview source={best.source} seed={seed} onTake={take} />}
    </div>
  );
}

/** What the run amounted to, in one line plus whatever needs saying. */
function Verdict({ result, hadTarget }: { result: GenerateResult; hadTarget: boolean }): React.JSX.Element {
  const warnings = result.issues.filter((issue) => issue.severity !== 'error');

  return (
    <div className="prompt-verdict">
      <div className={result.accepted ? 'prompt-outcome good' : 'prompt-outcome bad'}>
        {result.accepted ? 'accepted' : `not accepted — ${result.outcome}`}
        {result.distance === undefined
          ? null
          : ` · distance ${result.distance.toFixed(3)}${hadTarget ? ' to reference' : ''}`}
        {result.examples.length === 0
          ? ' · no few-shot examples'
          : ` · ${String(result.examples.length)} example(s)${result.fallbackExamples ? ' (fallback)' : ''}`}
      </div>
      {result.message === undefined ? null : <div className="prompt-message">{result.message}</div>}
      {warnings.map((issue) => (
        <div className="prompt-message" key={`${issue.rule}-${issue.layer ?? ''}`}>
          {issue.rule}: {issue.got} — {issue.hint}
        </div>
      ))}
    </div>
  );
}
