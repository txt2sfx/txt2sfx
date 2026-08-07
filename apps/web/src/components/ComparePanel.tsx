/**
 * A against B: two waveforms, two spectrograms, and seven numbers.
 *
 * ## What B is allowed to be, and why there are three answers
 *
 * The old panel had one: a file you loaded. That covers the case where a real recording
 * of the thing exists, which is the minority of the work. The three sources here are the
 * three questions people actually ask:
 *
 * - **A model's render.** Send the same prompt to a diffusion model running locally and
 *   compare against what it produced. A *target*, never a competitor: the deliverable is
 *   still a recipe, and the model's output is a 400 kB file that answers "what should
 *   this sound like" and nothing else.
 * - **A file.** Your own recording, peak-normalized on load.
 * - **Another take.** The same recipe rendered with a different seed. This is the one
 *   the old panel could not express at all, and it answers a question specific to
 *   procedural audio: *how much of this sound is the design and how much is the noise
 *   seed?* A recipe whose two takes differ more than A differs from the reference is
 *   not a sound, it is a distribution.
 *
 * ## Why the caption is not decoration
 *
 * Both signals are onset-aligned and peak-normalized before anything is drawn or
 * subtracted, and that is not a detail to leave implicit. A reference recorded with
 * pre-roll starts when the recorder was rolling; a render starts at zero. Subtract them
 * as they arrive and the difference picture is a picture of the offset. Same for level:
 * a reference at 0.97 against a render at 0.79 differs by 1.8 dB everywhere, and that
 * constant swamps everything spectral. So the transformation happens, and the caption
 * says so on every screenshot that leaves here.
 *
 * ## Why the numbers carry a warning
 *
 * The metric is numeric and not perceptual. It ranks candidates; it does not judge them.
 * Peak-normalized and onset-aligned means it cannot distinguish *this sound, closer* from
 * *a different sound that happens to score well* — a broadband wash with the right
 * envelope and centroid outscores a recognizable version of what was asked for. Putting
 * that sentence beside the table is not humility, it is the operating instruction.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { spectrogram, type Spectrogram } from '../lib/fft.js';
import {
  BAND_LABELS,
  alignPair,
  metricsMarkdown,
  metricsOf,
  onsetIndex,
  signalOf,
  type Metrics,
} from '../lib/analysis.js';
import { drawWaveform, drawWaveformGuides, F_MIN, fMaxFor, type Box } from '../lib/draw.js';
import { COLOUR_MODES, MODE_LEGEND, paintMagnitude, paintSpectrogram, swatchesFor, type ColourMode } from '../lib/spectro.js';
import { copy } from '../lib/download.js';
import { delta, hz, ms } from '../lib/format.js';
import { playBuffer, type Playback } from '../lib/engine.js';

/** Where B comes from. */
export type BKind = 'model' | 'upload' | 'take';

/**
 * Spectrogram window, shared by both signals so their bins line up.
 *
 * The hop is *not* fixed, and that was a visible defect before it was: at 192 samples a
 * 105 ms pop is twenty-four frames stretched across a thousand pixels, so the plot came
 * out as two dozen forty-pixel blocks and the attack — the part of a pop worth
 * looking at — was one rectangle. The hop is chosen instead to land near
 * {@link TARGET_FRAMES} columns, clamped at both ends: a floor because a hop below a
 * handful of samples buys nothing a 1024-point window can resolve, and a ceiling because
 * a two-second cycle must not be recomputed at pixel resolution.
 *
 * Both sides are computed on the same aligned time base with the same hop, which is what
 * makes them comparable at all.
 */
const FFT_SIZE = 1024;
const TARGET_FRAMES = 640;

function specOptions(length: number): { fftSize: number; hop: number } {
  const hop = Math.round(length / TARGET_FRAMES);
  return { fftSize: FFT_SIZE, hop: Math.max(16, Math.min(256, hop || 16)) };
}

/** Difference in dB that saturates the diff ramp. */
const DIFF_RANGE_DB = 30;

const WAVE_HEIGHT = 52;
const SPEC_HEIGHT = 132;

export interface ComparePanelProps {
  readonly candidateName: string;
  readonly candidate: AudioBuffer | null;
  /** Per-layer renders of A, for the `tracks` and `hsv` colour modes. */
  readonly candidateLayers: readonly (AudioBuffer | null)[];
  readonly layerNames: readonly string[];
  readonly b: { readonly name: string; readonly buffer: AudioBuffer } | null;
  readonly bKind: BKind;
  readonly onBKind: (kind: BKind) => void;
  /** True under `vite dev` with the local diffusion model provisioned. */
  readonly modelAvailable: boolean;
  readonly onLoadFile: (file: File) => void;
  readonly onNewTake: () => void;
  readonly onFit: () => void;
  readonly fitBlocked: string | null;
  readonly maxPeak: number;
}

export function ComparePanel(props: ComparePanelProps): React.JSX.Element {
  const {
    candidateName,
    candidate,
    candidateLayers,
    layerNames,
    b,
    bKind,
    onBKind,
    modelAvailable,
    onLoadFile,
    onNewTake,
    onFit,
    fitBlocked,
    maxPeak,
  } = props;

  const [mode, setMode] = useState<ColourMode>('tracks');
  const [width, setWidth] = useState(760);
  const [note, setNote] = useState<string | null>(null);

  const host = useRef<HTMLDivElement>(null);
  const waveA = useRef<HTMLCanvasElement>(null);
  const waveB = useRef<HTMLCanvasElement>(null);
  const specA = useRef<HTMLCanvasElement>(null);
  const specB = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const playback = useRef<Playback | null>(null);
  const alternating = useRef<number | null>(null);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(Math.max(320, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* --- preparation ------------------------------------------------------- */

  const pair = useMemo(() => {
    if (candidate === null || b === null) return null;
    return alignPair(signalOf(candidate), signalOf(b.buffer), { align: true, normalize: true });
  }, [candidate, b]);

  const specs = useMemo<{ a: Spectrogram; b: Spectrogram } | null>(() => {
    if (pair === null) return null;
    const options = specOptions(pair.a.length);
    return { a: spectrogram(pair.a, pair.sampleRate, options), b: spectrogram(pair.b, pair.sampleRate, options) };
  }, [pair]);

  /**
   * Per-layer spectrograms on the *aligned* time base.
   *
   * Sliced the same way `alignPair` slices A, using A's own onset, so a layer's energy
   * lands in the same column as the master's. Computing them independently would put
   * each layer's onset at five milliseconds and the attribution would be a lie in every
   * column after the first.
   */
  const layerSpecs = useMemo<readonly (Spectrogram | null)[]>(() => {
    if (candidate === null || pair === null) return [];
    if (mode !== 'tracks' && mode !== 'hsv') return [];
    const master = signalOf(candidate);
    const onset = onsetIndex(master);
    const pre = Math.round((pair.onsetMs / 1000) * pair.sampleRate);
    const count = pair.a.length;

    return candidateLayers.map((buffer) => {
      if (buffer === null) return null;
      const samples = buffer.getChannelData(0);
      const window = new Float32Array(count);
      const from = onset - pre;
      for (let i = 0; i < count; i++) {
        const at = from + i;
        window[i] = at >= 0 && at < samples.length ? (samples[at] ?? 0) : 0;
      }
      return spectrogram(window, pair.sampleRate, specOptions(count));
    });
  }, [candidate, candidateLayers, pair, mode]);

  const metrics = useMemo<{ a: Metrics; b: Metrics } | null>(() => {
    if (candidate === null || b === null) return null;
    return { a: metricsOf(signalOf(candidate)), b: metricsOf(signalOf(b.buffer)) };
  }, [candidate, b]);

  /* --- painting ---------------------------------------------------------- */

  const paintWave = useCallback(
    (canvas: HTMLCanvasElement | null, samples: Float32Array | null, color: string) => {
      if (canvas === null) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(WAVE_HEIGHT * dpr);
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const box: Box = { x: 0, y: 0, w: canvas.width, h: canvas.height };
      drawWaveformGuides(ctx, box, maxPeak, dpr);
      if (samples !== null) drawWaveform(ctx, samples, box, color);
    },
    [width, maxPeak],
  );

  const paintSpec = useCallback(
    (canvas: HTMLCanvasElement | null, draw: (image: ImageData) => void) => {
      if (canvas === null) return;
      const dpr = window.devicePixelRatio || 1;
      /* The spectrogram is painted per pixel, so device-pixel resolution would cost four
         times the work for detail the log axis has already thrown away. One CSS pixel per
         column, scaled up by the browser. */
      canvas.width = Math.round(width);
      canvas.height = SPEC_HEIGHT;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      const image = ctx.createImageData(canvas.width, canvas.height);
      draw(image);
      ctx.putImageData(image, 0, 0);
      void dpr;
    },
    [width],
  );

  useEffect(() => {
    paintWave(waveA.current, pair?.a ?? null, 'rgb(105,214,238)');
    paintWave(waveB.current, pair?.b ?? null, 'rgb(238,190,105)');
  }, [paintWave, pair]);

  useEffect(() => {
    if (specs === null || pair === null) {
      paintSpec(specA.current, (image) => image.data.fill(0));
      paintSpec(specB.current, (image) => image.data.fill(0));
      return;
    }
    paintSpec(specA.current, (image) =>
      paintSpectrogram(image, {
        mode,
        spec: specs.a,
        sampleRate: pair.sampleRate,
        layers: layerSpecs,
        other: specs.b,
        rangeDb: DIFF_RANGE_DB,
      }),
    );
    if (mode !== 'diff') paintSpec(specB.current, (image) => paintMagnitude(image, specs.b, pair.sampleRate));
  }, [paintSpec, specs, pair, mode, layerSpecs]);

  /* --- playback ---------------------------------------------------------- */

  const stop = useCallback(() => {
    playback.current?.stop();
    playback.current = null;
    if (alternating.current !== null) {
      window.clearInterval(alternating.current);
      alternating.current = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  const playOne = useCallback(
    (buffer: AudioBuffer | null) => {
      stop();
      if (buffer === null) return;
      playback.current = playBuffer(buffer, { loop: false });
    },
    [stop],
  );

  /**
   * A, then B, then A again, on a period a little longer than the longer of the two.
   *
   * The only reliable way to hear a small spectral difference is to switch between the
   * two quickly and repeatedly; two separate Play buttons pressed by hand put a second
   * of silence and a mouse movement in between, which is long enough for the ear to
   * forget what it was comparing.
   */
  const alternate = useCallback(() => {
    if (candidate === null || b === null) return;
    stop();
    const period = Math.max(candidate.duration, b.buffer.duration) * 1000 + 220;
    let turn = 0;
    const step = (): void => {
      playback.current?.stop();
      playback.current = playBuffer(turn % 2 === 0 ? candidate : b.buffer, { loop: false });
      turn++;
    };
    step();
    alternating.current = window.setInterval(step, period);
  }, [candidate, b, stop]);

  /* --- copying ----------------------------------------------------------- */

  const say = (message: string): void => {
    setNote(message);
    window.setTimeout(() => setNote((current) => (current === message ? null : current)), 1600);
  };

  /**
   * Both plots, stacked into one image, with the labels drawn in.
   *
   * A picture that needs the surrounding interface to be interpreted is useless the
   * moment it is copied out of it — and copying it out is the point, whether the reader
   * is a colleague or a vision model. So the composite carries the two names, the colour
   * mode, its legend and the alignment note.
   */
  const copyImage = useCallback(async (): Promise<void> => {
    const a = specA.current;
    const wa = waveA.current;
    if (a === null || wa === null || pair === null) return;
    const wb = waveB.current;
    const sb = mode === 'diff' ? null : specB.current;

    const pad = 12;
    const line = 18;
    const w = a.width + pad * 2;
    const h =
      pad + line + WAVE_HEIGHT + 6 + SPEC_HEIGHT + line + (wb === null ? 0 : WAVE_HEIGHT + 6) + (sb === null ? 0 : SPEC_HEIGHT) + line * 2 + pad;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.fillStyle = '#101418';
    ctx.fillRect(0, 0, w, h);
    ctx.font = '11px ui-monospace, monospace';

    let y = pad + 12;
    ctx.fillStyle = 'rgb(105,214,238)';
    ctx.fillText(`A · ${candidateName} · ${ms((candidate?.duration ?? 0) * 1000)}`, pad, y);
    y += 6;
    ctx.drawImage(wa, pad, y, a.width, WAVE_HEIGHT);
    y += WAVE_HEIGHT + 6;
    ctx.drawImage(a, pad, y);
    y += SPEC_HEIGHT + line;

    if (wb !== null) {
      ctx.fillStyle = 'rgb(238,190,105)';
      ctx.fillText(`B · ${b?.name ?? '—'} · ${ms((b?.buffer.duration ?? 0) * 1000)}`, pad, y);
      y += 6;
      ctx.drawImage(wb, pad, y, a.width, WAVE_HEIGHT);
      y += WAVE_HEIGHT + 6;
      if (sb !== null) {
        ctx.drawImage(sb, pad, y);
        y += SPEC_HEIGHT;
      }
      y += line;
    }

    ctx.fillStyle = 'rgba(226,232,240,0.62)';
    ctx.fillText(
      `${mode} · both onsets shifted to ${String(Math.round(pair.onsetMs))} ms · peak-normalized · log ${String(F_MIN)} Hz – ${hz(fMaxFor(pair.sampleRate))}`,
      pad,
      y,
    );
    ctx.fillText(MODE_LEGEND[mode], pad, y + line * 0.8);

    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob === null) throw new Error('the canvas produced no image');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      say('copied the picture');
    } catch {
      /* Safari and Firefox restrict image writes to the clipboard. A download is the
         same bytes by a different route, and silently failing is not an option. */
      const url = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = url;
      link.download = `${candidateName}-vs-${b?.name ?? 'b'}.png`;
      link.click();
      say('the clipboard refused an image — saved a PNG instead');
    }
  }, [candidateName, candidate, b, pair, mode]);

  /* --- rows -------------------------------------------------------------- */

  const rows = useMemo(() => {
    if (metrics === null) return [];
    const { a, b: bm } = metrics;
    return [
      row('peak', a.peak, bm.peak, '', 3, 0.15),
      row('duration to −60 dB', a.durationMs, bm.durationMs, 'ms', 0, 200),
      row('attack to peak', a.attackMs, bm.attackMs, 'ms', 0, 3),
      row('dominant partial', a.dominantHz, bm.dominantHz, 'Hz', 0, 300),
      row('centroid', a.centroidHz, bm.centroidHz, 'Hz', 0, 600),
      row('flatness', a.flatness, bm.flatness, '', 4, 0.08),
      ...BAND_LABELS.map((label, index) =>
        row(`band ${label}`, a.bandsDb[index] ?? 0, bm.bandsDb[index] ?? 0, 'dB', 1, 3),
      ),
    ];
  }, [metrics]);

  const swatches = swatchesFor(mode, layerNames);
  const bHint = {
    model: 'rendered by a diffusion model from the same prompt — a target, not a competitor',
    upload: 'your own file, onset-aligned and peak-normalized on load',
    take: 'the same recipe with a different seed — how much of this sound is the design?',
  }[bKind];

  return (
    <div className="compare" ref={host}>
      <div className="compare-controls">
        <span className="mono faint">B is a</span>
        <div className="chips">
          {(
            [
              { id: 'model', label: 'Model render' },
              { id: 'upload', label: 'File' },
              { id: 'take', label: 'Another take' },
            ] as const
          ).map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={`chip chip-amber${bKind === entry.id ? ' selected' : ''}`}
              onClick={() => {
                onBKind(entry.id);
                if (entry.id === 'upload') fileInput.current?.click();
                if (entry.id === 'take') onNewTake();
              }}
              disabled={entry.id === 'model' && !modelAvailable}
              title={
                entry.id === 'model' && !modelAvailable
                  ? 'needs the local diffusion model — see test/stable-audio/README.md'
                  : undefined
              }
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <div className="chips">
          <button type="button" className="chip chip-cyan" onClick={() => playOne(candidate)} disabled={candidate === null}>
            ▶ A
          </button>
          <button type="button" className="chip chip-amber" onClick={() => playOne(b?.buffer ?? null)} disabled={b === null}>
            ▶ B
          </button>
          <button type="button" className="chip" onClick={alternate} disabled={candidate === null || b === null}>
            ⇄ A/B
          </button>
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) onLoadFile(file);
          event.target.value = '';
        }}
      />

      <div className="compare-names mono">
        <span className="cyan">A · {candidateName}</span>
        <span className="faint">/</span>
        <span className="amber">B · {b?.name ?? 'nothing loaded'}</span>
        <span className="faint hint">{bHint}</span>
      </div>

      <div className="compare-colour">
        <span className="mono faint tiny">COLOUR</span>
        <div className="chips">
          {COLOUR_MODES.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={`chip${mode === entry.id ? ' selected' : ''}`}
              onClick={() => setMode(entry.id)}
              disabled={entry.id === 'diff' && b === null}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <div className="swatches">
          {swatches.map((swatch) => (
            <span className="swatch" key={swatch.label}>
              <i style={{ background: swatch.color }} />
              <span className="mono tiny faint">{swatch.label}</span>
            </span>
          ))}
        </div>
      </div>

      {b === null ? (
        <div
          className="dropzone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file !== undefined) {
              onBKind('upload');
              onLoadFile(file);
            }
          }}
        >
          <p>
            Nothing to compare against yet. Drop an audio file here, pick <strong>Another take</strong> to render this
            recipe with a new seed, or {modelAvailable ? 'let the local model render a target' : 'provision the local model'}.
          </p>
        </div>
      ) : (
        <div className="plots">
          {/* The duration each side is *audible* for, down to −60 dB. Not the buffer
              length, which carries the analyzer's trailing pad and would report every
              recipe as 50 ms longer than it is. */}
          <div className="mono plot-label cyan">
            candidate · {ms(metrics?.a.durationMs ?? 0)}
          </div>
          <div className="plot-row">
            <div className="axis" />
            <canvas ref={waveA} style={{ height: `${String(WAVE_HEIGHT)}px` }} />
          </div>
          <div className="plot-row">
            <div className="axis mono">
              <span>10k</span>
              <span>1k</span>
              <span>100</span>
            </div>
            <div className="plot-spec">
              <canvas ref={specA} style={{ height: `${String(SPEC_HEIGHT)}px` }} />
              {mode === 'diff' ? <span className="badge mono">A − B</span> : null}
            </div>
          </div>

          <div className="mono plot-label amber">
            B · {b.name} · {ms(metrics?.b.durationMs ?? 0)}
          </div>
          <div className="plot-row">
            <div className="axis" />
            <canvas ref={waveB} style={{ height: `${String(WAVE_HEIGHT)}px` }} />
          </div>
          {mode === 'diff' ? null : (
            <div className="plot-row">
              <div className="axis mono">
                <span>10k</span>
                <span>1k</span>
                <span>100</span>
              </div>
              <div className="plot-spec">
                <canvas ref={specB} style={{ height: `${String(SPEC_HEIGHT)}px` }} />
              </div>
            </div>
          )}

          <p className="caption mono">
            both onsets shifted to {String(Math.round(pair?.onsetMs ?? 5))} ms · peak-normalized · log frequency{' '}
            {String(F_MIN)} Hz – {hz(fMaxFor(pair?.sampleRate ?? 44100))}
            <br />
            {MODE_LEGEND[mode]}
          </p>
        </div>
      )}

      {rows.length === 0 ? null : (
        <>
          <div className="table">
            <div className="table-head mono">
              <span>METRIC</span>
              <span>A</span>
              <span>B</span>
              <span>Δ</span>
            </div>
            {rows.map((entry) => (
              <div className="table-row mono" key={entry.key}>
                <span className="faint">{entry.key}</span>
                <span className="cyan">{entry.a}</span>
                <span className="amber">{entry.b}</span>
                <span className={entry.close ? 'good' : 'warn'}>{entry.delta}</span>
              </div>
            ))}
          </div>
          <p className="caption">
            Numeric, not perceptual — it ranks candidates, it does not judge them. Both signals are peak-normalized and
            onset-aligned, so the distance cannot tell <em>this sound, closer</em> from <em>a different sound that
            scores well</em>.
          </p>
        </>
      )}

      <div className="compare-actions">
        <button type="button" onClick={() => void copyImage()} disabled={b === null}>
          Copy picture
        </button>
        <button
          type="button"
          disabled={metrics === null}
          onClick={() =>
            metrics !== null &&
            void copy(
              metricsMarkdown(candidateName, b?.name ?? 'B', metrics.a, metrics.b),
              'the numbers as markdown',
            ).then(say)
          }
        >
          Copy numbers
        </button>
        {note === null ? null : <span className="mono faint">{note}</span>}
        <div className="spacer" />
        <button type="button" className="violet" onClick={onFit} disabled={fitBlocked !== null}>
          Fit slots to B
        </button>
      </div>
    </div>
  );
}

/** One metrics row, with the Δ and whether it counts as close. */
function row(
  key: string,
  a: number,
  b: number,
  unit: string,
  digits: number,
  tolerance: number,
): { key: string; a: string; b: string; delta: string; close: boolean } {
  const one = (value: number): string =>
    unit === 'ms' ? ms(value) : unit === 'Hz' ? hz(value) : `${value.toFixed(digits)}${unit === '' ? '' : ` ${unit}`}`;
  return {
    key,
    a: one(a),
    b: one(b),
    delta: delta(a - b, unit === 'Hz' ? 'Hz' : unit, digits),
    close: Math.abs(a - b) <= tolerance,
  };
}
