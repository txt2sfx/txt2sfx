/**
 * NeurosLoop, and the four ways a generative screen lies without anybody noticing.
 *
 * 1. **A voice that does not parse.** Every note resolves to soundline text built by
 *    string interpolation, and a template with a wrong argument order produces a lane
 *    that is silently silent — the mixdown still works, the picture still draws, and one
 *    instrument is simply missing. So every distinct voice of every preset is parsed
 *    *and rendered*, and asked to make a sound.
 * 2. **A composer that is not deterministic.** The screen's whole claim is that a preset
 *    plus a prompt plus a salt reproduce an arrangement — that is why nothing is
 *    persisted. Two compositions of the same inputs are compared note for note.
 * 3. **A loop with a seam.** The mix folds a note's tail back to the head of the buffer,
 *    which is the one piece of arithmetic here that can be wrong in a way nobody sees
 *    until the eighth bar of the second lap.
 * 4. **A `.mid` that is not MIDI.** `lib/download.ts` spends a section refusing to hand
 *    over bytes that are not what the extension says. A hand-written chunk writer is the
 *    easiest place in this repository to break that promise.
 *
 * The renderer is reached only from here — `node-web-audio-api`, exactly as the agent
 * and optimizer tests do it, because the code under test takes its audio stack from the
 * caller and must never know one exists.
 *
 * @packageDocumentation
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OfflineAudioContext as NodeOfflineAudioContext } from 'node-web-audio-api';
import { codegen, parseWithDiagnostics, renderSound } from '@txt2sfx/core';
import {
  LANES,
  LOOP_PRESETS,
  STEPS_PER_BAR,
  VELOCITY_STEP,
  composeLane,
  composeTrack,
  degreeToMidi,
  knobsFor,
  laneClips,
  loopSeconds,
  parseKey,
  presetById,
  proposals,
  stepCount,
  stepSeconds,
  type LoopTrack,
} from '../src/lib/loop.js';
import { voiceFor, type VoiceContext } from '../src/lib/loop-voice.js';
import { CEILING, SAMPLE_RATE, mixLoop, renderLoop, renderStems } from '../src/lib/loop-render.js';
import { schedule, toMidi, toModule } from '../src/lib/loop-export.js';
import { LOOP_FORMATS, formatById, formatsFor } from '../src/lib/download.js';

/** Every preset composed with its own prompt — the state the screen opens in. */
const TRACKS: readonly LoopTrack[] = LOOP_PRESETS.map((preset) =>
  composeTrack(`t-${preset.id}`, preset, preset.prompt, preset.id, 'test'),
);

function contextFor(track: LoopTrack): VoiceContext {
  return { stepSeconds: stepSeconds(track), brightness: knobsFor(track.prompt).brightness };
}

/** Every distinct voice a track needs, as text. */
function voicesOf(track: LoopTrack): readonly string[] {
  const context = contextFor(track);
  const seen = new Set<string>();
  for (const lane of track.lanes) for (const note of lane.notes) seen.add(voiceFor(lane.name, note, context));
  return [...seen];
}

describe('the composer', () => {
  it('gives every preset a lane per instrument, and notes in every lane', () => {
    for (const track of TRACKS) {
      const preset = presetById(track.preset);
      expect(track.lanes.map((lane) => lane.name)).toEqual([...preset.lanes]);
      for (const lane of track.lanes) {
        expect(lane.notes.length, `${track.preset}/${lane.name}`).toBeGreaterThan(0);
        expect(LANES[lane.name]).toBeDefined();
      }
    }
  });

  it('keeps every note on the grid, in range, at a quantized velocity', () => {
    for (const track of TRACKS) {
      const steps = stepCount(track);
      for (const lane of track.lanes) {
        for (const note of lane.notes) {
          expect(note.step).toBeGreaterThanOrEqual(0);
          expect(note.step).toBeLessThan(steps);
          expect(note.midi).toBeGreaterThanOrEqual(0);
          expect(note.midi).toBeLessThanOrEqual(127);
          expect(note.length).toBeGreaterThan(0);
          /* Velocity is the cache key and the export key. A value off the grid means a
             recipe rendered once per note instead of once per level. */
          expect(Math.abs(note.gain / VELOCITY_STEP - Math.round(note.gain / VELOCITY_STEP))).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('reproduces an arrangement from preset, prompt and salt — which is why nothing is stored', () => {
    for (const preset of LOOP_PRESETS) {
      const once = composeTrack('same', preset, preset.prompt, preset.id, 'salt');
      const twice = composeTrack('same', preset, preset.prompt, preset.id, 'salt');
      expect(twice).toEqual(once);
    }
  });

  it('produces a different arrangement for a different prompt, same preset', () => {
    const preset = presetById('overworld-run');
    const a = composeTrack('x', preset, 'bright and busy', 'a', 's');
    const b = composeTrack('x', preset, 'dark and sparse', 'b', 's');
    expect(b.lanes.map((lane) => lane.notes)).not.toEqual(a.lanes.map((lane) => lane.notes));
  });

  it('changes only the retried lane when a lane is recomposed', () => {
    const track = TRACKS[0] as LoopTrack;
    const again = composeLane(track, 'bass', 1, 'other-salt');
    const bass = track.lanes.find((lane) => lane.name === 'bass');
    expect(bass).toBeDefined();
    expect(again.notes).not.toEqual(bass?.notes);
    expect(again.name).toBe('bass');
  });

  it('offers at most two spare lanes, none of them already present', () => {
    for (const track of TRACKS) {
      const spare = proposals(track);
      expect(spare.length).toBeLessThanOrEqual(2);
      for (const lane of spare) expect(track.lanes.some((existing) => existing.name === lane)).toBe(false);
    }
  });
});

describe('the prompt', () => {
  it('reads tempo, density and brightness out of the words it knows', () => {
    expect(knobsFor('relentless driving chase').tempo).toBeGreaterThan(1);
    expect(knobsFor('slow weightless drift').tempo).toBeLessThan(1);
    expect(knobsFor('sparse minimal').density).toBeLessThan(0);
    expect(knobsFor('busy dense layered').density).toBeGreaterThan(0);
    expect(knobsFor('bright shimmering').brightness).toBeGreaterThan(0);
    expect(knobsFor('dark muffled').brightness).toBeLessThan(0);
  });

  it('drops the lanes it was asked to do without', () => {
    expect(knobsFor('weightless menu loop — soft arp, warm pad, no drums').without).toContain('drums');
    expect(knobsFor('without percussion').without).toContain('perc');
    const track = composeTrack('n', presetById('overworld-run'), 'no drums please', 'n', 's');
    expect(track.lanes.some((lane) => lane.name === 'drums')).toBe(false);
  });

  it('refuses to compose silence when every lane was excluded', () => {
    const preset = presetById('menu-drift');
    const asked = `no ${preset.lanes.join(', no ')}`;
    expect(composeTrack('n', preset, asked, 'n', 's').lanes.length).toBeGreaterThan(0);
  });

  it('leaves the tempo a whole number, because every tool downstream wants one', () => {
    for (const preset of LOOP_PRESETS) {
      const track = composeTrack('n', preset, 'relentless driving chase', 'n', 's');
      expect(Number.isInteger(track.bpm)).toBe(true);
    }
  });
});

describe('pitch', () => {
  it('reads a key signature into a root and a mode', () => {
    expect(parseKey('A min')).toEqual({ root: 9, scale: [0, 2, 3, 5, 7, 8, 10], minor: true });
    expect(parseKey('G maj').minor).toBe(false);
    /* A typo costs a mode, not a screen. */
    expect(parseKey('nonsense').root).toBe(9);
  });

  it('walks degrees past the ends of the scale', () => {
    const key = parseKey('C maj');
    expect(degreeToMidi(key, 0, 4)).toBe(60);
    expect(degreeToMidi(key, 7, 4)).toBe(72);
    expect(degreeToMidi(key, -7, 4)).toBe(48);
    expect(degreeToMidi(key, 4, 4)).toBe(67);
  });
});

describe('every voice a preset can ask for', () => {
  /* Slow by construction — a few hundred offline renders — but this is the assertion
     the whole screen rests on: a template that does not parse is an instrument that is
     silently missing from the mix. */
  it('parses, compiles and makes a sound', async () => {
    for (const track of TRACKS) {
      for (const soundline of voicesOf(track)) {
        const parsed = parseWithDiagnostics(soundline);
        expect(parsed.errors, `${track.preset}\n${soundline}`).toEqual([]);
        expect(parsed.ast).not.toBeNull();
        if (parsed.ast === null) continue;

        const result = await renderSound(parsed.ast, {
          context: (options) =>
            new NodeOfflineAudioContext(options.numberOfChannels, options.length, options.sampleRate),
          seed: 7,
        });
        expect(result.peak, `silent: ${soundline}`).toBeGreaterThan(0.001);
        /* The recipes carry their own gain; nothing downstream normalizes a voice, so a
           clipping template would clip in the mix too. */
        expect(result.clipped, `clips: ${soundline}`).toBe(false);
      }
    }
  }, 120000);

  it('compiles to an exportable function for every one of them', () => {
    for (const track of TRACKS) {
      for (const soundline of voicesOf(track)) {
        const ast = parseWithDiagnostics(soundline).ast;
        expect(ast).not.toBeNull();
        if (ast === null) continue;
        const emitted = codegen(ast, { seed: 7 }).code;
        /* Syntax only — `test/codegen.test.ts` already proves the emitted graph renders
           sample-for-sample like the live one. */
        expect(() => new Function(`return ${emitted}`)).not.toThrow();
      }
    }
  });

  it('names a distinct recipe per velocity, so the render cache can collapse them', () => {
    const track = TRACKS[0] as LoopTrack;
    const context = contextFor(track);
    const quiet = voiceFor('bass', { step: 0, midi: 45, gain: 0.3, length: 4 }, context);
    const loud = voiceFor('bass', { step: 0, midi: 45, gain: 0.9, length: 4 }, context);
    expect(quiet).not.toBe(loud);
    expect(voiceFor('bass', { step: 8, midi: 45, gain: 0.3, length: 4 }, context)).toBe(quiet);
  });
});

describe('the mixdown', () => {
  it('folds a tail that runs past the end back onto the head', () => {
    const part = { samples: Float32Array.from([0, 0, 1, 2]), offset: 2 };
    const { samples } = mixLoop([part], 4);
    /* Onset at 2, so samples 2 and 3 land at the end and the last two wrap to 0 and 1 —
       which is exactly what makes the second lap continue the first. */
    expect([...samples]).toEqual([1, 2, 0, 0]);
  });

  it('wraps more than once when a part is longer than the whole loop', () => {
    const { samples } = mixLoop([{ samples: Float32Array.from([1, 1, 1, 1, 1]), offset: 0 }], 2);
    expect([...samples]).toEqual([3, 2]);
  });

  it('sums overlapping parts and reports the peak before any headroom', () => {
    const { peak } = mixLoop(
      [
        { samples: Float32Array.from([0.6]), offset: 0 },
        { samples: Float32Array.from([0.7]), offset: 0 },
      ],
      2,
    );
    expect(peak).toBeCloseTo(1.3, 6);
  });
});

/**
 * The one place this file installs a global.
 *
 * `lib/loop-render.ts` is browser code — it reaches for `OfflineAudioContext` the way
 * `lib/engine.ts` does, because in a tab that constructor is simply there. Standing the
 * Node implementation up under the same name is what lets the *real* mixdown path run
 * here: the same voice renders, the same wrap, the same headroom decision, the same
 * `copyToChannel`. Testing a reimplementation of it would prove nothing.
 */
describe('a whole soundtrack, mixed', () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const had = 'OfflineAudioContext' in globals;

  beforeAll(() => {
    globals['OfflineAudioContext'] = NodeOfflineAudioContext;
  });
  afterAll(() => {
    if (!had) delete globals['OfflineAudioContext'];
  });

  it('renders one seamless buffer of exactly the loop length', async () => {
    const track = TRACKS[4] as LoopTrack;
    const rendered = await renderLoop(track, { seed: 7 });

    expect(rendered.buffer.length).toBe(Math.round(loopSeconds(track) * SAMPLE_RATE));
    expect(rendered.buffer.sampleRate).toBe(SAMPLE_RATE);
    expect(rendered.notes).toBe(track.lanes.reduce((total, lane) => total + lane.notes.length, 0));
    expect(rendered.voices).toBeGreaterThan(0);
    expect(rendered.voices).toBeLessThanOrEqual(rendered.notes);

    /* Audible, and inside the ceiling after headroom — the two things a listener would
       otherwise have to discover by pressing Play on silence or on a clipped mix. */
    const samples = rendered.buffer.getChannelData(0);
    let peak = 0;
    for (const value of samples) peak = Math.max(peak, Math.abs(value));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
    expect(rendered.headroom).toBeLessThanOrEqual(1);
  }, 60000);

  it('leaves the head of the buffer sounding, because a tail wrapped onto it', async () => {
    /* `cave-ambience` is pads and a drone: every note is longer than the grid it sits
       on, so if the wrap were dropped the first samples of the loop would be silence
       and the seam would be audible on every lap. */
    const rendered = await renderLoop(TRACKS[2] as LoopTrack, { seed: 7 });
    const head = rendered.buffer.getChannelData(0).slice(0, 512);
    let energy = 0;
    for (const value of head) energy += Math.abs(value);
    expect(energy / head.length).toBeGreaterThan(0.0005);
  }, 60000);

  it('mutes a lane by re-mixing, so what plays and what exports cannot disagree', async () => {
    const track = TRACKS[0] as LoopTrack;
    const full = await renderLoop(track, { seed: 7 });
    const withoutDrums = await renderLoop(track, { seed: 7, muted: new Set(['drums']) });
    expect(withoutDrums.notes).toBeLessThan(full.notes);
  }, 60000);

  it('renders each stem on its own rather than slicing the master', async () => {
    const track = TRACKS[4] as LoopTrack;
    const master = await renderLoop(track, { seed: 7 });
    const stems = await renderStems(track, 7);

    expect(stems.map((stem) => stem.lane)).toEqual(track.lanes.map((lane) => lane.name));
    for (const stem of stems) {
      expect(stem.render.notes, stem.lane).toBeGreaterThan(0);
      /* Each is a summand of the master's *pre-headroom* peak. If stems were sliced off
         the finished mix they would each carry the sum's gain reduction, and a producer
         summing them back together would get a quieter mix than the one auditioned. */
      expect(stem.render.peak, stem.lane).toBeLessThanOrEqual(master.peak + 1e-6);
    }
  }, 90000);
});

describe('the picture', () => {
  it('draws clips only where the lane actually plays', () => {
    for (const track of TRACKS) {
      const steps = stepCount(track);
      for (const lane of track.lanes) {
        const clips = laneClips(lane, steps);
        expect(clips.length).toBeGreaterThan(0);
        for (const clip of clips) {
          expect(clip.left).toBeGreaterThanOrEqual(0);
          expect(clip.left + clip.width).toBeLessThanOrEqual(100.0001);
          expect(clip.cells.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('has nothing to draw for a lane with no notes', () => {
    expect(laneClips({ name: 'lead', hue: 195, notes: [], salt: 's' }, 64)).toEqual([]);
  });
});

describe('the exports', () => {
  it('offers a menu of its own, defaulting to something that exists in it', () => {
    expect(formatsFor('loop')).toBe(LOOP_FORMATS);
    /* The loop has no `soundline` and no single-recipe `js` entry — either would export
       one note of an arrangement under the name of the whole thing. */
    expect(LOOP_FORMATS.some((format) => format.id === 'soundline')).toBe(false);
    expect(LOOP_FORMATS.some((format) => format.id === 'js')).toBe(false);
    expect(LOOP_FORMATS).toContain(formatById('nonsense', LOOP_FORMATS));
    for (const format of LOOP_FORMATS) expect(format.extension).not.toBe('');
  });

  it('writes a module with one compiled voice per distinct recipe, and every hit in it', () => {
    const track = TRACKS[0] as LoopTrack;
    const plan = schedule(track);
    const module = toModule(track, 7, false);

    expect(plan.hits.length).toBe(track.lanes.reduce((total, lane) => total + lane.notes.length, 0));
    expect(plan.voices.length).toBeLessThanOrEqual(plan.hits.length);
    /* Every hit references a voice that exists — an off-by-one in the dedup would be an
       arrangement with a hole in it that only shows up when somebody runs the export. */
    for (const hit of plan.hits) expect(plan.voices[hit.voice]).toBeDefined();

    expect(module).toContain('export default function playLoop');
    expect(module).toContain(`bpm: ${String(track.bpm)}`);
    expect((module.match(/\n {2}\[\d+, \d+\],/g) ?? []).length).toBe(plan.hits.length);
    /* No stray annotations in the untyped emitter — a `.js` file with `: AudioContext`
       in it is a broken file, and the two emitters share every line but four. */
    expect(module).not.toContain(': AudioContext');
    expect(toModule(track, 7, true)).toContain('ctx: AudioContext');
  });

  it('writes a Standard MIDI File a DAW can open', () => {
    const track = TRACKS[1] as LoopTrack;
    const bytes = toMidi(track);
    const text = (from: number, length: number): string =>
      String.fromCharCode(...[...bytes.slice(from, from + length)]);

    expect(text(0, 4)).toBe('MThd');
    /* Header length 6, format 1, then the track count: a conductor track plus one per lane. */
    expect([...bytes.slice(4, 10)]).toEqual([0, 0, 0, 6, 0, 1]);
    expect((bytes[10] ?? 0) * 256 + (bytes[11] ?? 0)).toBe(track.lanes.length + 1);
    expect(text(14, 4)).toBe('MTrk');

    /* Percussion has to be on channel 10 — that is what makes note 36 a kick rather
       than a very low C on whatever patch happens to be loaded. */
    const chunks = [...bytes].reduce<number[]>((found, _, index) => {
      if (text(index, 4) === 'MTrk') found.push(index);
      return found;
    }, []);
    expect(chunks.length).toBe(track.lanes.length + 1);

    const drumLane = track.lanes.findIndex((lane) => LANES[lane.name]?.drum === true);
    expect(drumLane).toBeGreaterThanOrEqual(0);
    const start = chunks[drumLane + 1] ?? 0;
    const body = [...bytes.slice(start, (chunks[drumLane + 2] ?? bytes.length))];
    expect(body.some((byte, index) => byte === 0x99 && index > 0)).toBe(true);
  });

  it('scales a MIDI tick off the same grid the audio is scheduled on', () => {
    const track = TRACKS[0] as LoopTrack;
    /* One bar of steps is one bar of seconds: the two clocks are derived from the same
       tempo, and a disagreement here is a MIDI file that drifts against the WAV. */
    expect(stepSeconds(track) * STEPS_PER_BAR * track.bars).toBeCloseTo(loopSeconds(track), 9);
  });
});
