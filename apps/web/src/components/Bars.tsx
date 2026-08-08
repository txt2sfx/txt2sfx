/**
 * A waveform as bars, and why the app has two waveform renderers.
 *
 * The compare view draws min/max waveforms into a canvas, at one sample column per
 * device pixel, because that is a measurement instrument: it has to show the exact
 * shape of an attack next to another one, and a bar chart would quantize away the
 * thing being compared.
 *
 * This is the other kind. It appears in a gallery card, in the studio's master
 * strip, in a layer lane and on the share image — places where the question is
 * *which sound is this* rather than *what exactly does it do*. Bars answer that
 * better than a filled envelope: they read at 34 pixels tall, they survive being
 * scaled by a flex layout, they carry a colour per layer without a second canvas,
 * and a CSS transition on their heights turns a slider move into visible motion for
 * free. Nothing here is a smaller version of the canvas renderer; it is a different
 * job.
 *
 * The heights come from `lib/layers.ts` — peak per bucket over a real render, never
 * an envelope inferred from the recipe's arguments.
 *
 * @packageDocumentation
 */

export interface BarsProps {
  /** Heights in 0..1, from `bars()` or `ghostBars()`. */
  readonly values: Float32Array;
  /** Any CSS colour; the bars are painted with `currentColor`. Omitted means inherit. */
  readonly color?: string | undefined;
  /** Draw the sweeping playhead. */
  readonly playing?: boolean;
  /** The playhead wraps instead of stopping at the right edge. Ignored unless `playing`. */
  readonly loop?: boolean;
  /** How long the sweep takes. Ignored unless `playing`. */
  readonly durationMs?: number;
  /** Extra class, for the size and spacing variants in the stylesheet. */
  readonly className?: string;
  /** Dimmed, for a candidate that no longer matches the editor. */
  readonly muted?: boolean;
}

/** Shortest sweep worth animating: a 2 ms click would flash and be missed. */
const MIN_SWEEP_MS = 420;

export function Bars({
  values,
  color,
  playing = false,
  loop = false,
  durationMs = 0,
  className = '',
  muted = false,
}: BarsProps): React.JSX.Element {
  const period = durationMs > 0 ? durationMs : MIN_SWEEP_MS;
  /* Looping, the sweep *is* the loop's period — the head reaching the left edge and the
     buffer restarting are one event, and the whole claim of a position indicator is that
     where it points is where the sound is. The floor is deliberately not applied: it was,
     and a 105 ms loop then swept once per four repeats, which is what a slow, comfortable
     lie looks like. A short loop strobes because a short loop *is* a strobe. The floor
     still belongs to a single pass, where the failure is the opposite one — a 2 ms click
     would flash for one frame and be missed. */
  const sweep = loop ? period : Math.max(period, MIN_SWEEP_MS);

  return (
    <div
      className={`bars${muted ? ' bars-muted' : ''}${className === '' ? '' : ` ${className}`}`}
      style={color === undefined ? undefined : { color }}
      aria-hidden="true"
    >
      {Array.from(values, (height, index) => (
        <i
          key={index}
          /* A floor of 3 %: a bar of zero height disappears and the strip develops
             gaps that read as missing data rather than as silence. */
          style={{ height: `${String(Math.max(3, Math.round(height * 100)))}%` }}
        />
      ))}
      {playing ? (
        <span
          className={`bars-head${loop ? ' bars-head-loop' : ''}`}
          style={{ animationDuration: `${String(sweep)}ms` }}
        />
      ) : null}
    </div>
  );
}
