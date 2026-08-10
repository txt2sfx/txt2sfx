/**
 * The arrangement, drawn.
 *
 * ## The picture is the notes
 *
 * Every cell here is a step of a lane's pattern at the loudness that step actually
 * plays — `laneClips` reduces the note list, nothing draws a shape from a table. That is
 * the same discipline `lib/layers.ts` argues for the waveform lanes in the studio: a
 * picture of the *arguments* rather than of the sound is a picture that cannot show you
 * a mistake. Here it means a lane whose pattern came out empty looks empty, a lane the
 * prompt made sparse looks sparse, and a retried lane visibly changes.
 *
 * ## Two columns, one grid
 *
 * The labels are a separate flex column rather than a first cell in each row, so the
 * clip area can be a single positioning context — which is what lets the playhead be one
 * absolutely-positioned element sweeping the whole stack instead of one per lane.
 *
 * ## The playhead is an animation, not a clock
 *
 * `animation: sweep linear infinite` at the loop's own duration. It is not sample-accurate
 * — it starts when React commits, and the buffer starts when the audio thread gets to it,
 * which is a few milliseconds later. It is a *tempo* indicator, and for that a CSS
 * animation is exactly right: it costs nothing, it cannot drift over a long session
 * because it is driven by the same duration the buffer is, and it does not wake the main
 * thread sixty times a second to move a `div`.
 *
 * @packageDocumentation
 */

import { IconRotate, IconTrash } from './Icons.js';
import { laneClips, type LoopLane } from '../lib/loop.js';
import { useI18n } from '../lib/i18n.js';

export interface LoopTimelineProps {
  readonly lanes: readonly LoopLane[];
  /**
   * Lanes this track will have and does not yet, drawn as dimmed rows.
   *
   * The reveal is a measurement (`useLoop.ts` says why), so the grid used to grow one row
   * at a time and carry everything under it down the page twice a second. A placeholder row
   * per staged lane keeps the card the height it will end at while still showing only the
   * lanes that have actually been rendered.
   */
  readonly pending?: number;
  readonly bars: number;
  readonly steps: number;
  /** How long one lap takes, which is the playhead's animation duration. */
  readonly loopMs: number;
  readonly playing: boolean;
  readonly muted: ReadonlySet<string>;
  readonly onMute: (lane: string) => void;
  readonly onKeep: (lane: string) => void;
  readonly onRetry: (lane: string) => void;
  readonly onDrop: (lane: string) => void;
}

export function LoopTimeline({
  lanes,
  pending = 0,
  bars,
  steps,
  loopMs,
  playing,
  muted,
  onMute,
  onKeep,
  onRetry,
  onDrop,
}: LoopTimelineProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="timeline">
      <div className="timeline-labels">
        <div className="timeline-ruler-gap" />
        {lanes.map((lane) => (
          <div
            className={`lane-label${muted.has(lane.name) ? ' muted' : ''}`}
            key={lane.name}
            style={{ ['--hue' as string]: String(lane.hue) }}
          >
            <button
              type="button"
              className={`lane-mute${muted.has(lane.name) ? ' on' : ''}`}
              title={muted.has(lane.name) ? t('loop.unmute') : t('loop.mute')}
              aria-pressed={muted.has(lane.name)}
              onClick={() => onMute(lane.name)}
            >
              M
            </button>
            <span className="mono lane-name">{lane.name}</span>
            {lane.proposed === true ? <span className="lane-badge mono">{t('loop.laneNew')}</span> : null}
          </div>
        ))}
        {Array.from({ length: pending }, (_, index) => (
          <div className="lane-label pending" key={`pending-${String(index)}`} aria-hidden="true">
            <span className="ghost-line ghost-label" />
          </div>
        ))}
      </div>

      <div className="timeline-grid">
        <div className="timeline-ruler mono">
          {Array.from({ length: bars }, (_, bar) => (
            <div key={bar}>{bar + 1}</div>
          ))}
        </div>

        {lanes.map((lane) => (
          <div className="lane-track" key={lane.name} style={{ ['--hue' as string]: String(lane.hue) }}>
            {laneClips(lane, steps).map((clip) => (
              <div
                className={`clip${lane.proposed === true ? ' proposed' : ''}${muted.has(lane.name) ? ' muted' : ''}`}
                key={clip.left}
                style={{ left: `${String(clip.left)}%`, width: `${String(clip.width)}%` }}
              >
                {clip.cells.map((cell, index) => (
                  <i key={index} style={{ height: `${String(cell.h)}%`, opacity: cell.o }} />
                ))}
              </div>
            ))}

            {lane.proposed === true ? (
              <div className="lane-verdict">
                <button type="button" className="keep" onClick={() => onKeep(lane.name)}>
                  {t('loop.keep')}
                </button>
                <button type="button" className="icon" title={t('loop.retryTitle')} onClick={() => onRetry(lane.name)}>
                  <IconRotate size={12} />
                </button>
                <button
                  type="button"
                  className="icon danger"
                  title={t('loop.discardTitle')}
                  onClick={() => onDrop(lane.name)}
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ) : null}
          </div>
        ))}

        {Array.from({ length: pending }, (_, index) => (
          <div className="lane-track pending" key={`pending-${String(index)}`} aria-hidden="true" />
        ))}

        {playing ? <div className="playhead" style={{ animationDuration: `${String(loopMs)}ms` }} /> : null}
      </div>
    </div>
  );
}
