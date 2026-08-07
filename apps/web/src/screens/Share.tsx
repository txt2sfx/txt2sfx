/**
 * Handing a sound to someone else.
 *
 * ## Two audiences, one screen
 *
 * A person who receives a link wants to **hear it**, immediately, with no install and no
 * key. A person who receives the code wants to **paste it into a game**. Both are served
 * here and the order is deliberate: the link first, because that is the thing that gets
 * clicked, and the JavaScript beside it, because that is the thing that gets shipped.
 *
 * The link carries the recipe itself in its fragment (see `lib/share.ts`), which is why
 * there is no service behind it and no id to expire. What that costs is a long URL, said
 * plainly under the box rather than hidden behind a shortener that would put a server
 * back in the path.
 *
 * ## The card is not decoration
 *
 * A sound posted into a chat is invisible: a link with no preview, and nobody clicks it.
 * The card gives it a body — the prompt in quotation marks, the waveform, the recipe in
 * four lines, and the two numbers that make the argument (`1.8 s · 874 B`). It is drawn
 * to a canvas rather than screenshotted so it comes out the same on every machine, and
 * the recipe on it is real text at a legible size, because a reader who can see the
 * recipe has understood the entire pitch without reading a word of prose.
 *
 * @packageDocumentation
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CodegenResult, RenderResult } from '@txt2sfx/core';
import { Bars } from '../components/Bars.js';
import { FormatMenu } from '../components/FormatMenu.js';
import { catColor } from '../lib/design.js';
import { copy, type Format } from '../lib/download.js';
import { bytes as fmtBytes, ms } from '../lib/format.js';
import { bars, ghostBars } from '../lib/layers.js';
import { shareLink } from '../lib/share.js';

/** Bars on the card and in the strip. */
const BAR_COUNT = 96;

export interface ShareProps {
  readonly name: string;
  readonly prompt: string;
  readonly source: string;
  readonly category: string | undefined;
  readonly code: CodegenResult | null;
  readonly rendered: RenderResult | null;
  /**
   * The header's declared duration.
   *
   * Not `rendered.durationMs`, which carries the analyzer's 50 ms trailing pad: a card
   * that goes out to other people claiming a 55 ms pop is 105 ms long is the kind of
   * small dishonesty that is very hard to walk back.
   */
  readonly durationMs: number;
  readonly playing: boolean;
  readonly onPlay: () => void;
  readonly onBack: () => void;
  readonly formatId: string;
  readonly onFormat: (id: string) => void;
  readonly onDownload: (format: Format) => Promise<unknown> | void;
}

export function Share({
  name,
  prompt,
  source,
  category,
  code,
  rendered,
  durationMs,
  playing,
  onPlay,
  onBack,
  formatId,
  onFormat,
  onDownload,
}: ShareProps): React.JSX.Element {
  const [note, setNote] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);

  const link = useMemo(() => shareLink({ source, name, prompt }), [source, name, prompt]);
  const values = rendered === null ? ghostBars(name, BAR_COUNT) : bars(rendered.buffer, BAR_COUNT);
  /* The card is a small rectangle in a chat client, and a recipe's own header comment
     can be a paragraph. One sentence is the claim; the rest is documentation, and it
     belongs in the recipe rather than on the picture. */
  const caption = firstSentence(prompt === '' ? name.replace(/-/g, ' ') : prompt);

  const say = (message: string): void => {
    setNote(message);
    window.setTimeout(() => setNote((current) => (current === message ? null : current)), 1600);
  };

  /**
   * Draw the card to a canvas.
   *
   * Deliberately hand-drawn rather than rasterised from the DOM: `html2canvas` and its
   * relatives are a dependency, they render `oklch` unpredictably, and the one thing the
   * card must do is come out identical on every machine that produces one.
   */
  const paint = useCallback((): HTMLCanvasElement | null => {
    const scale = 2;
    const w = 720;
    const h = 460;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.scale(scale, scale);

    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, '#2b2340');
    gradient.addColorStop(1, '#14262c');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    ctx.font = '600 12px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(120,220,235,0.9)';
    ctx.fillText('TXT2SFX', 34, 46);
    ctx.fillStyle = 'rgba(226,232,240,0.6)';
    ctx.fillText(
      `·  ${ms(durationMs)}  ·  ${code === null ? '—' : fmtBytes(code.bytes)}  ·  0 dependencies`,
      104,
      46,
    );

    ctx.font = '500 22px system-ui, sans-serif';
    ctx.fillStyle = '#eef3f7';
    wrapText(ctx, `“${caption}”`, 34, 92, w - 68, 30);

    /* The waveform, in the same bar language as everywhere else in the app, so a card
       and the studio strip it came from are recognisably the same picture. */
    const top = 150;
    const height = 84;
    const gap = 2;
    const barWidth = (w - 68 + gap) / values.length - gap;
    /* An sRGB literal rather than the category's oklch: `canvas` colour parsing for
       oklch is uneven across engines, and a card that comes out a different colour on
       someone else's machine defeats the point of drawing it rather than screenshotting
       it. The screen version beside it uses the real token. */
    ctx.fillStyle = '#7fd8ea';
    for (let i = 0; i < values.length; i++) {
      const value = Math.max(0.03, values[i] ?? 0);
      const barHeight = value * height;
      ctx.fillRect(34 + i * (barWidth + gap), top + (height - barHeight) / 2, barWidth, barHeight);
    }

    ctx.fillStyle = 'rgba(10,14,20,0.66)';
    roundRect(ctx, 34, 260, w - 68, 160, 10);
    ctx.fill();

    ctx.font = '11.5px ui-monospace, monospace';
    const lines = source.split('\n').filter((line) => line.trim() !== '');
    let y = 284;
    for (const line of lines.slice(0, 8)) {
      ctx.fillStyle = line.trimStart().startsWith('#') ? 'rgba(140,190,160,0.85)' : 'rgba(226,238,246,0.92)';
      ctx.fillText(line.length > 78 ? `${line.slice(0, 77)}…` : line, 48, y);
      y += 18;
    }
    if (lines.length > 8) {
      ctx.fillStyle = 'rgba(226,232,240,0.5)';
      ctx.fillText(`… ${String(lines.length - 8)} more line(s)`, 48, y);
    }

    return canvas;
  }, [values, source, caption, code, durationMs]);

  const copyImage = useCallback(async (): Promise<void> => {
    const canvas = paint();
    if (canvas === null) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob === null) throw new Error('no image');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      say('copied the card');
    } catch {
      say('the clipboard refused an image — use Save PNG');
    }
  }, [paint]);

  const savePng = useCallback((): void => {
    const canvas = paint();
    if (canvas === null) return;
    const link_ = document.createElement('a');
    link_.href = canvas.toDataURL('image/png');
    link_.download = `${name}.png`;
    link_.click();
    say(`saved ${name}.png`);
  }, [paint, name]);

  return (
    <div className="screen screen-share">
      <div className="share-grid">
        <div className="share-main">
          <button type="button" className="link back" onClick={onBack}>
            ← back to studio
          </button>
          <h2 className="mono">{name}</h2>
          <p className="share-prompt">“{prompt === '' ? name.replace(/-/g, ' ') : prompt}”</p>

          <div className="share-play">
            <button type="button" className="play-big" onClick={onPlay} disabled={rendered === null}>
              {playing ? '❚❚' : '▶'}
            </button>
            <Bars
              values={values}
              muted={rendered === null}
              playing={playing}
              durationMs={durationMs}
              className="bars-share"
              color={catColor(category, 0.72, 0.12)}
            />
            <span className="mono faint">{ms(durationMs)}</span>
          </div>

          <div className="input-shell link-row">
            <span className="mono link-text">{link}</span>
            <button type="button" className="primary" onClick={() => void copy(link, 'the link').then(say)}>
              Copy link
            </button>
          </div>
          <p className="caption">
            Opens a page that plays the sound the moment it loads. The recipe travels inside the link, so nothing has to
            stay up for it to keep working and no key is needed to listen — which is also why it is long.
          </p>

          <div className="share-actions">
            <button
              type="button"
              disabled={code === null}
              onClick={() => code !== null && void copy(code.code, 'the JavaScript').then(say)}
            >
              Copy JS{code === null ? '' : ` · ${fmtBytes(code.bytes)}`}
            </button>
            <button type="button" onClick={() => void copy(source, 'the soundline').then(say)}>
              Copy soundline
            </button>
            <FormatMenu formatId={formatId} onFormat={onFormat} onDownload={onDownload} />
            {note === null ? null : <span className="mono faint">{note}</span>}
          </div>
        </div>

        <div className="share-side">
          <div className="share-card" ref={card}>
            <div className="mono share-card-head">
              <span>TXT2SFX</span>
              <span className="faint">
                · {ms(durationMs)} · {code === null ? '—' : fmtBytes(code.bytes)}
              </span>
            </div>
            <div className="share-card-prompt">“{caption}”</div>
            <Bars values={values} className="bars-card-share" color="oklch(0.86 0.13 195)" />
            <pre className="share-card-code">{source.trimEnd()}</pre>
          </div>

          <div className="share-actions">
            <button type="button" className="wide" onClick={() => void copyImage()}>
              Copy image
            </button>
            <button type="button" className="wide" onClick={savePng}>
              Save PNG
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The first sentence, capped.
 *
 * A recipe's leading comment is documentation and often several sentences of it; the
 * card has room for a claim. Cutting at the first full stop keeps a real sentence rather
 * than a truncation, and the character cap catches the ones with no full stop at all.
 */
function firstSentence(text: string, limit = 150): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const stop = trimmed.search(/\.(\s|$)/);
  const sentence = stop > 20 ? trimmed.slice(0, stop + 1) : trimmed;
  return sentence.length <= limit ? sentence : `${sentence.slice(0, limit - 1).trimEnd()}…`;
}

/** Wrap text to `maxWidth`, at most three lines. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  const words = text.split(' ');
  let line = '';
  let drawn = 0;
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`;
    if (ctx.measureText(next).width > maxWidth && line !== '') {
      ctx.fillText(line, x, y + drawn * lineHeight);
      drawn++;
      line = word;
      if (drawn === 2) break;
    } else {
      line = next;
    }
  }
  ctx.fillText(line, x, y + drawn * lineHeight);
}

/** A rounded rectangle path. `roundRect` is not in every engine this has to run on. */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
