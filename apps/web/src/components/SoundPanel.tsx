/**
 * The sound itself: one master strip, one lane per layer, and the transport.
 *
 * ## Why the lanes are the centrepiece
 *
 * A soundline is a stack of layers and the master waveform is their sum, which means
 * the master is exactly the picture in which a layer's contribution is invisible. Tune
 * `crack`'s decay in a four-layer explosion and the master barely moves — the layer is
 * 8 dB down and 90 ms long inside a 1.2 second envelope — so the one thing being edited
 * is the one thing not shown. The lanes fix that, and they cost four extra offline
 * renders per recipe (see `lib/layers.ts`, which explains why they are *renders* and not
 * envelopes drawn from the arguments).
 *
 * Each lane is labelled with what was **measured**, not with what the recipe declared:
 * where the layer's onset actually landed and how long it actually rang. Those two
 * numbers are the ones that disagree with the text when something is wrong — a `verb`
 * tail outliving its decay, a `delay` with feedback that never dies — and printing the
 * declared values instead would hide precisely the discrepancy worth seeing.
 *
 * ## Why Share sits with Play
 *
 * A recipe worth sharing is one you have just heard and liked, and that moment is in
 * this row. Putting the share action three panels down would mean the thought and the
 * button are never on screen together.
 *
 * ## The row has two ends and they mean different things
 *
 * Left is what you do *to the sound while working on it* — play it, loop it. Right is
 * what you do *with it once it is good* — take the file, keep it, hand it to somebody.
 * Download and Keep sit on the right for that reason and not for symmetry: read left to
 * right, the row is the order the work happens in.
 *
 * `Save` used to be the last of them, writing `examples/<name>.soundline` in a dev build.
 * It is gone from the row: beside a star labelled **Keep** it read as the same gesture
 * spelled twice, and two buttons that both look like "remember this" is worse than one
 * fewer way to write a file. The write itself is still there on Ctrl/Cmd+S and over the
 * bridge, which is who was using it.
 *
 * @packageDocumentation
 */

import { useEffect, useState } from 'react';
import type { RenderResult } from '@txt2sfx/core';
import type { SoundAST } from '@txt2sfx/shared';
import { Bars } from './Bars.js';
import { FormatMenu } from './FormatMenu.js';
import { metricsOf, onsetIndex, signalOf } from '../lib/analysis.js';
import { layerColor } from '../lib/design.js';
import { ms } from '../lib/format.js';
import { useI18n } from '../lib/i18n.js';
import { bars, ghostBars, renderLayers } from '../lib/layers.js';
import type { Format } from '../lib/download.js';

/** Bars in the master strip. Wide enough for a 2.4 second cycle to show its period. */
const MASTER_BARS = 96;

/** Bars in a lane. Half the master's, at a quarter of the height. */
const LANE_BARS = 72;

/** One layer, measured. */
interface Lane {
  readonly name: string;
  readonly values: Float32Array;
  readonly onsetMs: number;
  readonly durationMs: number;
}

export interface SoundPanelProps {
  /** Only used to seed the placeholder bars, so a card mid-render is not empty. */
  readonly name: string;
  readonly ast: SoundAST | null;
  readonly rendered: RenderResult | null;
  readonly seed: number;
  readonly playing: boolean;
  /** Playback is the looping kind, which the playhead and the Loop button both show. */
  readonly looping: boolean;
  readonly formatId: string;
  readonly onFormat: (id: string) => void;
  readonly onDownload: (format: Format) => Promise<unknown> | void;
  readonly onPlay: () => void;
  readonly onLoop: () => void;
  /** Star the open recipe, or take the star back. Reflected in the rail's tab. */
  readonly onFavorite: () => void;
  /** Whether it is starred right now — the button is a toggle, not an action. */
  readonly favorite: boolean;
  readonly onShare: () => void;
}

export function SoundPanel({
  name,
  ast,
  rendered,
  seed,
  playing,
  looping,
  formatId,
  onFormat,
  onDownload,
  onPlay,
  onLoop,
  onFavorite,
  favorite,
  onShare,
}: SoundPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const master =
    rendered === null ? ghostBars(name, MASTER_BARS) : bars(rendered.buffer, MASTER_BARS);
  const lanes = useLanes(ast, seed);
  /* Two different durations, and mixing them up is how a 55 ms pop comes to be labelled
     105 ms. `totalMs` is the width of the *picture* — the rendered buffer, trailing pad
     and all, which is what the bars and the playhead span. `measuredMs` is how long the
     sound is actually audible for, down to −60 dB, which is what the label means. */
  const totalMs = rendered?.durationMs ?? 0;
  const measuredMs = rendered === null ? 0 : metricsOf(signalOf(rendered.buffer)).durationMs;

  return (
    <>
      <div className="strip">
        <span className="mono strip-label">{t('sound.master')}</span>
        <Bars
          values={master}
          muted={rendered === null}
          playing={playing}
          loop={looping}
          durationMs={totalMs}
          className="bars-master"
          color={rendered === null ? undefined : layerColor(0, 0.74, 0.12)}
        />
        <span className="mono strip-meta">{ms(measuredMs)}</span>
      </div>

      {lanes.length < 2 ? null : (
        <div className="lanes">
          {lanes.map((lane, index) => (
            <div className="strip strip-lane" key={lane.name}>
              <span className="mono strip-label" style={{ color: layerColor(index) }}>
                {lane.name}
              </span>
              <Bars
                values={lane.values}
                playing={playing}
                loop={looping}
                durationMs={totalMs}
                className="bars-lane"
                color={layerColor(index)}
              />
              <span className="mono strip-meta">
                {lane.onsetMs >= 1 ? `+${String(Math.round(lane.onsetMs))} ms · ` : ''}
                {ms(lane.durationMs)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="transport">
        <button type="button" className="primary big" onClick={onPlay} disabled={ast === null}>
          {playing ? '❚❚' : '▶'} {t('sound.play')}
        </button>
        <button
          type="button"
          className={looping ? 'on' : ''}
          aria-pressed={looping}
          onClick={onLoop}
          disabled={rendered === null}
          title={t('sound.loopTitle')}
        >
          ↻ {t('sound.loop')}
        </button>
        <div className="spacer" />
        {/* Everything past here is what you do with a sound that is finished — see the
            header on why the row has two ends. */}
        <FormatMenu
          formatId={formatId}
          onFormat={onFormat}
          onDownload={onDownload}
          disabled={ast === null && rendered === null}
          buffer={rendered?.buffer ?? null}
        />
        {/* Where Trash used to be. Same slot, opposite sign: the studio is where a
            recipe earns a star, because this is the screen you are on when you decide
            it is good. */}
        <button
          type="button"
          className={`star-button${favorite ? ' on' : ''}`}
          onClick={onFavorite}
          aria-pressed={favorite}
          title={t(favorite ? 'card.unfavorite' : 'card.favorite')}
        >
          {favorite ? '★' : '☆'} {t('sound.favorite')}
        </button>
        <button type="button" className="violet exit-button" onClick={onShare} disabled={ast === null}>
          {t('sound.share')}
        </button>
      </div>
    </>
  );
}

/**
 * Render every layer of `ast` alone and measure it.
 *
 * Cancelled on change rather than awaited: an editor produces a new AST per keystroke
 * and a stale lane arriving after a newer one would make the picture flicker between
 * two versions of the recipe. The cache in `lib/layers.ts` means an unchanged layer
 * costs nothing on the way through.
 */
function useLanes(ast: SoundAST | null, seed: number): readonly Lane[] {
  const [lanes, setLanes] = useState<readonly Lane[]>([]);

  useEffect(() => {
    if (ast === null || ast.layers.length < 2) {
      setLanes([]);
      return;
    }
    let cancelled = false;
    void renderLayers(ast, seed).then((results) => {
      if (cancelled) return;
      setLanes(
        results.flatMap((result, index) => {
          const layer = ast.layers[index];
          if (layer === undefined) return [];
          if (result === null) {
            return [{ name: layer.name, values: ghostBars(layer.name, LANE_BARS), onsetMs: 0, durationMs: 0 }];
          }
          const signal = signalOf(result.buffer);
          const onset = onsetIndex(signal);
          const metrics = metricsOf(signal, onset);
          return [
            {
              name: layer.name,
              values: bars(result.buffer, LANE_BARS),
              onsetMs: (onset / signal.sampleRate) * 1000,
              durationMs: metrics.durationMs,
            },
          ];
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [ast, seed]);

  return lanes;
}
