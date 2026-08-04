/**
 * Waveform over spectrogram for the sound being edited.
 *
 * These two pictures answer the two questions that come up when a sound is
 * "somehow wrong": *when* the energy happens (waveform — attack too soft, tail too
 * long, gaps between layers) and *where* it sits (spectrogram — a sweep that never
 * arrives, a resonance that whistles, noise where a tone was meant). The drawing
 * primitives are shared with the compare view so a judgement formed here carries
 * over there unchanged — see `lib/draw.ts`.
 *
 * @packageDocumentation
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { spectrogram } from '../lib/fft.js';
import {
  drawFreqGrid,
  drawWaveform,
  drawWaveformGuides,
  spectrogramImage,
  type Box,
} from '../lib/draw.js';

export interface VisualizerProps {
  readonly buffer: AudioBuffer | null;
  /** The header's duration contract, drawn as a marker. */
  readonly declaredMs: number;
  /** Peak amplitude limit above which the mix is considered clipped. */
  readonly maxPeak: number;
}

export function Visualizer({ buffer, declaredMs, maxPeak }: VisualizerProps): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);

  useEffect(() => {
    const element = wrap.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const spec = useMemo(
    () =>
      buffer === null
        ? null
        : spectrogram(buffer.getChannelData(0), buffer.sampleRate, { fftSize: 1024, hop: 192 }),
    [buffer],
  );

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssHeight = 260;
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

    if (buffer === null || spec === null) {
      ctx.fillStyle = '#4b5563';
      ctx.font = `${String(13 * dpr)}px ui-monospace, monospace`;
      ctx.fillText('no render — fix the errors above', 12 * dpr, 24 * dpr);
      return;
    }

    const waveBox: Box = { x: 0, y: 0, w, h: Math.round(h * 0.3) };
    const specBox: Box = { x: 0, y: waveBox.h, w, h: h - waveBox.h };
    const totalMs = (buffer.length / buffer.sampleRate) * 1000;

    drawWaveformGuides(ctx, waveBox, maxPeak, dpr);
    drawWaveform(ctx, buffer.getChannelData(0), waveBox, '#22d3ee');

    const image = ctx.createImageData(specBox.w, specBox.h);
    spectrogramImage(image, spec, buffer.sampleRate);
    ctx.putImageData(image, specBox.x, specBox.y);
    drawFreqGrid(ctx, specBox, buffer.sampleRate, dpr);

    ctx.font = `${String(10 * dpr)}px ui-monospace, monospace`;

    // Where the header says the sound ends.
    if (declaredMs > 0 && declaredMs < totalMs) {
      const x = (declaredMs / totalMs) * w;
      ctx.strokeStyle = 'rgba(251,191,36,0.8)';
      ctx.setLineDash([6 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(251,191,36,0.9)';
      const caption = `${String(Math.round(declaredMs))}ms declared`;
      const captionWidth = ctx.measureText(caption).width;
      ctx.fillText(caption, Math.max(2 * dpr, Math.min(x + 4 * dpr, w - captionWidth - 4 * dpr)), 12 * dpr);
    }

    ctx.fillStyle = 'rgba(226,232,240,0.6)';
    const total = `${String(Math.round(totalMs))}ms rendered`;
    ctx.fillText(total, w - ctx.measureText(total).width - 4 * dpr, h - 6 * dpr);
  }, [buffer, spec, width, declaredMs, maxPeak]);

  return (
    <div className="visualizer" ref={wrap}>
      <canvas ref={canvas} />
    </div>
  );
}
