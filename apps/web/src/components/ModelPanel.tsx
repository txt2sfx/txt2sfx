/**
 * The other kind of answer: audio a diffusion model made from the same prompt.
 *
 * ## Why a competitor is in the building
 *
 * Because the honest comparison is the useful one, and because this is not actually a
 * competitor — it is a **target**. Stable Audio returns a few hundred kilobytes of MP3
 * for a sound this project ships as eight hundred bytes of JavaScript, so as a
 * deliverable the two are not in the same category. As a *reference* it is the single
 * most valuable thing on the machine: finding a recording of "a rusty gate opening
 * slowly, then a heavy latch" by hand is the slow step in every session, and here it is
 * one click and thirty seconds of CPU.
 *
 * The view therefore says out loud what it is: rendered audio from the same prompt, no
 * recipe, nothing to tune, nothing to export into a game. Everything it produces flows
 * into the same place a dropped file does — the B side of Compare — and from there the
 * existing machinery applies unchanged. The render arrives *in* the response and is
 * never written down: a target is used once, and a session of clicking this button
 * should not leave a directory of files to sweep up.
 *
 * ## Three screens, not one panel with a warning
 *
 * The model is a gated, multi-gigabyte download, and for most visitors the truthful
 * state of this tab is "you do not have it yet". Showing the render form anyway, with a
 * disabled button and a sentence in the corner, tells someone what they cannot do
 * without telling them what to press. So the panel is a small state machine over
 * `status.stage`, and each state owns the whole view:
 *
 * - **no door** — nothing on this machine is listening. One command fixes it.
 * - **not installed** — the licence to accept, the token to paste or the mirror to
 *   name, exactly where the files will land, and one button that fetches them.
 * - **ready** — the render form, and underneath it what is on the disk and where.
 *
 * ## Why the log is the progress bar
 *
 * A first install downloads a CPython, a gigabyte of wheels and 1.7 GB of weights; a
 * warm render takes thirty seconds. The child process says which is happening — pip's
 * resolver, a download bar, "loaded in 10.1s on cpu" — and a spinner in place of those
 * lines would hide the download, the licence gate and every other reason a run is slow.
 * That is also the argument that makes an install button acceptable here at all. The
 * spinner beside the Stop button is the other half of it, not a replacement: the first
 * line of output can be twenty seconds away, and until it lands the log cannot say that
 * anything is happening at all.
 *
 * ## Why the caption is the prompt itself and not a field of its own
 *
 * The checkpoint conditions on **t5-base**, which reads English and at most 64 tokens.
 * A Russian prompt does not arrive slightly degraded, it arrives with holes in it —
 * `packages/agent/src/caption.ts` has the tokenizer output — and the render then answers
 * a sentence nobody wrote. So pressing Render captions the prompt first: one cheap model
 * call, one line of concrete English acoustics, and *then* the subprocess.
 *
 * That caption used to live in an editable field under the prompt row, on the argument
 * that on a diffusion model the caption is the instrument — it is the difference between
 * a render and a different render, so computing it on the way past would leave the panel
 * with no answer to "why did it make that?". The argument still holds; the second field
 * was the wrong way to honour it. Two text boxes one above the other, holding nearly the
 * same words, with only the lower one ever sent, made the prompt look like a draft.
 *
 * So the caption *replaces* the prompt, in place, and the row above is the only text on
 * the screen: {@link ModelPanelProps.onPrompt} writes it back the moment a model has
 * written one, whether that was `Rewrite` or the automatic pass on the way into a render.
 * What is on screen is exactly what was sent, it stays editable, and it is written once
 * per prompt — tuning the length or the seed does not spend another call.
 *
 * ## Why the prompt row can drive this panel
 *
 * The row above the tabs is one control over three modes, and the sentence in it is the
 * same sentence either engine is asked. Pressing it on this tab has exactly one sensible
 * meaning — render *this* prompt with the model — so {@link ModelPanelProps.controls}
 * hands the run and the abort upward and {@link ModelPanelProps.onBusy} reports what is
 * in flight, and the button up there stops being about the recipe while this tab is open.
 * A ref rather than lifted state: the render owns a child process, a log and an
 * `AbortController`, and moving all of that into the screen to expose one verb would put
 * the subprocess's lifetime a long way from the panel that shows it.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react';
import { Bars } from './Bars.js';
import { FormatMenu } from './FormatMenu.js';
import { IconDownload, IconPause, IconPlay } from './Icons.js';
import { bars, ghostBars } from '../lib/layers.js';
import { ms, size } from '../lib/format.js';
import { useI18n } from '../lib/i18n.js';
import { playBuffer, type Playback } from '../lib/engine.js';
import {
  devEndpointPossible,
  modelStatus,
  provisionModel,
  renderTarget,
  type ModelStatus,
  type RenderEvent,
} from '../lib/stable-audio.js';
import { AUDIO_FORMATS, type Format } from '../lib/download.js';

/** Bars across the model's waveform. */
const BAR_COUNT = 96;

/** How many lines of the child's output to keep on screen. */
const LOG_LINES = 400;

/**
 * What each stage is, in one sentence.
 *
 * A table rather than an interpolated key, so a stage the daemon invents and this
 * build has never heard of falls back to a sentence instead of rendering its own key
 * name at the reader.
 */
const STAGE_KEY = {
  unavailable: 'model.stage.unavailable',
  'needs-python': 'model.stage.needsPython',
  'needs-venv': 'model.stage.needsVenv',
  'needs-weights': 'model.stage.needsWeights',
  ready: 'model.stage.ready',
} as const;

/**
 * Render length to tell the captioning model about when the far end has not said.
 *
 * The real default is `status.defaults.seconds`, reported by the bridge, and the render
 * form does not exist until there is a status to read it from. This covers the one path
 * that reaches `run` without one — the prompt row holds this panel's controls whichever
 * screen the panel is showing — where the caption is written before the render fails for
 * want of a daemon. It matches the bridge's own default so the two never disagree in a
 * log line.
 */
const FALLBACK_SECONDS = 2;

/**
 * Ask a model for an English caption describing the prompt.
 *
 * Handed in rather than built here so this component knows nothing about API keys,
 * pickers or the bridge — the same division that keeps the render itself behind
 * `lib/stable-audio.ts`. `null` when nothing on the page can write one; the panel then
 * says so and sends whatever is in the field.
 */
export type CaptionWriter = (input: {
  readonly prompt: string;
  readonly seconds: number;
  readonly signal: AbortSignal;
}) => Promise<{ readonly text: string; readonly source: 'model' | 'prompt'; readonly note?: string }>;

export interface ModelPanelProps {
  readonly prompt: string;
  /**
   * Where a caption goes once a model has written one: back into the prompt.
   *
   * The panel has no text field of its own any more — see the header — so this is the
   * only way what was sent can be read afterwards, and the only way it stays editable.
   */
  readonly onPrompt: (next: string) => void;
  /** The last model render, decoded — the same object Compare uses as B. */
  readonly render: { readonly name: string; readonly buffer: AudioBuffer } | null;
  readonly onRendered: (file: File) => void;
  readonly onCompare: () => void;
  /**
   * This tab's own remembered format, not the recipe's.
   *
   * Audio only, and separate from the Download button on the Sound tab: what comes out of
   * here is a render with no recipe behind it, so `js` and `soundline` would export the
   * editor's current recipe under the model's file name. `lib/download.ts` argues it out.
   */
  readonly formatId: string;
  readonly onFormat: (id: string) => void;
  readonly onDownload: (format: Format) => Promise<unknown> | void;
  readonly seed: number;
  /**
   * Draw a new session seed.
   *
   * Beside the length rather than in the bar at the bottom of the page, because on this
   * screen the seed is one of the two knobs there are: the same caption at a different
   * seed is the model's other answer, and that is the whole reason to press Render twice.
   */
  readonly onReseed: () => void;
  /**
   * How the prompt becomes something t5-base can read. Null when no model can.
   *
   * Which provider that is belongs to the prompt row's picker, not to this panel —
   * see `lib/agent.ts`'s `captionProviderFor`.
   */
  readonly writeCaption: CaptionWriter | null;
  /** Told when an install finishes, so the rest of the app stops saying "missing". */
  readonly onReady?: (ready: boolean) => void;
  /** Filled with the verbs the prompt row needs while this tab is the one showing. */
  readonly controls?: RefObject<ModelControls | null>;
  /** True while a render or an install is in flight, including through an unmount. */
  readonly onBusy?: (busy: boolean) => void;
  /** True while a caption is being written — the row's Rewrite button spins on it. */
  readonly onCaptioning?: (writing: boolean) => void;
}

/** What this panel lets the screen above it do. */
export interface ModelControls {
  /** Render the current prompt. Says so in the panel if there is no prompt yet. */
  readonly run: () => void;
  /** Abort whatever is in flight — a render or an install. */
  readonly stop: () => void;
  /** Rewrite the prompt into a caption the model can read, without spending a render. */
  readonly rewrite: () => void;
}

export function ModelPanel({
  prompt,
  onPrompt,
  render,
  onRendered,
  onCompare,
  formatId,
  onFormat,
  onDownload,
  seed,
  onReseed,
  writeCaption,
  onReady,
  controls,
  onBusy,
  onCaptioning,
}: ModelPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [asked, setAsked] = useState(false);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [running, setRunning] = useState<'render' | 'provision' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState<number | null>(null);
  /* The last text a model wrote as a caption. It is what makes this one call per prompt
     rather than one per render: with the caption written back into the prompt, a prompt
     that *is* that string has already been captioned, and changing the length or the seed
     does not make it stale. An edit by hand moves the prompt off it and captioning
     resumes — which is the right answer, since a hand-edited line is a new sentence. */
  const [captioned, setCaptioned] = useState('');
  const [captioning, setCaptioning] = useState(false);
  /* Both live in component state and nowhere else. The token is a credential and
     `lib/keystore.ts` sets the rule; the repo id is not, but it belongs to the same
     form and is one field to retype. */
  const [token, setToken] = useState('');
  const [repo, setRepo] = useState('');

  const abort = useRef<AbortController | null>(null);
  const playback = useRef<Playback | null>(null);
  const log = useRef<HTMLPreElement | null>(null);

  /**
   * Ask again, about whichever repo is in the field.
   *
   * The repo matters to the *question*, not only to the install: a community mirror
   * lives in its own cache directory and is not behind the licence click, so somebody
   * who already has one would otherwise be told they have nothing.
   */
  const refresh = useCallback(
    async (which = repo): Promise<ModelStatus | null> => {
      const next = await modelStatus(which.trim() === '' ? {} : { repo: which.trim() });
      setStatus(next);
      setAsked(true);
      onReady?.(next?.ready === true);
      return next;
    },
    [repo, onReady],
  );

  useEffect(() => {
    let cancelled = false;
    void modelStatus().then((next) => {
      if (cancelled) return;
      setStatus(next);
      setAsked(true);
      onReady?.(next?.ready === true);
      if (next !== null) setSeconds((current) => current ?? next.defaults.seconds);
    });
    return () => {
      cancelled = true;
    };
  }, [onReady]);

  useEffect(
    () => () => {
      playback.current?.stop();
      abort.current?.abort();
    },
    [],
  );

  /* A log nobody is scrolling should show its newest line — that is where the answer
     to "is this stuck?" is. A log somebody *is* scrolling must not be yanked back. */
  useEffect(() => {
    const element = log.current;
    if (element === null) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    if (atBottom) element.scrollTop = element.scrollHeight;
  }, [lines]);

  const onEvent = useCallback((event: RenderEvent) => {
    if (event.type === 'log') setLines((current) => [...current.slice(-LOG_LINES), event.line]);
    if (event.type === 'start') setLines((current) => [...current, `$ ${event.argv.join(' ')}`]);
    if (event.type === 'error') setError(event.message);
  }, []);

  const install = useCallback(() => {
    const controller = new AbortController();
    abort.current = controller;
    setRunning('provision');
    setError(null);
    setLines([]);

    void provisionModel(
      { ...(repo.trim() === '' ? {} : { repo: repo.trim() }), ...(token.trim() === '' ? {} : { token: token.trim() }) },
      { signal: controller.signal, onEvent },
    )
      .then((next) => {
        setStatus(next);
        onReady?.(next?.ready === true);
        setSeconds((current) => current ?? next.defaults.seconds);
        /* The token did its job in that one request and is not needed again — the
           weights are on the disk now, and keeping it in a form field for the rest of
           the session is a credential lying around for no reason. */
        setToken('');
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        void refresh();
      })
      .finally(() => {
        if (abort.current === controller) abort.current = null;
        setRunning(null);
      });
  }, [repo, token, onEvent, onReady, refresh]);

  /**
   * Get the caption this render should use, asking a model when there is one to ask.
   *
   * Returns the text rather than relying on the state it also sets: neither `onPrompt`
   * nor `setCaptioned` will have landed by the time the render needs the string, and
   * reading the stale value would send the previous prompt.
   */
  const captionFrom = useCallback(
    async (text: string, length: number, signal: AbortSignal, force = false): Promise<string> => {
      if (writeCaption === null || (captioned === text && !force)) return text;

      setCaptioning(true);
      try {
        const written = await writeCaption({ prompt: text, seconds: length, signal });
        if (signal.aborted) return written.text;
        /* Only a caption a model actually wrote replaces the prompt. A failed call leaves
           the text alone on purpose: the next Render retries rather than settling for the
           untranslated prompt for the rest of the session — and overwriting somebody's
           sentence with a fallback copy of itself would be a change that changed nothing
           while looking like it had. */
        if (written.source === 'model') {
          onPrompt(written.text);
          setCaptioned(written.text);
        }
        setLines((lines) => [
          ...lines,
          written.source === 'model'
            ? `✎ ${written.text}`
            : `✎ ${t('model.captionFailed', { reason: written.note ?? '' })}`,
        ]);
        return written.text;
      } finally {
        setCaptioning(false);
      }
    },
    [captioned, writeCaption, onPrompt, t],
  );

  const run = useCallback(() => {
    if (prompt.trim() === '') {
      setError(t('model.promptFirst'));
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setRunning('render');
    setError(null);
    setLines([]);

    /* Captioning and rendering are one run and share one abort: Stop pressed during the
       model call must not be followed, twenty seconds later, by a subprocess nobody is
       waiting for any more. */
    void captionFrom(prompt.trim(), seconds ?? status?.defaults.seconds ?? FALLBACK_SECONDS, controller.signal)
      .then((text) => {
        /* Thrown rather than returned, to skip the render without a second nullable step
           in the chain. Never shown: the `catch` below returns first on an abort. */
        if (controller.signal.aborted) throw new Error('aborted');
        return renderTarget(
          {
            prompt: text,
            seed,
            ...(seconds === null ? {} : { seconds }),
            ...(repo.trim() === '' ? {} : { repo: repo.trim() }),
          },
          {
            signal: controller.signal,
            onEvent: (event: RenderEvent) => {
              onEvent(event);
              if (event.type === 'done') {
                setLines((current) => [...current, `${event.name} · ${size(event.bytes)} in ${ms(event.ms)}`]);
              }
            },
          },
        );
      })
      .then((file) => {
        /* The render came down in the answer and was never written to `out/`, so
           there is nothing to fetch — a target is used once and should not leave a
           directory to sweep up. */
        onRendered(file);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (abort.current === controller) abort.current = null;
        setRunning(null);
      });
  }, [prompt, seed, seconds, repo, status, captionFrom, onEvent, onRendered, t]);

  /** Rewrite the caption on its own, without spending a render on finding out. */
  const rewrite = useCallback(() => {
    if (writeCaption === null || prompt.trim() === '' || captioning) return;
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    /* `force`, because pressing this is the user saying the caption in the field is not
       the one they want — including a perfectly fresh one. */
    void captionFrom(prompt.trim(), seconds ?? status?.defaults.seconds ?? FALLBACK_SECONDS, controller.signal, true)
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (abort.current === controller) abort.current = null;
      });
  }, [writeCaption, prompt, captioning, captionFrom, seconds, status]);

  const play = useCallback(() => {
    playback.current?.stop();
    if (render === null) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    playback.current = playBuffer(render.buffer, { loop: false });
    setPlaying(true);
    window.setTimeout(() => setPlaying(false), render.buffer.duration * 1000 + 120);
  }, [render, playing]);

  const stop = useCallback(() => abort.current?.abort(), []);

  useImperativeHandle(controls, () => ({ run, stop, rewrite }), [run, stop, rewrite]);

  /* Same contract as `onBusy`: the row above holds the Rewrite button, and a spinner
     left running by a screen that has gone away would be a control that lies. */
  useEffect(() => {
    onCaptioning?.(captioning);
    return () => onCaptioning?.(false);
  }, [captioning, onCaptioning]);

  /* The cleanup is the load-bearing half: leaving this tab aborts the render (see the
     unmount effect above), and a prompt row still offering to Stop something that is no
     longer running would be a button that does nothing. `onBusy` must be a stable
     function — `setState` is — or this fires on every render of the screen. */
  useEffect(() => {
    onBusy?.(running !== null);
    return () => onBusy?.(false);
  }, [running, onBusy]);

  const logBlock =
    lines.length === 0 && error === null ? null : (
      <>
        {error === null ? null : <div className="run-log-line bad">✗ {error}</div>}
        {lines.length === 0 ? null : (
          <pre className="model-log" ref={log}>
            {lines.join('\n')}
          </pre>
        )}
      </>
    );

  /* --- no door -------------------------------------------------------------- */

  if (status === null) {
    return (
      <div className="model">
        <p className="teach">
          {splice(t(asked ? 'model.noBridge' : 'model.looking'), {
            command: <code>npx txt2sfx-bridge</code>,
            dev: <code>pnpm dev</code>,
          })}
        </p>
        {devEndpointPossible ? null : <p className="caption">{t('model.noBridgeWhy')}</p>}
        <div className="transport">
          <button type="button" onClick={() => void refresh()}>
            {t('model.recheck')}
          </button>
        </div>
      </div>
    );
  }

  /* --- not installed -------------------------------------------------------- */

  if (!status.ready) {
    const installing = running === 'provision';
    return (
      <div className="model">
        <div className="model-setup">
          <h3 className="model-setup-title">{t('model.setupTitle')}</h3>
          <p className="teach">{t(STAGE_KEY[status.stage] ?? STAGE_KEY['needs-venv'])}</p>
          {status.reason === undefined ? null : <p className="caption warn">{status.reason}</p>}

          {status.gated && !status.hasToken ? (
            <ol className="model-steps">
              <li>
                {t('model.licenceStep')}{' '}
                <a href={status.licenceUrl} target="_blank" rel="noreferrer noopener">
                  {status.weights.repo}
                </a>
              </li>
              <li>
                {t('model.tokenStep')}{' '}
                <a href={status.tokensUrl} target="_blank" rel="noreferrer noopener">
                  huggingface.co/settings/tokens
                </a>
              </li>
              <li>{t('model.pasteStep')}</li>
            </ol>
          ) : null}

          <div className="model-fields">
            {status.gated ? (
              <label className="field wide">
                {t('model.token')}
                <input
                  type="password"
                  name="hf-token"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={status.hasToken ? t('model.tokenFound', { source: status.tokenSource ?? '' }) : 'hf_…'}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  disabled={installing}
                />
              </label>
            ) : null}
            <label className="field wide">
              {t('model.repo')}
              <input
                type="text"
                name="hf-repo"
                autoComplete="off"
                spellCheck={false}
                placeholder={status.defaults.repo}
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                /* On blur rather than on every keystroke: each check walks a cache
                   directory, and half a repo id names nothing. */
                onBlur={(event) => void refresh(event.target.value)}
                disabled={installing}
              />
            </label>
            <p className="caption">{t('model.repoHint')}</p>
          </div>

          <Facts status={status} />

          <div className="transport">
            {installing ? (
              <button type="button" onClick={stop}>
                <span className="spinner" aria-hidden="true" />
                {t('model.stop')}
              </button>
            ) : (
              <button
                type="button"
                className="amber-button big"
                onClick={install}
                disabled={status.stage === 'unavailable' || status.busy}
              >
                <IconDownload size={12} /> {t('model.install')}
              </button>
            )}
            <div className="spacer" />
            <button type="button" onClick={() => void refresh()} disabled={installing}>
              {t('model.recheck')}
            </button>
          </div>

          <p className="caption">{t('model.installCaption')}</p>
        </div>
        {logBlock}
      </div>
    );
  }

  /* --- ready ---------------------------------------------------------------- */

  const values = render === null ? ghostBars('model', BAR_COUNT) : bars(render.buffer, BAR_COUNT);
  const rendering = running === 'render';

  return (
    <div className="model">
      <div className="model-controls mono">
        <span className="chip chip-amber selected">{status.weights.repo}</span>
        <span className="amber">· {render === null ? t('model.nothing') : ms(render.buffer.duration * 1000)}</span>
        <label className="field tight">
          {t('model.seconds')}
          <input
            type="number"
            name="model-seconds"
            /* The bounds the bridge enforces, not a rounder pair: it refuses anything
               outside 0.25–11, and an input that offered 12 answered a typed 12 with a
               rejection from the far end. 11 s is the model's window (`sample_size /
               sample_rate`), and quarter-second steps are what a one-shot needs. */
            min={0.25}
            max={11}
            step={0.25}
            value={seconds ?? status.defaults.seconds}
            onChange={(event) =>
              setSeconds(Math.max(0.25, Math.min(11, event.target.valueAsNumber || status.defaults.seconds)))
            }
          />
        </label>
        {/* The seed, and the draw. Next to the length because the two of them are the
            whole control surface of a diffusion render — everything else about it was
            decided by the sentence in the row above. */}
        <span className="faint">{t('model.seed', { value: seed })}</span>
        <button type="button" title={t('app.rndTitle')} onClick={onReseed} disabled={rendering}>
          {t('app.rnd')}
        </button>
      </div>

      {/* The waveform, and what covers it while a new one is being made.
          The log below says *what* the subprocess is doing and stays readable; this says
          that the picture underneath is the previous render and not the one being waited
          for. Without it the only thing that changes for thirty seconds is a button in a
          different part of the screen, and the stale bars read as the answer. */}
      <div className="model-wave">
        <Bars
          values={values}
          muted={render === null}
          playing={playing}
          durationMs={(render?.buffer.duration ?? 0) * 1000}
          className="bars-master"
          color="oklch(0.80 0.12 80)"
        />
        {/* Only while a render is in flight. A `Rewrite` pressed on its own makes no new
            audio, and covering the last one to say so would report the wrong thing —
            that press has its own spinner, in the button that was pressed. */}
        {rendering ? (
          <div className="model-busy mono" role="status">
            <span className="spinner" aria-hidden="true" />
            {t(captioning ? 'model.captionWriting' : 'model.generating')}
          </div>
        ) : null}
      </div>

      {/* No Render button: the row above this panel is the one that runs it, on every
          screen, and a second copy down here asked the same question twice — with a
          different verb, which is worse. Stop lives there too, for the same reason.
          Download is anchored to the right edge because it is the one control that ends
          the session rather than continuing it. */}
      <div className="transport">
        <button type="button" className="amber-button big" onClick={play} disabled={render === null}>
          {playing ? <IconPause size={12} /> : <IconPlay size={12} />} {t('model.play')}
        </button>
        <button type="button" className="big" onClick={onCompare} disabled={render === null}>
          {t('model.compare')}
        </button>
        <div className="spacer" />
        <FormatMenu
          formatId={formatId}
          onFormat={onFormat}
          onDownload={onDownload}
          disabled={render === null}
          className="amber"
          formats={AUDIO_FORMATS}
          /* So the button says what the file will weigh before it is asked for one: a
             WAV of this render is six times the MP3 beside it in the list. */
          buffer={render?.buffer ?? null}
        />
      </div>

      <p className="caption">{t('model.caption')}</p>

      {logBlock}

      <Facts status={status} />
    </div>
  );
}

/**
 * Where the gigabytes went.
 *
 * Shown in both states and not folded away, because an install that quietly occupies
 * six gigabytes of somebody's disk is a thing they find out when the disk is full, and
 * the tab that started it is the honest place to say where. The venv is listed next to
 * the weights for the same reason: the checkpoint is the famous 1.7 GB, and the CUDA
 * torch build beside it is twice that and nobody warns you about it.
 */
function Facts({ status }: { readonly status: ModelStatus }): React.JSX.Element {
  const { t } = useI18n();
  const rows: readonly (readonly [string, string, string | null])[] = [
    [
      t('model.factWeights'),
      status.weights.present ? size(status.weights.bytes) : t('model.notDownloaded'),
      status.weights.dir,
    ],
    [
      t('model.factEnv'),
      status.venv.present
        ? `${size(status.venv.bytes)}${status.venv.torch === null || status.venv.torch === '' ? '' : ` · torch/${status.venv.torch}`}`
        : t('model.notInstalled'),
      status.venv.path,
    ],
    [
      t('model.factVia'),
      status.transport === 'bridge' ? t('model.viaBridge') : t('model.viaDev'),
      status.launcher,
    ],
  ];

  return (
    <dl className="model-facts mono">
      {rows.map(([label, value, detail]) => (
        <div className="model-fact" key={label}>
          <dt className="faint">{label}</dt>
          <dd>
            <span className="amber">{value}</span>
            {detail === null || detail === '' ? null : <span className="model-path">{detail}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Substitute `{name}` placeholders with React elements rather than with strings.
 *
 * `t()` cannot do this — its return type is a string, and a string cannot carry a `<code>`
 * tag. The sentences that need it are the ones that name a command the reader has to type,
 * where losing the monospace would make `npx txt2sfx-bridge` read as English prose.
 */
function splice(
  template: string,
  parts: Readonly<Record<string, React.JSX.Element>>,
): readonly React.ReactNode[] {
  return template.split(/(\{\w+\})/g).map((piece, index) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    const element = name === undefined ? undefined : parts[name];
    return <span key={`${String(index)}-${piece}`}>{element ?? piece}</span>;
  });
}
