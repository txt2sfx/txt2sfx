/**
 * The other kind of answer: audio a diffusion model made from the same prompt.
 *
 * ## Why a competitor is in the building
 *
 * Because the honest comparison is the useful one, and because this is not actually a
 * competitor — it is a **target**. Stable Audio returns one to two megabytes of WAV for
 * a sound this project ships as eight hundred bytes of JavaScript, so as a deliverable
 * the two are not in the same category. As a *reference* it is the single most valuable
 * thing on the machine: finding a recording of "a rusty gate opening slowly, then a
 * heavy latch" by hand is the slow step in every session, and here it is one click and
 * thirty seconds of CPU.
 *
 * The view therefore says out loud what it is: rendered audio from the same prompt, no
 * recipe, nothing to tune, nothing to export into a game. Everything it produces flows
 * into the same place a dropped file does — the B side of Compare — and from there the
 * existing machinery applies unchanged.
 *
 * ## Why the model list is one item long
 *
 * The design showed three. Three would require either three provisioned local models or
 * three hosted API keys, and offering a picker whose other entries error on click is
 * worse than a picker with one entry. What is here is what is actually runnable: the
 * local Stable Audio Open Small, behind the one-time provisioning in
 * `test/stable-audio/README.md`, and a plain statement of the fact when it is absent.
 *
 * ## Why the log is the progress bar
 *
 * A first render downloads a multi-gigabyte checkpoint and can take minutes; a warm one
 * takes thirty seconds. The child process says which is happening — "loaded in 10.1s on
 * cpu", "sampled in 8.1s, decoding 3s" — and a spinner in place of those lines would
 * hide the download, the licence gate and every other reason a run is slow.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bars } from './Bars.js';
import { FormatMenu } from './FormatMenu.js';
import { bars, ghostBars } from '../lib/layers.js';
import { ms } from '../lib/format.js';
import { playBuffer, type Playback } from '../lib/engine.js';
import {
  fetchRender,
  renderTarget,
  stableAudioStatus,
  stableAudioSupported,
  type RenderEvent,
  type StableAudioStatus,
} from '../lib/stable-audio.js';
import type { Format } from '../lib/download.js';

/** Bars across the model's waveform. */
const BAR_COUNT = 96;

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
}: ModelPanelProps): React.JSX.Element {
  const [status, setStatus] = useState<StableAudioStatus | null>(null);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState<number | null>(null);

  const abort = useRef<AbortController | null>(null);
  const playback = useRef<Playback | null>(null);

  useEffect(() => {
    let cancelled = false;
    void stableAudioStatus().then((next) => {
      if (cancelled) return;
      setStatus(next);
      if (next !== null && seconds === null) setSeconds(next.defaults.seconds);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      playback.current?.stop();
      abort.current?.abort();
    },
    [],
  );

  const run = useCallback(() => {
    if (prompt.trim() === '') {
      setError('type a prompt first — the model answers the same sentence our loop does');
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setError(null);
    setLines([]);

    void renderTarget(
      {
        prompt,
        seed,
        ...(seconds === null ? {} : { seconds }),
        ...(status?.hasToken === false && status.defaults.repo !== '' ? { repo: status.defaults.repo } : {}),
      },
      {
        signal: controller.signal,
        onEvent: (event: RenderEvent) => {
          if (event.type === 'log') setLines((current) => [...current.slice(-40), event.line]);
          if (event.type === 'start') setLines((current) => [...current, `$ ${event.argv.join(' ')}`]);
          if (event.type === 'done') setLines((current) => [...current, `done in ${ms(event.ms)}`]);
          if (event.type === 'error') setError(event.message);
        },
      },
    )
      .then(async (file) => {
        onRendered(await fetchRender(file));
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (abort.current === controller) abort.current = null;
        setRunning(false);
      });
  }, [prompt, seed, seconds, status, onRendered]);

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

  if (!stableAudioSupported) {
    return (
      <p className="teach">
        This view drives a diffusion model running on this machine, which only exists under{' '}
        <code>pnpm dev</code>. A static build has no process to talk to.
      </p>
    );
  }

  if (status === null) {
    return (
      <p className="teach">
        No local model endpoint. Under <code>pnpm dev</code> this view renders a reference from the same prompt with
        Stable Audio Open Small — see <code>test/stable-audio/README.md</code> for the one-time provisioning.
      </p>
    );
  }

  const values = render === null ? ghostBars('model', BAR_COUNT) : bars(render.buffer, BAR_COUNT);

  return (
    <div className="model">
      <div className="model-controls mono">
        <span className="chip chip-amber selected">stable-audio-open-small</span>
        <span className="amber">· {render === null ? 'nothing rendered' : ms(render.buffer.duration * 1000)}</span>
        <label className="field tight">
          seconds
          <input
            type="number"
            name="model-seconds"
            min={1}
            max={12}
            value={seconds ?? status.defaults.seconds}
            onChange={(event) => setSeconds(Math.max(1, Math.min(12, event.target.valueAsNumber || 1)))}
          />
        </label>
        <span className="faint">seed {seed}</span>
        {status.ready ? null : <span className="warn">{status.reason ?? 'not provisioned'}</span>}
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
          {playing ? '❚❚' : '▶'} Play
        </button>
        {running ? (
          <button type="button" onClick={() => abort.current?.abort()}>
            ■ Stop
          </button>
        ) : (
          <button type="button" onClick={run} disabled={!status.ready || status.busy}>
            ⤓ Render target
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
          Compare with the recipe
        </button>
      </div>

      <p className="caption">
        Rendered audio from the same prompt — no recipe, nothing to tune, and one to two megabytes where the recipe is
        under a kilobyte. It is here to be a <strong>target</strong>: A/B it, and tick{' '}
        <em>fit the numbers to the reference</em> to point the optimizer at it.
      </p>

      {error === null ? null : <div className="run-log-line bad">✗ {error}</div>}
      {lines.length === 0 ? null : (
        <pre className="model-log">{lines.join('\n')}</pre>
      )}
    </div>
  );
}
