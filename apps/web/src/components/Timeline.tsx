/**
 * Layer timeline: when each layer speaks, and how long its tail rings on.
 *
 * Layers are the unit of composition in a soundline, and most "it sounds muddy"
 * problems are timing problems between them — two transients landing together, a
 * body that starts before its click, a reverb tail that outlives the declared
 * duration. The envelope segment and the effect tail are drawn separately because
 * they are separately fixable: one is `| gain … decay …`, the other is the `>>`
 * chain.
 *
 * @packageDocumentation
 */

import { envelopeTiming, layerTailMs } from '@txt2sfx/core';
import type { SoundAST } from '@txt2sfx/shared';

export interface TimelineProps {
  readonly ast: SoundAST | null;
  /** Rendered length, in milliseconds — the axis the bars are drawn against. */
  readonly totalMs: number;
}

export function Timeline({ ast, totalMs }: TimelineProps): React.JSX.Element | null {
  if (ast === null || totalMs <= 0) return null;

  return (
    <div className="timeline">
      {ast.layers.map((layer, index) => {
        const timing = envelopeTiming(layer.envelope);
        const startMs = timing.startSec * 1000;
        const bodyMs = (timing.endSec - timing.startSec) * 1000;
        const tailMs = layerTailMs(layer);
        const pct = (ms: number): string => `${String((Math.max(0, ms) / totalMs) * 100)}%`;

        return (
          <div className="timeline-row" key={layer.name} data-accent={index % 4}>
            <span className="timeline-name">{layer.name}</span>
            <div className="timeline-track">
              <div className="timeline-bar" style={{ left: pct(startMs), width: pct(bodyMs) }} title={`${layer.name}: ${String(Math.round(bodyMs))}ms envelope`} />
              {tailMs > 0 ? (
                <div
                  className="timeline-tail"
                  style={{ left: pct(startMs + bodyMs), width: pct(tailMs) }}
                  title={`${layer.name}: ${String(Math.round(tailMs))}ms effect tail`}
                />
              ) : null}
            </div>
            <span className="timeline-ms">{Math.round(startMs + bodyMs + tailMs)}ms</span>
          </div>
        );
      })}
    </div>
  );
}
