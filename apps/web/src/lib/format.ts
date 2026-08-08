/**
 * How numbers are spelled in the interface.
 *
 * Small and boring on purpose, and centralised for one reason: a duration written
 * `1800ms` in the rail and `1.8 s` on the card is read as two different sounds.
 * Every panel formats through here, so the gallery, the studio and the share card
 * cannot disagree.
 *
 * Only {@link ago} is language-dependent, and it delegates to `Intl` rather than to the
 * dictionary: relative time needs plural rules, and Russian alone has three forms for
 * "days". Hand-writing that nine times over is how a translation file starts being wrong.
 * Durations, byte counts and frequencies are deliberately *not* localised — they are
 * beside numbers the user types into recipes, and a `1,024 B` that becomes `1 024 B`
 * disagrees with the text in the editor.
 *
 * @packageDocumentation
 */

import { bcp47, t } from './i18n.js';

/**
 * A duration, in whichever unit reads better at that magnitude.
 *
 * The switch is at one second rather than at some perceptual boundary, because
 * the reader is scanning a column of them and a consistent rule beats a clever
 * one. Sub-second values keep no decimals — `45 ms` is the number, `45.3 ms` is
 * noise from the trailing pad.
 */
export function ms(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return `${String(Math.round(value))} ms`;
  const seconds = value / 1000;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
}

/** A byte count, with the thousands separator the export budget deserves. */
export function bytes(value: number): string {
  return `${value.toLocaleString('en-US')} B`;
}

/**
 * A byte count on the scale a download page uses.
 *
 * {@link bytes} is for the export budget, where every byte is the point and `847 B`
 * is the honest answer. This is for the other end of the range — a 1.7 GB checkpoint
 * and a 6 GB environment — where the separators stop being readable and the reader
 * only wants to know whether the disk can take it. Powers of 1024, matching what
 * `run.py` prints and what Hugging Face reports while it fetches.
 */
export function size(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(Math.round(scaled)) : scaled.toFixed(2)} ${units[unit] ?? 'B'}`;
}

/**
 * "3 min ago".
 *
 * Relative rather than absolute because the only question anyone asks of this
 * column is *did I touch this recently*, and answering it with a timestamp makes
 * the reader do the subtraction.
 */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  /* `Intl` would render this as "this minute", which answers a different question. */
  if (minutes < 1) return t('time.justNow');
  const relative = relativeFor(bcp47());
  if (minutes < 60) return relative.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, 'hour');
  /* `numeric: 'auto'` is what turns −1 day into "yesterday" rather than "1 day ago". */
  return relative.format(-Math.round(hours / 24), 'day');
}

/**
 * One formatter per language, built once.
 *
 * `Intl.RelativeTimeFormat` construction is not free and `ago` is called for every row of
 * the rail and every card in the gallery on each render.
 */
const relatives = new Map<string, Intl.RelativeTimeFormat>();

function relativeFor(tag: string): Intl.RelativeTimeFormat {
  const existing = relatives.get(tag);
  if (existing !== undefined) return existing;
  const made = new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style: 'short' });
  relatives.set(tag, made);
  return made;
}

/** A signed difference, for the Δ column of the compare table. */
export function delta(value: number, unit: string, digits = 0): string {
  const sign = value >= 0 ? '+' : '−';
  const magnitude = Math.abs(value);
  const text = unit === 'ms' && magnitude >= 1000 ? ms(magnitude) : magnitude.toFixed(digits);
  return `${sign}${text}${unit === '' || (unit === 'ms' && magnitude >= 1000) ? '' : ` ${unit}`}`;
}

/** A frequency, in Hz below a kilohertz and kHz above it. */
export function hz(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} kHz` : `${String(Math.round(value))} Hz`;
}
