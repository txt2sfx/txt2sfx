/**
 * The candidate that is currently winning the fit — visible, and audible.
 *
 * A search reports a number per generation, and a number cannot be listened to.
 * That is not a cosmetic gap: the expensive failure of a metric-driven fit is a
 * candidate that scores better and *sounds like something else*, and that failure
 * is invisible in a falling fitness curve. Forty generations later the run hands
 * over a stranger and the only evidence of when it happened has been discarded.
 *
 * So the leader is rendered as it goes: waveform, spectrogram, and a play button.
 * Three rules make that affordable next to the search it is watching, since every
 * preview frame competes with the population of renders paying for the actual
 * progress:
 *
 * 1. **One render in flight, ever.** A frame that arrives while another is
 *    rendering is not queued, it is *replaced* — the newest leader is the only one
 *    worth drawing, and a queue would turn a preview into a second search.
 * 2. **Trailing debounce.** Generations land about a second apart; the wait is
 *    what keeps the preview in the gaps between them instead of in front.
 * 3. **Play from the buffer that was drawn.** No render on the button, so the
 *    picture and the sound are the same candidate and the click is instant.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { parse } from '@txt2sfx/core';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { spectrogram } from '../lib/fft.js';
import { drawFreqGrid, drawWaveform, drawWaveformGuides, spectrogramImage, type Box } from '../lib/draw.js';
import { playBuffer, render, type Playback } from '../lib/engine.js';
import { useI18n } from '../lib/i18n.js';

export interface FitPreviewProps {
  /** The best recipe so far, as text. Empty means there is nothing to show yet. */
  readonly source: string;
  /** Compile seed, so the preview is the sound the run will hand over. */
  readonly seed: number;
  /** Take this candidate now and end the run. */
  readonly onTake: () => void;
}

/**
 * How long the leader has to stop changing before it is rendered.
 *
 * Long enough to sit between generations rather than in front of them, short
 * enough that the picture is of the search as it is and not as it was.
 */
const DEBOUNCE_MS = 400;

const CANDIDATE_COLOR = '#22d3ee';
const WAVE_H = 40;
const SPEC_H = 88;

export function FitPreview({ source, seed, onTake }: FitPreviewProps): React.JSX.Element {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const playback = useRef<Playback | null>(null);

  /* The newest leader waiting to be drawn, and whether one is being drawn now.
     Refs rather than state: a dropped frame must not cause a re-render, or the
     preview would spend its budget re-rendering React instead of audio. */
  const pending = useRef<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);

  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [width, setWidth] = useState(560);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      playback.current?.stop();
      playback.current = null;
    };
  }, []);

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

  /** Render whatever is pending, then whatever arrived while that was happening. */
  const pump = useCallback((): void => {
    const next = pending.current;
    if (next === null || busy.current || !alive.current) return;
    pending.current = null;
    busy.current = true;

    void (async () => {
      try {
        const result = await render(parse(next), { seed });
        if (alive.current) setBuffer(result.buffer);
      } catch {
        /* A fitted recipe that no longer parses or renders would be a bug upstream,
           and the run's own log is where it belongs. A preview that throws away the
           last good picture to say so helps nobody. */
      } finally {
        busy.current = false;
        pump();
      }
    })();
  }, [seed]);

  useEffect(() => {
    if (source === '') return;
    pending.current = source;
    const timer = window.setTimeout(pump, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [source, pump]);

  const play = useCallback(() => {
    if (buffer === null) return;
    playback.current?.stop();
    playback.current = playBuffer(buffer, { loop: false });
  }, [buffer]);

  /* --- drawing ----------------------------------------------------------- */

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssHeight = WAVE_H + SPEC_H;
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

    if (buffer === null) {
      ctx.font = `${String(11 * dpr)}px ui-monospace, monospace`;
      ctx.fillStyle = '#64748b';
      ctx.fillText(t('fit.rendering'), 8 * dpr, 20 * dpr);
      return;
    }

    const samples = buffer.getChannelData(0);
    const waveBox: Box = { x: 0, y: 0, w, h: WAVE_H * dpr };
    drawWaveformGuides(ctx, waveBox, GLOBAL_LIMITS.maxPeak, dpr);
    drawWaveform(ctx, samples, waveBox, CANDIDATE_COLOR);

    const specBox: Box = { x: 0, y: WAVE_H * dpr, w, h: SPEC_H * dpr };
    const spec = spectrogram(samples, buffer.sampleRate, { fftSize: 1024, hop: 192 });
    const image = ctx.createImageData(specBox.w, specBox.h);
    spectrogramImage(image, spec, buffer.sampleRate);
    ctx.putImageData(image, specBox.x, specBox.y);
    drawFreqGrid(ctx, specBox, buffer.sampleRate, dpr);
  }, [buffer, width, t]);

  return (
    <div className="fit-preview">
      <div className="fit-preview-bar">
        <button type="button" onClick={play} disabled={buffer === null} title={t('fit.leaderTitle')}>
          ▶ {t('fit.leader')}
        </button>
        <button type="button" onClick={() => playback.current?.stop()}>
          ■
        </button>
        <button type="button" onClick={onTake} title={t('fit.takeTitle')}>
          ⤓ {t('fit.take')}
        </button>
        <span className="hint">
          {buffer === null
            ? t('fit.waiting')
            : t('fit.asRendered', { ms: ((buffer.length / buffer.sampleRate) * 1000).toFixed(0) })}
        </span>
      </div>
      <div className="fit-preview-canvas" ref={wrap}>
        <canvas ref={canvas} />
      </div>
    </div>
  );
}
