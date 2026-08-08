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
 * That is also the argument that makes an install button acceptable here at all.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bars } from './Bars.js';
import { FormatMenu } from './FormatMenu.js';
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
import type { Format } from '../lib/download.js';

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

export interface ModelPanelProps {
  readonly prompt: string;
  /** The last model render, decoded — the same object Compare uses as B. */
  readonly render: { readonly name: string; readonly buffer: AudioBuffer } | null;
  readonly onRendered: (file: File) => void;
  readonly onCompare: () => void;
  readonly formatId: string;
  readonly onFormat: (id: string) => void;
  readonly onDownload: (format: Format) => Promise<unknown> | void;
  readonly seed: number;
  /** Told when an install finishes, so the rest of the app stops saying "missing". */
  readonly onReady?: (ready: boolean) => void;
}

export function ModelPanel({
  prompt,
  render,
  onRendered,
  onCompare,
  formatId,
  onFormat,
  onDownload,
  seed,
  onReady,
}: ModelPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [asked, setAsked] = useState(false);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [running, setRunning] = useState<'render' | 'provision' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState<number | null>(null);
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

    void renderTarget(
      {
        prompt,
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
    )
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
  }, [prompt, seed, seconds, repo, onEvent, onRendered, t]);

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
                ■ {t('model.stop')}
              </button>
            ) : (
              <button
                type="button"
                className="amber-button big"
                onClick={install}
                disabled={status.stage === 'unavailable' || status.busy}
              >
                ⤓ {t('model.install')}
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
            min={1}
            max={12}
            value={seconds ?? status.defaults.seconds}
            onChange={(event) => setSeconds(Math.max(1, Math.min(12, event.target.valueAsNumber || 1)))}
          />
        </label>
        <span className="faint">{t('model.seed', { value: seed })}</span>
      </div>

      <div className="model-wave">
        <Bars
          values={values}
          muted={render === null}
          playing={playing}
          durationMs={(render?.buffer.duration ?? 0) * 1000}
          className="bars-master"
          color="oklch(0.80 0.12 80)"
        />
      </div>

      <div className="transport">
        <button type="button" className="amber-button big" onClick={play} disabled={render === null}>
          {playing ? '❚❚' : '▶'} {t('model.play')}
        </button>
        {rendering ? (
          <button type="button" onClick={stop}>
            ■ {t('model.stop')}
          </button>
        ) : (
          <button type="button" onClick={run} disabled={status.busy}>
            ⤓ {t('model.render')}
          </button>
        )}
        <FormatMenu
          formatId={formatId}
          onFormat={onFormat}
          onDownload={onDownload}
          disabled={render === null}
          className="amber"
        />
        <div className="spacer" />
        <button type="button" onClick={onCompare} disabled={render === null}>
          {t('model.compare')}
        </button>
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
