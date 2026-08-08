/**
 * NeurosLoop's state, as a hook.
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
 * ## Why the mixdown is state and not a memo
 *
 * The buffer is what plays and what exports, so the two can never disagree — that is the
 * argument in `lib/loop-render.ts` for re-mixing on mute rather than gating playback.
 * A `useMemo` over an async render would let a stale buffer be exported while a fresh
 * one was still in flight; an explicit generation counter makes a superseded render
 * discard itself instead.
 *
 * ## Nothing here is persisted
 *
 * Deliberately, and this is the one place the playground's "keep unsaved work" rule does
 * *not* apply. A generated recipe costs a model call and a population of renders per
 * generation, and exists nowhere else — losing it to a reload is expensive. A soundtrack
 * costs a hash and some arithmetic: preset, prompt and salt reproduce it exactly, so
 * writing a few hundred note events to `localStorage` would buy nothing but a schema to
 * migrate later.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { playBuffer, type Playback } from './engine.js';
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
import { primeLane, renderLoop, type LoopRender } from './loop-render.js';

/** Which prompt the box is writing: a whole new track, or lanes for the current one. */
export type LoopMode = 'new' | 'add';

/** What the composing indicator reports while a track is being built. */
export interface Composing {
  readonly trackId: string;
  /** Lanes finished so far. Lanes past this index are not on screen yet. */
  readonly done: number;
  readonly total: number;
  /** The lane being worked on, for the message and the indicator's colour. */
  readonly lane: string;
  readonly hue: number;
  /** `compose` for a new track, `extend` for added lanes. */
  readonly verb: 'compose' | 'extend';
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

export function useLoop(options: { readonly seed: number }): LoopState {
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

  const playback = useRef<Playback | null>(null);
  /** Bumped by every state change that invalidates the mix; a late render checks it. */
  const generation = useRef(0);

  const selected = tracks.find((track) => track.id === selectedId) ?? tracks[0] ?? null;

  const stop = useCallback(() => {
    playback.current?.stop();
    playback.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => stop, [stop]);

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
          hue: lane.hue,
          verb,
        });
        /* Rendering the lane's voices now is what makes the reveal a measurement: the
           mixdown that follows finds them cached, so nothing is rendered twice. */
        await primeLane(track, name, options.seed).catch(() => undefined);
      }
      setComposing(null);
    },
    [options.seed],
  );

  const compose = useCallback(() => {
    if (composing !== null) return;
    stop();
    const chosen = presetById(preset);
    const id = `lt${String(tracks.length)}-${String(hashPrompt(prompt + chosen.id))}`;
    const takes = tracks.filter((track) => track.preset === chosen.id).length + 1;
    const name = takes > 1 ? `${chosen.id} · take ${String(takes)}` : chosen.id;
    const track = composeTrack(id, chosen, prompt.trim() === '' ? chosen.prompt : prompt.trim(), name, String(takes));

    setTracks((current) => [track, ...current]);
    setSelectedId(id);
    setRender(null);
    void stage(
      track,
      track.lanes.map((lane) => lane.name),
      0,
      'compose',
    );
  }, [composing, preset, prompt, stop, stage, tracks]);

  const extend = useCallback(() => {
    if (composing !== null || selected === null) return;
    const wanted = proposals(selected);
    if (wanted.length === 0) return;
    stop();

    const base = selected.lanes.length;
    const added = wanted.map((name, offset) => ({
      ...composeLane(selected, name, base + offset, `add-${String(base + offset)}-${prompt}`),
      hue: LANE_HUES[(base + offset) % LANE_HUES.length] ?? 195,
      proposed: true as const,
    }));
    const next: LoopTrack = { ...selected, lanes: [...selected.lanes, ...added] };

    setTracks((current) => current.map((track) => (track.id === next.id ? next : track)));
    void stage(next, wanted, base, 'extend');
  }, [composing, prompt, selected, stop, stage]);

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
       the timer. */
    lanes:
      selected === null
        ? []
        : composing !== null && composing.trackId === selected.id
          ? selected.lanes.slice(0, composing.done)
          : selected.lanes,
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
    retry: (lane) =>
      editLane(lane, (existing, track) => ({
        ...composeLane(track, lane, track.lanes.indexOf(existing), `${existing.salt}+`),
        hue: existing.hue,
        ...(existing.proposed === true ? { proposed: true as const } : {}),
      })),
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
