/**
 * The same prompt, rendered by a diffusion model, loaded as the reference.
 *
 * This is the A/B harness in `test/stable-audio/` with a button on it. The point
 * is not to ship what the model produces — it is a few hundred KB of MP3 and the
 * project's whole claim is a few hundred bytes of Web Audio — but to have something
 * to be judged against. Once the render lands in the reference slot the existing
 * panels take over: A/B playback and the spectrogram diff in Compare, `match
 * reference` on a generate run, and `⌖ Fit to reference` on the sliders.
 *
 * The render arrives in the response and is never written down: a target is used
 * once, and a session of clicking this button should not leave a directory of files
 * to sweep up. The dropdown is for renders a terminal `run.py` kept on purpose.
 *
 * ## Why the panel is loud about time
 *
 * A render is tens of seconds of CPU, and the first one ever is minutes plus a
 * licence gate. So the child's own lines are shown as they arrive rather than
 * hidden behind a spinner, and the renders a terminal run left on disk are one
 * click away — re-rendering a prompt you rendered yesterday is pure waste.
 *
 * Present only under `vite dev`: there is no endpoint in a static build, and the
 * panel removes itself rather than offering a button that cannot work.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchRender,
  renderTarget,
  stableAudioStatus,
  type RenderFile,
  type StableAudioStatus,
} from '../lib/stable-audio.js';

export interface StableAudioProps {
  /** The prompt the playground is working on — shared with the prompt bar. */
  readonly prompt: string;
  /** Hand a finished render to the reference slot. */
  readonly onRendered: (file: File) => void;
}

/**
 * Default render length, in seconds.
 *
 * Not the model's own 11 s. The model always *samples* its full window, but the
 * decode is linear in length and is the expensive half, so a shorter render is
 * strictly cheaper — and the sounds this project makes are impacts and clicks, so
 * eight seconds of room tone is not what is being compared. Raise it for a prompt
 * that genuinely runs long.
 */
const DEFAULT_SECONDS = 3;

/** How much of the child's output to keep on screen. */
const LOG_LINES = 8;

/**
 * Where the chosen checkpoint is remembered.
 *
 * The default repo is gated and its byte-identical mirrors are not, so which one a
 * machine can actually render from is a property of that machine's Hugging Face
 * cache. Not a secret, and not worth retyping every session — unlike an API key,
 * which this project deliberately does not keep anywhere by default.
 */
const REPO_KEY = 'txt2sfx.stable-audio.repo';

export function StableAudio({ prompt, onRendered }: StableAudioProps): React.JSX.Element | null {
  const [status, setStatus] = useState<StableAudioStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [seconds, setSeconds] = useState(String(DEFAULT_SECONDS));
  const [seed, setSeed] = useState('');
  const [repo, setRepo] = useState(() => window.localStorage.getItem(REPO_KEY) ?? '');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState('');

  const abort = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<StableAudioStatus | null> => {
    const next = await stableAudioStatus();
    setStatus(next);
    setChecked(true);
    /* Show which checkpoint would be used rather than an empty box: "default" is
       not an answer when the default is the one that needs a licence. */
    if (next !== null) setRepo((current) => (current === '' ? next.defaults.repo : current));
    return next;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => () => abort.current?.abort(), []);

  /** Fetch a render and hand it over as the reference. */
  const load = useCallback(
    (file: string) => {
      setError(null);
      void fetchRender(file)
        .then(onRendered)
        .catch((failure: unknown) => setError(String(failure)));
    },
    [onRendered],
  );

  const run = useCallback(() => {
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setLog([]);
    setError(null);

    const number = (text: string): number | undefined => {
      const value = Number(text.trim());
      return text.trim() === '' || !Number.isFinite(value) ? undefined : value;
    };

    void renderTarget(
      {
        prompt: prompt.trim(),
        seconds: number(seconds),
        seed: number(seed),
        repo: repo.trim() === '' ? undefined : repo.trim(),
      },
      {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'log') {
            setLog((lines) => [...lines, event.line].slice(-LOG_LINES));
          } else if (event.type === 'start') {
            setLog((lines) => [...lines, `run.py ${event.argv.join(' ')}`].slice(-LOG_LINES));
          } else if (event.type === 'done') {
            const kb = (event.bytes / 1024).toFixed(0);
            setLog((lines) =>
              [...lines, `${event.name} · ${kb} KB in ${(event.ms / 1000).toFixed(1)}s`].slice(-LOG_LINES),
            );
          }
        },
      },
    )
      .then((file) => {
        if (controller.signal.aborted) return;
        /* Nothing was written to `out/`, so the dropdown has nothing to point at —
           leaving a stale selection there would claim otherwise. */
        setPicked('');
        /* Loading it is the point of having asked. */
        setError(null);
        onRendered(file);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (abort.current === controller) abort.current = null;
        setRunning(false);
      });
  }, [onRendered, prompt, repo, seconds, seed]);

  const cancel = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setRunning(false);
    setLog((lines) => [...lines, '● cancelled'].slice(-LOG_LINES));
  }, []);

  /* No endpoint means a static build (or the plugin taken out): say nothing. */
  if (!checked || status === null) return null;

  const renders: readonly RenderFile[] = status.renders;
  const blocked = prompt.trim() === '' || !status.ready;

  return (
    <div className="sa">
      <div className="sa-bar">
        {running ? (
          <button type="button" onClick={cancel}>
            ■ Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={run}
            disabled={blocked}
            title={
              status.ready
                ? 'render the prompt above with Stable Audio Open Small and load it as the reference'
                : status.reason
            }
          >
            ⤓ Render target
          </button>
        )}

        <label className="sa-field">
          seconds
          <input
            type="text"
            name="sa-seconds"
            value={seconds}
            aria-label="render length in seconds"
            title="the model always samples its full 11 s window — this trims the decode, which is the expensive half"
            onChange={(event) => setSeconds(event.target.value)}
          />
        </label>
        <label className="sa-field">
          seed
          <input
            type="text"
            name="sa-seed"
            value={seed}
            placeholder="random"
            aria-label="diffusion seed"
            onChange={(event) => setSeed(event.target.value)}
          />
        </label>

        <label className="sa-field sa-repo">
          repo
          <input
            type="text"
            name="sa-repo"
            value={repo}
            placeholder={status.defaults.repo}
            aria-label="Hugging Face repo id"
            title="the checkpoint to render with — a mirror of the gated default renders the same audio"
            onChange={(event) => {
              setRepo(event.target.value);
              window.localStorage.setItem(REPO_KEY, event.target.value);
            }}
          />
        </label>

        <span className="compare-sep" />

        <select
          name="sa-render"
          value={picked}
          aria-label="renders left in out/ by a terminal run"
          title="renders a terminal run.py left in out/ — a render started here is streamed and not saved"
          disabled={renders.length === 0}
          onChange={(event) => {
            setPicked(event.target.value);
            if (event.target.value !== '') load(event.target.value);
          }}
        >
          <option value="">
            {renders.length === 0 ? 'no renders yet' : `${String(renders.length)} render(s) on disk…`}
          </option>
          {renders.map((entry) => (
            <option key={entry.file} value={entry.file}>
              {entry.file}
            </option>
          ))}
        </select>
      </div>

      <div className="sa-note">
        {!status.ready
          ? status.reason
          : prompt.trim() === ''
            ? 'type a prompt above — the same text goes to both engines, which is the whole point of the comparison'
            : 'runs test/stable-audio/run.py on this machine · ~10–60 s on CPU · the render is streamed straight into the reference below, not saved'}
      </div>
      {/* The failure this saves you from is seven seconds long and says nothing
          about your prompt: the default checkpoint is gated, and the token has to
          be in the dev server's environment, not in the terminal where run.py was
          first used. */}
      {status.ready && !status.hasToken && repo.trim() === status.defaults.repo ? (
        <div className="sa-note sa-warn">
          no HF_TOKEN in the dev server’s environment — {status.defaults.repo} is gated. Export it
          before <code>pnpm dev</code>, or point <code>repo</code> at a mirror already in this
          machine’s Hugging Face cache.
        </div>
      ) : null}

      {log.length === 0 && error === null ? null : (
        <div className="prompt-log sa-log">
          {log.map((line, index) => (
            <div className="prompt-log-line" key={`${String(index)}-${line}`}>
              {line}
            </div>
          ))}
          {error === null ? null : <div className="prompt-log-line bad">✗ {error}</div>}
        </div>
      )}
    </div>
  );
}
