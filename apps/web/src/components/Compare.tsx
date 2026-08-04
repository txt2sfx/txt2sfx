/**
 * Candidate against reference: stacked, overlaid, or subtracted.
 *
 * The panel exists to answer one question — *what is different* — and to answer it
 * in a form that survives being handed to someone else, including a vision model.
 * So the canvas is self-describing: it carries the two names, the comparison mode,
 * whether alignment and normalization are on, and a legend when the colours are
 * signed. A picture that needs the surrounding UI to be interpreted is useless the
 * moment it is copied out of it.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { spectrogram } from '../lib/fft.js';
import {
  BAND_LABELS,
  alignPair,
  clipPair,
  differenceOf,
  metricsMarkdown,
  metricsOf,
  onsetIndex,
  signalOf,
  type Metrics,
  type Reference,
} from '../lib/analysis.js';
import {
  drawFreqGrid,
  drawLabel,
  drawTimeAxis,
  drawWaveform,
  drawWaveformGuides,
  spectrogramDiffImage,
  spectrogramImage,
  type Box,
} from '../lib/draw.js';
import { playBuffer, type Playback } from '../lib/engine.js';

/** How the two signals are put on screen. */
export type CompareMode = 'stacked' | 'overlay' | 'diff';

/** How much of the aligned window is shown. */
export type CompareFit = 'both' | 'candidate';

export interface CompareProps {
  readonly candidateName: string;
  readonly candidate: AudioBuffer | null;
  readonly reference: Reference | null;
  readonly onLoadReference: (file: File) => void;
  readonly onClearReference: () => void;
}

const CANDIDATE_COLOR = '#22d3ee';
const REFERENCE_COLOR = '#fbbf24';
const DIFF_COLOR = '#f472b6';

/** Spectrogram settings shared by both signals, so their bins line up. */
const SPEC = { fftSize: 1024, hop: 192 } as const;

/** Difference in dB that saturates the diff ramp. */
const DIFF_RANGE_DB = 30;

export function Compare({
  candidateName,
  candidate,
  reference,
  onLoadReference,
  onClearReference,
}: CompareProps): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const playback = useRef<Playback | null>(null);
  const alternating = useRef<number | null>(null);

  const [width, setWidth] = useState(880);
  const [mode, setMode] = useState<CompareMode>('stacked');
  const [fit, setFit] = useState<CompareFit>('both');
  const [align, setAlign] = useState(true);
  const [normalize, setNormalize] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = wrap.current;
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
    if (candidate === null || reference === null) return null;
    const aligned = alignPair(signalOf(candidate), signalOf(reference.buffer), { align, normalize });
    if (fit === 'both') return aligned;
    // A quarter past the candidate's own end: enough to show that the reference
    // keeps going without handing the tail most of the width.
    const candidateMs = (candidate.length / candidate.sampleRate) * 1000;
    return clipPair(aligned, candidateMs * 1.25);
  }, [candidate, reference, align, normalize, fit]);

  const specs = useMemo(() => {
    if (pair === null) return null;
    return {
      a: spectrogram(pair.a, pair.sampleRate, SPEC),
      b: spectrogram(pair.b, pair.sampleRate, SPEC),
    };
  }, [pair]);

  const metrics = useMemo<{ a: Metrics; b: Metrics } | null>(() => {
    if (candidate === null || reference === null) return null;
    const a = signalOf(candidate);
    const b = signalOf(reference.buffer);
    return { a: metricsOf(a, onsetIndex(a)), b: metricsOf(b, onsetIndex(b)) };
  }, [candidate, reference]);

  /* --- playback ---------------------------------------------------------- */

  const stop = useCallback(() => {
    playback.current?.stop();
    playback.current = null;
    if (alternating.current !== null) {
      window.clearTimeout(alternating.current);
      alternating.current = null;
    }
  }, []);

  const playOne = useCallback(
    (buffer: AudioBuffer | null) => {
      if (buffer === null) return;
      stop();
      playback.current = playBuffer(buffer, { loop: false });
    },
    [stop],
  );

  /**
   * Alternate the two with a gap, four turns.
   *
   * A gap matters: back-to-back playback makes the tail of one blend into the
   * attack of the other, and the attack is exactly what is being judged.
   */
  const alternate = useCallback(() => {
    if (candidate === null || reference === null) return;
    stop();
    const order = [candidate, reference.buffer, candidate, reference.buffer];
    const gapMs = 180;
    let index = 0;
    const step = (): void => {
      const buffer = order[index];
      if (buffer === undefined) return;
      playback.current = playBuffer(buffer, { loop: false });
      const lengthMs = (buffer.length / buffer.sampleRate) * 1000;
      index++;
      if (index < order.length) {
        alternating.current = window.setTimeout(step, lengthMs + gapMs);
      }
    };
    step();
  }, [candidate, reference, stop]);

  useEffect(() => stop, [stop]);

  /* --- drawing ----------------------------------------------------------- */

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rows = mode === 'stacked' ? 2 : mode === 'overlay' ? 2 : 1;
    const waveH = mode === 'overlay' ? 84 : 56;
    const specH = 132;
    const headH = 22;
    const axisH = 16;
    const cssHeight = headH + (mode === 'overlay' ? waveH + specH * 2 : rows * (waveH + specH)) + axisH;

    const w = Math.round(width * dpr);
    const h = Math.round(cssHeight * dpr);
    element.width = w;
    element.height = h;
    element.style.width = `${String(width)}px`;
    element.style.height = `${String(cssHeight)}px`;

    const ctx = element.getContext('2d');
    if (ctx === null) return;
    ctx.fillStyle = '#0a0c14';
    ctx.fillRect(0, 0, w, h);

    if (pair === null || specs === null) {
      ctx.fillStyle = '#64748b';
      ctx.font = `${String(13 * dpr)}px ui-monospace, monospace`;
      ctx.fillText(
        candidate === null ? 'no render — fix the errors first' : 'load a reference file to compare',
        12 * dpr,
        26 * dpr,
      );
      return;
    }

    /* Header: everything needed to read the picture out of context. */
    const flags = [
      align ? 'onset-aligned' : 'raw timing',
      normalize ? 'peak-normalized' : 'raw level',
      fit === 'candidate' ? 'clipped to candidate' : 'full length',
    ];
    ctx.font = `${String(11 * dpr)}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(226,232,240,0.85)';
    ctx.fillText(
      `${candidateName} (candidate) vs ${reference?.name ?? '?'} (reference) · ${mode} · ${flags.join(', ')}`,
      8 * dpr,
      14 * dpr,
    );

    const plotX = 0;
    const plotW = w;
    let y = headH * dpr;
    const wave = waveH * dpr;
    const spec = specH * dpr;

    const drawSpec = (box: Box, which: 'a' | 'b' | 'diff'): void => {
      const image = ctx.createImageData(box.w, box.h);
      if (which === 'diff') spectrogramDiffImage(image, specs.a, specs.b, pair.sampleRate, DIFF_RANGE_DB);
      else spectrogramImage(image, which === 'a' ? specs.a : specs.b, pair.sampleRate);
      ctx.putImageData(image, box.x, box.y);
      drawFreqGrid(ctx, box, pair.sampleRate, dpr);
    };

    if (mode === 'stacked') {
      for (const which of ['a', 'b'] as const) {
        const samples = which === 'a' ? pair.a : pair.b;
        const color = which === 'a' ? CANDIDATE_COLOR : REFERENCE_COLOR;
        const waveBox: Box = { x: plotX, y, w: plotW, h: wave };
        drawWaveformGuides(ctx, waveBox, GLOBAL_LIMITS.maxPeak, dpr);
        drawWaveform(ctx, samples, waveBox, color);
        drawLabel(ctx, which === 'a' ? 'candidate' : 'reference', 6 * dpr, y + 13 * dpr, dpr, color);
        y += wave;
        drawSpec({ x: plotX, y, w: plotW, h: spec }, which);
        y += spec;
      }
    } else if (mode === 'overlay') {
      const waveBox: Box = { x: plotX, y, w: plotW, h: wave };
      drawWaveformGuides(ctx, waveBox, GLOBAL_LIMITS.maxPeak, dpr);
      ctx.globalAlpha = 0.75;
      drawWaveform(ctx, pair.b, waveBox, REFERENCE_COLOR);
      ctx.globalAlpha = 0.7;
      drawWaveform(ctx, pair.a, waveBox, CANDIDATE_COLOR);
      ctx.globalAlpha = 1;
      drawLabel(ctx, 'candidate', 6 * dpr, y + 13 * dpr, dpr, CANDIDATE_COLOR);
      drawLabel(ctx, 'reference', 78 * dpr, y + 13 * dpr, dpr, REFERENCE_COLOR);
      y += wave;
      drawSpec({ x: plotX, y, w: plotW, h: spec }, 'a');
      drawLabel(ctx, 'candidate', 6 * dpr, y + 13 * dpr, dpr, CANDIDATE_COLOR);
      y += spec;
      drawSpec({ x: plotX, y, w: plotW, h: spec }, 'b');
      drawLabel(ctx, 'reference', 6 * dpr, y + 13 * dpr, dpr, REFERENCE_COLOR);
      y += spec;
    } else {
      const waveBox: Box = { x: plotX, y, w: plotW, h: wave };
      drawWaveformGuides(ctx, waveBox, GLOBAL_LIMITS.maxPeak, dpr);
      drawWaveform(ctx, differenceOf(pair), waveBox, DIFF_COLOR);
      drawLabel(ctx, 'candidate − reference', 6 * dpr, y + 13 * dpr, dpr, DIFF_COLOR);
      y += wave;
      drawSpec({ x: plotX, y, w: plotW, h: spec }, 'diff');
      drawLabel(ctx, `amber = candidate louder, cyan = quieter (±${String(DIFF_RANGE_DB)} dB)`, 6 * dpr, y + 13 * dpr, dpr);
      y += spec;
    }

    drawTimeAxis(ctx, { x: plotX, y, w: plotW, h: axisH * dpr }, pair.windowMs, dpr);
  }, [pair, specs, mode, align, normalize, fit, width, candidate, reference, candidateName]);

  /* --- export ------------------------------------------------------------ */

  const flash = (what: string): void => {
    setCopied(what);
    window.setTimeout(() => setCopied((current) => (current === what ? null : current)), 1400);
  };

  const copyImage = (): void => {
    const element = canvas.current;
    if (element === null) return;
    element.toBlob((blob) => {
      if (blob === null) return;
      void navigator.clipboard
        .write([new ClipboardItem({ 'image/png': blob })])
        .then(() => flash('image'))
        .catch(() => flash('image-failed'));
    }, 'image/png');
  };

  const downloadImage = (): void => {
    const element = canvas.current;
    if (element === null) return;
    element.toBlob((blob) => {
      if (blob === null) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${candidateName}-vs-${reference?.name ?? 'reference'}-${mode}-${fit}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

  const copyReport = (): void => {
    if (metrics === null || reference === null) return;
    const table = metricsMarkdown(candidateName, reference.name, metrics.a, metrics.b);
    const note =
      'Measured in a 512-sample (~12 ms) window at each sound\'s own onset. Band values are dB below the frame total.';
    void navigator.clipboard.writeText(`${table}\n\n${note}\n`).then(() => flash('report'));
  };

  /* --- file intake ------------------------------------------------------- */

  const takeFiles = (files: FileList | null): void => {
    const file = files?.[0];
    if (file !== undefined) onLoadReference(file);
  };

  const label = (what: string, fallback: string): string =>
    copied === what ? 'copied' : copied === `${what}-failed` ? 'copy failed' : fallback;

  return (
    <div
      className={dragging ? 'compare dragging' : 'compare'}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        takeFiles(event.dataTransfer.files);
      }}
    >
      <div className="compare-bar">
        <input
          ref={fileInput}
          type="file"
          name="reference"
          accept="audio/*"
          hidden
          onChange={(event) => takeFiles(event.target.files)}
        />
        <button type="button" onClick={() => fileInput.current?.click()}>
          {reference === null ? 'Load reference…' : 'Replace…'}
        </button>
        {reference === null ? (
          <span className="hint">or drop an audio file here</span>
        ) : (
          <>
            <span className="compare-name" title={reference.name}>
              {reference.name}
            </span>
            <button type="button" onClick={onClearReference}>
              ✕
            </button>
          </>
        )}

        <span className="compare-sep" />

        <button type="button" onClick={() => playOne(candidate)} disabled={candidate === null}>
          ▶ A
        </button>
        <button type="button" onClick={() => playOne(reference?.buffer ?? null)} disabled={reference === null}>
          ▶ B
        </button>
        <button type="button" onClick={alternate} disabled={candidate === null || reference === null}>
          ⇄ A/B
        </button>
        <button type="button" onClick={stop}>
          ■
        </button>
      </div>

      <div className="compare-bar">
        <div className="compare-modes">
          {(['stacked', 'overlay', 'diff'] as const).map((option) => (
            <button
              type="button"
              key={option}
              className={mode === option ? 'selected' : undefined}
              onClick={() => setMode(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="compare-modes">
          {(['both', 'candidate'] as const).map((option) => (
            <button
              type="button"
              key={option}
              className={fit === option ? 'selected' : undefined}
              onClick={() => setFit(option)}
              title={option === 'both' ? 'show the full length of both' : "clip to the candidate's own length"}
            >
              {option === 'both' ? 'full' : 'zoom'}
            </button>
          ))}
        </div>
        <label className="toggle">
          <input type="checkbox" name="align" checked={align} onChange={(e) => setAlign(e.target.checked)} />
          align onsets
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            name="normalize"
            checked={normalize}
            onChange={(e) => setNormalize(e.target.checked)}
          />
          normalize peaks
        </label>

        <span className="compare-sep" />

        <button type="button" onClick={copyImage} disabled={pair === null}>
          {label('image', 'Copy PNG')}
        </button>
        <button type="button" onClick={downloadImage} disabled={pair === null}>
          Save PNG
        </button>
        <button type="button" onClick={copyReport} disabled={metrics === null}>
          {label('report', 'Copy numbers')}
        </button>
      </div>

      <div className="compare-canvas" ref={wrap}>
        <canvas ref={canvas} />
      </div>

      {pair === null ? null : (
        <div className="compare-onsets">
          onset found at {pair.foundOnsetMsA.toFixed(1)} ms in the candidate,{' '}
          {pair.foundOnsetMsB.toFixed(1)} ms in the reference
          {align ? ' — both shifted to 5 ms' : ' — not applied'}
        </div>
      )}

      {metrics === null || reference === null ? null : (
        <table className="compare-table">
          <thead>
            <tr>
              <th>metric</th>
              <th>{candidateName}</th>
              <th>{reference.name}</th>
            </tr>
          </thead>
          <tbody>
            <MetricRow label="peak" a={metrics.a.peak.toFixed(3)} b={metrics.b.peak.toFixed(3)} />
            <MetricRow
              label="duration to −60 dB"
              a={`${String(Math.round(metrics.a.durationMs))} ms`}
              b={`${String(Math.round(metrics.b.durationMs))} ms`}
            />
            <MetricRow
              label="attack to peak"
              a={`${String(Math.round(metrics.a.attackMs))} ms`}
              b={`${String(Math.round(metrics.b.attackMs))} ms`}
            />
            <MetricRow
              label="dominant partial"
              a={`${String(Math.round(metrics.a.dominantHz))} Hz`}
              b={`${String(Math.round(metrics.b.dominantHz))} Hz`}
            />
            <MetricRow
              label="centroid"
              a={`${String(Math.round(metrics.a.centroidHz))} Hz`}
              b={`${String(Math.round(metrics.b.centroidHz))} Hz`}
            />
            <MetricRow label="flatness" a={metrics.a.flatness.toFixed(4)} b={metrics.b.flatness.toFixed(4)} />
            {BAND_LABELS.map((band, i) => (
              <MetricRow
                key={band}
                label={`band ${band}`}
                a={`${(metrics.a.bandsDb[i] ?? 0).toFixed(1)} dB`}
                b={`${(metrics.b.bandsDb[i] ?? 0).toFixed(1)} dB`}
              />
            ))}
            <MetricRow
              label="decay 0…25 ms"
              a={metrics.a.decayDb.map((d) => d.toFixed(0)).join('/')}
              b={metrics.b.decayDb.map((d) => d.toFixed(0)).join('/')}
            />
          </tbody>
        </table>
      )}
    </div>
  );
}

function MetricRow({ label, a, b }: { readonly label: string; readonly a: string; readonly b: string }): React.JSX.Element {
  return (
    <tr>
      <td>{label}</td>
      <td>{a}</td>
      <td>{b}</td>
    </tr>
  );
}
