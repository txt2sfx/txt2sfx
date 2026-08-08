/**
 * NeurosLoop — a game soundtrack, made of the same parts as a sound effect.
 *
 * ## Why this is a third screen and not a tab of the studio
 *
 * The studio is built around one recipe: an editor, a validator, a slider per `~` slot,
 * one waveform. A soundtrack has none of those affordances and needs a different set —
 * lanes, bars, a transport that never stops, a mute per instrument. Putting both in one
 * screen would mean half the panels are dead whichever mode you are in, which is exactly
 * the problem `App.tsx` describes the old single-screen playground having.
 *
 * What the two screens *do* share is everything below the interface. A lane's note is a
 * soundline recipe, compiled by the same compiler, rendered by the same renderer, and
 * exported by the same `codegen`. That is why the tab belongs in this application at all
 * rather than in a different one: the claim being demonstrated is unchanged — describe
 * it, get code that plays it — only the length of what you describe has changed.
 *
 * ## Two prompts, one box
 *
 * `New track` composes from scratch; `Add tracks` leaves everything that exists frozen
 * and proposes one or two lanes to audition, each with keep / retry / discard on the row
 * itself. Splitting them is what stops the second use of the box from silently throwing
 * away the arrangement the first one produced — the mistake is one click and the loss is
 * everything on screen.
 *
 * The mode owns the accent hue (cyan for new, amber for adding), so the prompt bar, its
 * button and the mode tabs all say which of the two is armed before it is pressed.
 *
 * @packageDocumentation
 */

import { useState } from 'react';
import { encodeWav } from '@txt2sfx/core';
import { FormatMenu } from '../components/FormatMenu.js';
import { LoopTimeline } from '../components/LoopTimeline.js';
import { HUE } from '../lib/design.js';
import { LOOP_FORMATS, save, type Format } from '../lib/download.js';
import { ms } from '../lib/format.js';
import { useI18n, type Key } from '../lib/i18n.js';
import { LANE_HUES, LOOP_PRESETS, loopSeconds, proposals, stepCount } from '../lib/loop.js';
import { downloadLoop } from '../lib/loop-export.js';
import { renderStems } from '../lib/loop-render.js';
import type { LoopState } from '../lib/useLoop.js';

export interface LoopProps {
  readonly state: LoopState;
  readonly seed: number;
  readonly formatId: string;
  readonly onFormat: (id: string) => void;
  readonly onStatus: (status: string) => void;
}

/**
 * What each lane is called while it is being composed.
 *
 * One line per lane rather than a generic "working…", because these are the seconds in
 * which the user finds out whether the thing being built is the thing they asked for,
 * and "winding the arp" answers that where a spinner does not.
 */
const LANE_MESSAGE: Readonly<Record<string, Key>> = {
  drums: 'loop.msg.drums',
  perc: 'loop.msg.perc',
  bass: 'loop.msg.bass',
  chords: 'loop.msg.chords',
  keys: 'loop.msg.keys',
  stabs: 'loop.msg.stabs',
  lead: 'loop.msg.lead',
  arp: 'loop.msg.arp',
  bells: 'loop.msg.bells',
  fx: 'loop.msg.fx',
  pads: 'loop.msg.pads',
  strings: 'loop.msg.strings',
  choir: 'loop.msg.choir',
  drone: 'loop.msg.drone',
  air: 'loop.msg.air',
};

export function Loop({ state, seed, formatId, onFormat, onStatus }: LoopProps): React.JSX.Element {
  const { t } = useI18n();
  const [stemming, setStemming] = useState(false);
  const track = state.selected;
  const hue = state.mode === 'new' ? HUE.recipe : HUE.model;
  const busy = state.composing !== null;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    state.run();
  };

  /**
   * Every lane as its own file.
   *
   * Sequential saves rather than a zip: a zip means a dependency and a second thing that
   * can be wrong about its own contents, and a handful of `save()` calls is what the
   * browser is for. Reported as a count, because a browser that blocks the second file
   * of a multi-file download does it silently.
   */
  const stems = async (): Promise<void> => {
    if (track === null || stemming) return;
    setStemming(true);
    try {
      const rendered = await renderStems(track, seed);
      for (const { lane, render } of rendered) {
        const bytes = encodeWav(render.buffer, { bitDepth: 16 });
        save(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'audio/wav' }), `${track.name}-${lane}.wav`);
      }
      onStatus(t('loop.stemsSaved', { count: rendered.length, name: track.name }));
    } catch (error: unknown) {
      onStatus(String(error));
    } finally {
      setStemming(false);
    }
  };

  const exportLoop = async (format: Format): Promise<void> => {
    if (track === null) return;
    onStatus(await downloadLoop(track, format, { buffer: state.render?.buffer ?? null, seed }));
  };

  return (
    <div className="screen screen-loop">
      <aside className="rail">
        <div className="rail-top">
          <button
            type="button"
            className="primary block"
            onClick={() => {
              state.setMode('new');
              state.setPrompt('');
            }}
          >
            <span className="plus">+</span>
            {t('loop.new')}
          </button>
        </div>

        <div className="rail-list">
          <div className="rail-group">
            <div className="rail-group-head" style={{ ['--hue' as string]: String(HUE.recipe) }}>
              <span className="mono rail-group-label">{t('loop.soundtracks')}</span>
              <div className="spacer" />
              <span className="mono faint">{state.tracks.length}</span>
            </div>
            {state.tracks.map((entry) => (
              <div
                key={entry.id}
                role="button"
                tabIndex={0}
                className={`rail-row${entry.id === track?.id ? ' selected' : ''}`}
                style={{ ['--hue' as string]: String(HUE.recipe) }}
                onClick={() => state.select(entry.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') state.select(entry.id);
                }}
              >
                <span className="rail-name">{entry.name}</span>
                <span className="mono faint rail-meta">{t('loop.bpm', { bpm: entry.bpm })}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="loop-main">
        <div className="column" style={{ ['--hue' as string]: String(hue) }}>
          <form className="prompt-row" onSubmit={submit}>
            <div className="input-shell hue">
              <span className="mono caret">&gt;</span>
              <input
                type="text"
                name="loop-prompt"
                className="mono"
                value={state.prompt}
                placeholder={t(state.mode === 'new' ? 'loop.placeholderNew' : 'loop.placeholderAdd')}
                aria-label={t('loop.describeAria')}
                onChange={(event) => state.setPrompt(event.target.value)}
              />
              <button type="submit" className="hue-button" disabled={busy}>
                {busy
                  ? t(state.composing?.verb === 'extend' ? 'loop.adding' : 'loop.composing')
                  : t(state.mode === 'new' ? 'loop.compose' : 'loop.add')}
              </button>
            </div>
          </form>

          <div className="views">
            <div className="segmented small">
              <button
                type="button"
                className={state.mode === 'new' ? 'selected cyan' : ''}
                onClick={() => state.setMode('new')}
              >
                {t('loop.modeNew')}
              </button>
              <button
                type="button"
                className={state.mode === 'add' ? 'selected amber' : ''}
                onClick={() => state.setMode('add')}
              >
                {t('loop.modeAdd')}
              </button>
            </div>
            <span className="hint">{t(state.mode === 'new' ? 'loop.hintNew' : 'loop.hintAdd')}</span>
          </div>

          <div className="presets">
            <span className="mono presets-label">{t('loop.presets')}</span>
            {LOOP_PRESETS.map((preset, index) => (
              <button
                type="button"
                key={preset.id}
                className={`chip cat-chip${state.preset === preset.id ? ' selected' : ''}`}
                /* The lane palette, reused: a preset is a set of lanes, so colouring the
                   chips from the same table means the first lane of `boss-fight` is the
                   colour its chip was. */
                style={{ ['--hue' as string]: String(LANE_HUES[index % LANE_HUES.length] ?? 195) }}
                onClick={() => state.pickPreset(preset.id)}
              >
                {preset.id}
              </button>
            ))}
          </div>

          {track === null ? null : (
            <section className="loop-card">
              <div className="loop-head">
                <h2 className="mono">{track.name}</h2>
                <span className="mono cyan">
                  {track.key} · {t('loop.bpm', { bpm: track.bpm })}
                </span>
                <span className="mono faint">
                  {t('loop.meta', {
                    bars: track.bars,
                    length: ms(loopSeconds(track) * 1000),
                    lanes: track.lanes.length,
                  })}
                </span>
              </div>
              <p className="loop-prompt">“{track.prompt}”</p>

              <div className="transport">
                <button
                  type="button"
                  className={state.playing ? 'big on' : 'big primary'}
                  disabled={state.render === null}
                  onClick={state.play}
                >
                  {state.playing ? `❚❚ ${t('loop.stop')}` : `▶ ${t('loop.play')}`}
                </button>
                <span className="mono faint">{t('loop.seamless')}</span>
                <div className="spacer" />
                {/* Never disabled. Three of the five entries need no mixdown at all, and
                    the two that do already answer "there is nothing rendered to export"
                    in a sentence — which is more use than a button that cannot be
                    pressed and does not say why. */}
                <FormatMenu formatId={formatId} onFormat={onFormat} formats={LOOP_FORMATS} onDownload={exportLoop} />
                <button type="button" onClick={() => void stems()} disabled={stemming || state.render === null}>
                  {stemming ? <span className="spinner" /> : null}
                  {t('loop.stems', { count: track.lanes.length })}
                </button>
              </div>

              <LoopTimeline
                lanes={state.lanes}
                bars={track.bars}
                steps={stepCount(track)}
                loopMs={loopSeconds(track) * 1000}
                playing={state.playing}
                muted={state.muted}
                onMute={state.toggleMute}
                onKeep={state.keep}
                onRetry={state.retry}
                onDrop={state.drop}
              />

              {state.composing === null ? null : (
                <div className="composing">
                  <span
                    className="dot dot-breathing"
                    style={{ color: `oklch(0.8 0.12 ${String(state.composing.hue)})` }}
                  />
                  <span className="mono">
                    {t(LANE_MESSAGE[state.composing.lane] ?? 'loop.msg.generic', { lane: state.composing.lane })}
                  </span>
                  <div className="spacer" />
                  <span className="mono faint">
                    {t('loop.progress', { done: state.composing.done, total: state.composing.total })}
                  </span>
                </div>
              )}

              {/* The three facts about the mixdown that a listener cannot derive: how many
                  distinct recipes it is made of, how many times they fire, and whether the
                  sum had to be turned down to fit. The last one is the reason this line
                  exists — headroom applied silently is a level change nobody can act on. */}
              {state.render === null ? null : (
                <p className="loop-facts mono faint">
                  {t('loop.facts', {
                    voices: state.render.voices,
                    notes: state.render.notes,
                    peak: state.render.peak.toFixed(2),
                  })}
                  {state.render.headroom < 1
                    ? ` · ${t('loop.headroom', { db: (20 * Math.log10(state.render.headroom)).toFixed(1) })}`
                    : ''}
                </p>
              )}

              {state.error === null ? null : <p className="loop-facts bad">{state.error}</p>}

              {state.mode === 'add' && proposals(track).length === 0 && !busy ? (
                <p className="hint">{t('loop.noSpare')}</p>
              ) : null}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
