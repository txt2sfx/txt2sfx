/**
 * NeurosLoop's state, as a hook.
 *
 * ## Two composers behind one button
 *
 * Pressing Compose asks the connected model for a score (`lib/loop-agent.ts` runs that
 * conversation, `lib/score.ts` judges what comes back) and falls back to the seeded
 * composer in `lib/loop.ts` when there is no model, or when three trips could not produce
 * a score that passes. Both produce the same {@link LoopTrack}, so everything below this
 * hook — the voices, the mixdown, the timeline, both exports — never learns which ran.
 *
 * The screen is told, though. {@link LoopState.note} carries the sentence, and a fallback
 * says *why* it fell back: somebody who asked a model for a soundtrack and quietly got a
 * PRNG one would have every later composition under suspicion.
 *
 * ## Why the composing indicator is not a timer
 *
 * The obvious way to build the "agent is laying the drum grid…" line is a `setInterval`
 * that reveals a lane every 800 ms. It looks identical and it is a lie: a progress
 * indicator that is not measuring anything teaches the user to distrust every other one
 * in the application.
 *
 * So lanes are revealed as they are *actually finished*. Composing a lane is two real
 * pieces of work — write its notes, then render every distinct voice it needs — and the
 * second one takes real time (a sixteen-bar hat lane is three or four offline renders,
 * a pad lane is six). A lane appears the moment its audio exists, which means the line
 * above the timeline is a measurement and the whole thing gets faster on a faster
 * machine, as progress indicators should.
 *
 * The model added a phase in front of that and it obeys the same rule: `writing` is true
 * exactly while a request is in flight, which is a real pending promise and not a clock.
 * It is also why the *previous* arrangement stays on screen and audible while the model
 * writes — there is nothing yet to replace it with, and blanking the timeline for the
 * five seconds of a round trip would throw away the thing the user is comparing against.
 *
 * ## Why the mixdown is state and not a memo
 *
 * The buffer is what plays and what exports, so the two can never disagree — that is the
 * argument in `lib/loop-render.ts` for re-mixing on mute rather than gating playback.
 * A `useMemo` over an async render would let a stale buffer be exported while a fresh
 * one was still in flight; an explicit generation counter makes a superseded render
 * discard itself instead.
 *
 * ## Nothing here is persisted, still
 *
 * A seeded soundtrack costs a hash and some arithmetic: preset, prompt and salt reproduce
 * it exactly. A model-composed one does not — it cost a model call and is reproducible by
 * nothing — which by the playground's own rule (`lib/session.ts`) makes it work that
 * should survive a reload. It does not yet. What makes that a small change rather than a
 * schema is that the score text is already kept on every lane it wrote: restoring a track
 * is parsing it back, not inventing a storage format.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LLMProvider } from '@txt2sfx/agent';
import type { ProviderKind } from './agent.js';
import { playBuffer, type Playback } from './engine.js';
import { t } from './i18n.js';
import {
  LANE_HUES,
  LOOP_PRESETS,
  composeLane,
  composeTrack,
  presetById,
  proposals,
  type LoopLane,
  type LoopTrack,
} from './loop.js';
import { composeRequest, composeScore, extendRequest, retryRequest } from './loop-agent.js';
import { laneFromScore, trackFromScore } from './score.js';
import { primeLane, renderLoop, type LoopRender } from './loop-render.js';

/** Which prompt the box is writing: a whole new track, or lanes for the current one. */
export type LoopMode = 'new' | 'add';

/** What the composing indicator reports while a track is being built. */
export interface Composing {
  /** Empty while the model is writing, because the track does not exist yet. */
  readonly trackId: string;
  /** Lanes finished so far. Lanes past this index are not on screen yet. */
  readonly done: number;
  readonly total: number;
  /** The lane being worked on, for the message and the indicator's colour. */
  readonly lane: string;
  /** The model's own description of that lane, when a model wrote it. */
  readonly caption?: string;
  readonly hue: number;
  /** `compose` for a new track, `extend` for added lanes. */
  readonly verb: 'compose' | 'extend';
  /** True exactly while a request to the model is in flight. */
  readonly writing: boolean;
}

/** Everything the screen reads and every action it can take. */
export interface LoopState {
  readonly tracks: readonly LoopTrack[];
  readonly selected: LoopTrack | null;
  readonly select: (id: string) => void;

  readonly mode: LoopMode;
  readonly setMode: (mode: LoopMode) => void;
  readonly preset: string;
  readonly pickPreset: (id: string) => void;
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;

  /** Compose a new track, or add lanes to the selected one, per {@link mode}. */
  readonly run: () => void;
  readonly composing: Composing | null;
  /** Lanes of the selected track that are on screen right now. */
  readonly lanes: readonly LoopLane[];

  /** Which model will compose, or `null` when the seeded composer will. */
  readonly model: ProviderKind | null;
  /** What just happened — who composed, or why the fallback ran. */
  readonly note: string | null;

  readonly muted: ReadonlySet<string>;
  readonly toggleMute: (lane: string) => void;
  readonly keep: (lane: string) => void;
  readonly retry: (lane: string) => void;
  readonly drop: (lane: string) => void;

  readonly render: LoopRender | null;
  readonly playing: boolean;
  readonly play: () => void;
  readonly stop: () => void;

  /** Set when a mixdown failed, as a sentence for the warning strip. */
  readonly error: string | null;
}

/** What the hook needs from the app around it. */
export interface LoopOptions {
  readonly seed: number;
  /** Who would answer, for the label on the button. `null` means nobody. */
  readonly model: ProviderKind | null;
  /**
   * Built per press rather than handed over once: a key can be pasted while this screen
   * is open, and a provider made at mount would carry the key the tab started with.
   */
  readonly provider: () => LLMProvider | null;
}

/** The three soundtracks a first visit opens on, so the screen is never empty. */
function initialTracks(): readonly LoopTrack[] {
  return [
    ['lt-overworld', 'overworld-run'],
    ['lt-market', 'night-market'],
    ['lt-cave', 'cave-ambience'],
  ].map(([id = '', preset = '']) => {
    const chosen = presetById(preset);
    return composeTrack(id, chosen, chosen.prompt, chosen.id, 'seed');
  });
}

export function useLoop(options: LoopOptions): LoopState {
  const [tracks, setTracks] = useState<readonly LoopTrack[]>(initialTracks);
  const [selectedId, setSelectedId] = useState('lt-overworld');
  const [mode, setMode] = useState<LoopMode>('new');
  const [preset, setPreset] = useState(LOOP_PRESETS[0]?.id ?? 'overworld-run');
  const [prompt, setPrompt] = useState(LOOP_PRESETS[0]?.prompt ?? '');
  const [composing, setComposing] = useState<Composing | null>(null);
  const [muted, setMuted] = useState<ReadonlySet<string>>(() => new Set());
  const [render, setRender] = useState<LoopRender | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const playback = useRef<Playback | null>(null);
  /** Bumped by every state change that invalidates the mix; a late render checks it. */
  const generation = useRef(0);
  /** The model call in flight, so leaving the screen does not leave a request behind. */
  const abort = useRef<AbortController | null>(null);
  /* Read at press time, never closed over: the key and the attached agent both change
     while this screen is open. Same shape, same reason, as `useGenerate`'s `live`. */
  const live = useRef(options);
  live.current = options;

  const selected = tracks.find((track) => track.id === selectedId) ?? tracks[0] ?? null;

  const stop = useCallback(() => {
    playback.current?.stop();
    playback.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => stop, [stop]);
  useEffect(() => () => abort.current?.abort(), []);

  /* Mix whenever the arrangement, the mute set or the seed changes. The counter is what
     makes a superseded render harmless: a mute toggled twice in a second starts two
     mixdowns, and only the second one is allowed to reach the screen. */
  useEffect(() => {
    if (selected === null || composing !== null) return;
    const mine = ++generation.current;
    let cancelled = false;
    void renderLoop(selected, { seed: options.seed, muted })
      .then((result) => {
        if (cancelled || mine !== generation.current) return;
        setRender(result);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled || mine !== generation.current) return;
        setRender(null);
        setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, muted, options.seed, composing]);

  /* A new mixdown means whatever is sounding is the previous arrangement. Stopping is
     the honest response — restarting mid-phrase would put the playhead somewhere the
     sweep animation is not. */
  useEffect(() => {
    stop();
  }, [selectedId, stop]);

  /**
   * Compose lanes one at a time, revealing each when its audio exists.
   *
   * `staged` is the list of lane names to build; `base` is how many lanes of the track
   * are already on screen, which is what makes this serve both Compose (base 0) and
   * Add tracks (base = the lanes already kept).
   */
  const stage = useCallback(
    async (track: LoopTrack, staged: readonly string[], base: number, verb: 'compose' | 'extend'): Promise<void> => {
      for (let index = 0; index < staged.length; index++) {
        const name = staged[index] ?? '';
        const lane = track.lanes[base + index];
        if (lane === undefined) continue;
        setComposing({
          trackId: track.id,
          done: base + index,
          total: base + staged.length,
          lane: name,
          ...(lane.caption === undefined ? {} : { caption: lane.caption }),
          hue: lane.hue,
          verb,
          writing: false,
        });
        /* Rendering the lane's voices now is what makes the reveal a measurement: the
           mixdown that follows finds them cached, so nothing is rendered twice. */
        await primeLane(track, name, live.current.seed).catch(() => undefined);
      }
      setComposing(null);
    },
    [],
  );

  /** The indicator's first phase: a request is out and nothing exists yet. */
  const startWriting = useCallback((verb: 'compose' | 'extend', lane = ''): AbortController => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setNote(null);
    setComposing({ trackId: '', done: 0, total: 0, lane, hue: LANE_HUES[0] ?? 195, verb, writing: true });
    return controller;
  }, []);

  const compose = useCallback(() => {
    if (composing !== null) return;
    stop();
    const chosen = presetById(preset);
    const text = prompt.trim() === '' ? chosen.prompt : prompt.trim();
    const id = `lt${String(tracks.length)}-${String(hashPrompt(text + chosen.id))}`;
    const takes = tracks.filter((track) => track.preset === chosen.id).length + 1;
    const salt = String(takes);

    /** The seeded composer, used with no model and after a model that could not deliver. */
    const seeded = (reason: string | null): void => {
      const name = takes > 1 ? `${chosen.id} · take ${String(takes)}` : chosen.id;
      const track = composeTrack(id, chosen, text, name, salt);
      setTracks((current) => [track, ...current]);
      setSelectedId(id);
      setRender(null);
      setNote(reason === null ? t('loop.bySeed') : t('loop.fellBack', { reason }));
      void stage(
        track,
        track.lanes.map((lane) => lane.name),
        0,
        'compose',
      );
    };

    const provider = live.current.provider();
    if (provider === null) {
      seeded(null);
      return;
    }

    const controller = startWriting('compose');
    void composeScore({
      provider,
      request: composeRequest(text, chosen),
      context: { mode: 'new', bars: chosen.bars, existing: [] },
      signal: controller.signal,
    })
      .then((composed) => {
        if (controller.signal.aborted) return;
        const track = trackFromScore(composed.score, { id, preset: chosen.id, prompt: text, salt });
        setTracks((current) => [track, ...current]);
        setSelectedId(id);
        setRender(null);
        setNote(
          t('loop.byModel', { model: provider.model, attempts: composed.attempts }) +
            (composed.warnings.length === 0 ? '' : ` · ${composed.warnings[0]?.hint ?? ''}`),
        );
        void stage(
          track,
          track.lanes.map((lane) => lane.name),
          0,
          'compose',
        );
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) {
          setComposing(null);
          return;
        }
        seeded(failure instanceof Error ? failure.message : String(failure));
      });
  }, [composing, preset, prompt, startWriting, stop, stage, tracks]);

  const extend = useCallback(() => {
    if (composing !== null || selected === null) return;
    stop();
    const base = selected.lanes.length;

    /** Append lanes to the selected track and stage exactly those. */
    const append = (added: readonly LoopLane[]): void => {
      if (added.length === 0) return;
      const next: LoopTrack = { ...selected, lanes: [...selected.lanes, ...added] };
      setTracks((current) => current.map((track) => (track.id === next.id ? next : track)));
      void stage(
        next,
        added.map((lane) => lane.name),
        base,
        'extend',
      );
    };

    const seeded = (reason: string | null): void => {
      const wanted = proposals(selected);
      if (wanted.length === 0) {
        setComposing(null);
        setNote(reason === null ? null : t('loop.fellBack', { reason }));
        return;
      }
      setNote(reason === null ? null : t('loop.fellBack', { reason }));
      append(
        wanted.map((name, offset) => ({
          ...composeLane(selected, name, base + offset, `add-${String(base + offset)}-${prompt}`),
          hue: LANE_HUES[(base + offset) % LANE_HUES.length] ?? 195,
          proposed: true as const,
        })),
      );
    };

    const provider = live.current.provider();
    if (provider === null) {
      seeded(null);
      return;
    }

    const controller = startWriting('extend');
    void composeScore({
      provider,
      request: extendRequest(prompt, selected),
      context: { mode: 'add', bars: selected.bars, existing: selected.lanes.map((lane) => lane.name) },
      signal: controller.signal,
    })
      .then((composed) => {
        if (controller.signal.aborted) return;
        append(
          composed.score.lanes.slice(0, 2).map((lane, offset) => ({
            ...laneFromScore(lane, {
              key: selected.key,
              bars: selected.bars,
              index: base + offset,
              salt: `add-${String(base + offset)}-${prompt}`,
            }),
            proposed: true as const,
          })),
        );
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) {
          setComposing(null);
          return;
        }
        seeded(failure instanceof Error ? failure.message : String(failure));
      });
  }, [composing, prompt, selected, startWriting, stop, stage]);

  const run = useCallback(() => {
    if (mode === 'new') compose();
    else extend();
  }, [compose, extend, mode]);

  const editLane = useCallback(
    (name: string, edit: (lane: LoopLane, track: LoopTrack) => LoopLane | null) => {
      setTracks((current) =>
        current.map((track) => {
          if (track.id !== selectedId) return track;
          const lanes = track.lanes
            .map((lane) => (lane.name === name ? edit(lane, track) : lane))
            .filter((lane): lane is LoopLane => lane !== null);
          return { ...track, lanes };
        }),
      );
    },
    [selectedId],
  );

  /**
   * ↻ on a lane: a different take of the same part.
   *
   * Through the model when the model wrote it, because re-rolling a seeded lane inside a
   * model-composed track would answer a request for *different material* with material
   * from a different composer. With no model, or on a seeded lane, it is the old
   * re-roll — same salt discipline, same reproducibility.
   */
  const retry = useCallback(
    (name: string) => {
      if (composing !== null || selected === null) return;
      const existing = selected.lanes.find((lane) => lane.name === name);
      const provider = live.current.provider();

      const reroll = (): void => {
        editLane(name, (lane, track) => ({
          ...composeLane(track, name, track.lanes.indexOf(lane), `${lane.salt}+`),
          hue: lane.hue,
          ...(lane.proposed === true ? { proposed: true as const } : {}),
        }));
      };

      if (provider === null || existing?.score === undefined) {
        reroll();
        return;
      }

      const controller = startWriting('extend', name);
      void composeScore({
        provider,
        request: retryRequest(name, selected),
        context: {
          mode: 'add',
          bars: selected.bars,
          existing: selected.lanes.filter((lane) => lane.name !== name).map((lane) => lane.name),
        },
        signal: controller.signal,
      })
        .then((composed) => {
          if (controller.signal.aborted) return;
          const written = composed.score.lanes.find((lane) => lane.name === name) ?? composed.score.lanes[0];
          if (written === undefined) throw new Error('the model returned no lane');
          const index = selected.lanes.findIndex((lane) => lane.name === name);
          const replacement = laneFromScore(written, {
            key: selected.key,
            bars: selected.bars,
            index: index < 0 ? 0 : index,
            salt: `${existing.salt}+`,
          });
          editLane(name, (lane) => ({
            ...replacement,
            name,
            hue: lane.hue,
            ...(lane.proposed === true ? { proposed: true as const } : {}),
          }));
          setComposing(null);
        })
        .catch((failure: unknown) => {
          setComposing(null);
          if (controller.signal.aborted) return;
          setNote(t('loop.fellBack', { reason: failure instanceof Error ? failure.message : String(failure) }));
          reroll();
        });
    },
    [composing, editLane, selected, startWriting],
  );

  return {
    tracks,
    selected,
    select: setSelectedId,
    mode,
    setMode,
    preset,
    pickPreset: (id) => {
      setPreset(id);
      setPrompt(presetById(id).prompt);
    },
    prompt,
    setPrompt,
    run,
    composing,
    /* While a track is being composed the screen shows only what is finished. The
       unfinished lanes exist in state — they have to, the staging walks them — but
       showing an empty row for a lane nobody has heard yet would be the same lie as
       the timer. A track being *written* has no id yet, so the previous arrangement
       stays whole until there is something to replace it with. */
    lanes:
      selected === null
        ? []
        : composing !== null && composing.trackId === selected.id
          ? selected.lanes.slice(0, composing.done)
          : selected.lanes,
    model: options.model,
    note,
    muted,
    toggleMute: (lane) =>
      setMuted((current) => {
        const next = new Set(current);
        if (next.has(lane)) next.delete(lane);
        else next.add(lane);
        return next;
      }),
    keep: (lane) =>
      editLane(lane, (existing) => {
        const { proposed: _dropped, ...kept } = existing;
        return kept;
      }),
    retry,
    drop: (lane) => editLane(lane, () => null),
    render,
    playing,
    play: () => {
      if (playing) {
        stop();
        return;
      }
      if (render === null) return;
      stop();
      playback.current = playBuffer(render.buffer, { loop: true });
      setPlaying(true);
    },
    stop,
    error,
  };
}

/** A short stable suffix for a track id, so two takes never collide. */
function hashPrompt(text: string): number {
  let state = 2166136261;
  for (let i = 0; i < text.length; i++) {
    state ^= text.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return (state >>> 8) & 0xffffff;
}
