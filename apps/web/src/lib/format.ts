/**
 * How numbers are spelled in the interface.
 *
 * Small and boring on purpose, and centralised for one reason: a duration written
 * `1800ms` in the rail and `1.8 s` on the card is read as two different sounds.
 * Every panel formats through here, so the gallery, the studio and the share card
 * cannot disagree.
 *
 * @packageDocumentation
 */

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
 * "3 min ago".
 *
 * Relative rather than absolute because the only question anyone asks of this
 * column is *did I touch this recently*, and answering it with a timestamp makes
 * the reader do the subtraction.
 */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${String(days)} d ago`;
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
