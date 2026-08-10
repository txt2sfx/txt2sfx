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
 * ## The chips are the brief, not a preset
 *
 * They used to be six palettes, and pressing one replaced the whole prompt and pinned the
 * tempo, the key and the lane list — so "boss fight" typed under `menu-drift` composed
 * `menu-drift`, and every take of every session came from one of six sentences. They are
 * *fragments* now: pressing one adds its words to the brief as a tag with an ×, pressing
 * it again takes them back out, and any number of them combine. The numbers the seeded
 * composer needs are derived from the resulting text (`paletteFor`), which means the words
 * can always argue with them — which is the property the chips never had.
 *
 * Nothing is armed and nothing is exclusive, so there is no selected state to explain:
 * what will be composed is visible in the box, in the order it was assembled.
 *
 * @packageDocumentation
 */

import { useState } from 'react';
import { encodeWav } from '@txt2sfx/core';
import { FormatMenu } from '../components/FormatMenu.js';
import { IconPause, IconPlay } from '../components/Icons.js';
import { LoopProgress, LoopSkeleton } from '../components/LoopProgress.js';
import { LoopTimeline } from '../components/LoopTimeline.js';
import { HUE } from '../lib/design.js';
import { LOOP_FORMATS, save, type Format } from '../lib/download.js';
import { ms } from '../lib/format.js';
import { useI18n, type Key } from '../lib/i18n.js';
import {
  LANE_HUES,
  LOOP_TAGS,
  TAG_GROUPS,
  loopSeconds,
  proposals,
  stepCount,
  type TagGroup,
} from '../lib/loop.js';
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
 * A hue per row of chips.
 *
 * From the lane palette, as the preset chips were — but keyed on the *group* rather than
 * on the chip's position, because the rows are what the eye groups by. A fragment's colour
 * therefore never changes when the table gains a row above it.
 */
const GROUP_HUE: Readonly<Record<TagGroup, number>> = {
  mood: LANE_HUES[4] ?? 340,
  motion: LANE_HUES[0] ?? 195,
  texture: LANE_HUES[7] ?? 265,
  kit: LANE_HUES[1] ?? 150,
  place: LANE_HUES[3] ?? 80,
};

/** What each row is called. A table rather than a built key, so the dictionary type checks. */
const GROUP_LABEL: Readonly<Record<TagGroup, Key>> = {
  mood: 'loop.group.mood',
  motion: 'loop.group.motion',
  texture: 'loop.group.texture',
  kit: 'loop.group.kit',
  place: 'loop.group.place',
};

/** Which row a fragment belongs to, for the chip's colour. */
function hueOf(id: string): number {
  return GROUP_HUE[LOOP_TAGS.find((tag) => tag.id === id)?.group ?? 'motion'] ?? 195;
}

export function Loop({ state, seed, formatId, onFormat, onStatus }: LoopProps): React.JSX.Element {
  const { t } = useI18n();
  const [stemming, setStemming] = useState(false);
  const track = state.selected;
  const hue = state.mode === 'new' ? HUE.recipe : HUE.model;
  const busy = state.composing !== null;
  /**
   * Whether the card on screen is still the *previous* soundtrack.
   *
   * A new track has no id until the model has answered and the score has been read, so
   * `trackId` being empty is exactly the window in which the card would be showing
   * something the user asked to have replaced. That window gets the skeleton. Adding lanes
   * never does: those lanes are frozen, still audible, and the reason the mode exists.
   */
  const ahead = state.composing !== null && state.composing.verb === 'compose' && state.composing.trackId !== track?.id;
  /* Lanes of the new track that are staged but not yet voiced, drawn as ghost rows so the
     timeline does not grow under the reader's eyes one row at a time. */
  const pending =
    state.composing !== null && state.composing.trackId === track?.id
      ? Math.max(0, state.composing.total - state.lanes.length)
      : 0;

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
              /* An empty box, fragments included. "New soundtrack" that left five chips in
                 the brief would be a new soundtrack of the last one. */
              state.clearTags();
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
              {/* The fragments sit *inside* the box, before the text, in the order they
                  were added: what is on screen is the brief that will be sent. */}
              {state.tags.map((id) => (
                <span className="tag mono" key={id} style={{ ['--hue' as string]: String(hueOf(id)) }}>
                  {id}
                  <button
                    type="button"
                    className="tag-drop"
                    title={t('loop.dropTag', { tag: id })}
                    aria-label={t('loop.dropTag', { tag: id })}
                    onClick={() => state.toggleTag(id)}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                name="loop-prompt"
                className="mono"
                value={state.prompt}
                placeholder={t(
                  state.mode === 'add'
                    ? 'loop.placeholderAdd'
                    : state.tags.length === 0
                      ? 'loop.placeholderNew'
                      : 'loop.placeholderMore',
                )}
                aria-label={t('loop.describeAria')}
                onChange={(event) => state.setPrompt(event.target.value)}
              />
              {/* Disabled on an empty brief in `New track` only. There is no palette behind
                  the button any more, so a press with nothing in the box would be a request
                  the screen invented — and `Add tracks` genuinely has a default ("answer
                  what is already playing"), which is why it stays pressable. */}
              <button
                type="submit"
                className="hue-button"
                disabled={busy || (state.mode === 'new' && state.brief === '')}
              >
                {busy ? <span className="spinner" aria-hidden="true" /> : null}
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
            {/* The hint is different in kind, not in wording, depending on who composes:
                with a model the prompt is read as a brief, and with none it moves three
                knobs through an English keyword table. Promising the first while doing
                the second is the one thing this line must never do. */}
            <span className="hint">
              {state.model === null
                ? t(state.mode === 'new' ? 'loop.hintNew' : 'loop.hintAdd')
                : t(state.mode === 'new' ? 'loop.hintNewModel' : 'loop.hintAddModel', { model: state.model })}
            </span>
          </div>

          {/* One row per question a brief answers. Grouped rather than one cloud of
              thirty, because a row the reader skipped is a question they did not answer. */}
          <div className="tag-rows">
            {TAG_GROUPS.map((group) => (
              <div className="tag-row" key={group}>
                <span className="mono tag-row-label">{t(GROUP_LABEL[group])}</span>
                {LOOP_TAGS.filter((tag) => tag.group === group).map((tag) => (
                  <button
                    type="button"
                    key={tag.id}
                    className={`chip cat-chip${state.tags.includes(tag.id) ? ' selected' : ''}`}
                    style={{ ['--hue' as string]: String(GROUP_HUE[group]) }}
                    /* The phrase it will write, so a chip is never a mystery word: the
                       tooltip is the text, and the text is what the model reads. */
                    title={tag.phrase}
                    aria-pressed={state.tags.includes(tag.id)}
                    onClick={() => state.toggleTag(tag.id)}
                  >
                    {tag.id}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {ahead ? (
            <LoopSkeleton composing={state.composing} mixing={state.mixing} withModel={state.model !== null} />
          ) : null}

          {track === null || ahead ? null : (
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
                  {' · '}
                  {t(track.composedBy === 'model' ? 'loop.authorModel' : 'loop.authorSeed')}
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
                  {state.playing ? <IconPause size={12} /> : <IconPlay size={12} />}{' '}
                  {t(state.playing ? 'loop.stop' : 'loop.play')}
                </button>
                <span className="mono faint">{t('loop.seamless')}</span>
                {/* The dev-only A/B against a General MIDI bank. Absent in a built page and on
                    any machine with no bank, because `bankFound` is null there — a toggle that
                    produced silence would be worse than no toggle. It says what it is switching
                    to by name, and `lib/gm.ts` says why it can never be the thing that
                    exports. */}
                {state.bankFound === null ? null : (
                  <button
                    type="button"
                    className={state.bank ? 'on' : ''}
                    title={`${state.bankFound.name} — ${state.bankFound.path}`}
                    onClick={() => state.setBank(!state.bank)}
                  >
                    {t(state.bank ? 'loop.bankOn' : 'loop.bankOff')}
                  </button>
                )}
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
                pending={pending}
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

              {/* The same phase list the skeleton carries — the lanes exist now, so it sits
                  under them instead of standing in for them. It disappears of its own
                  accord when nothing is running, mixdown included. */}
              <LoopProgress composing={state.composing} mixing={state.mixing} withModel={state.model !== null} />

              {/* Who composed this, and why it was not the model when it was not. A
                  soundtrack that quietly came from the PRNG after a model was asked for
                  would put every later one under suspicion. */}
              {state.note === null ? null : <p className="loop-facts faint">{state.note}</p>}

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
