/**
 * The audio intermediate representation: a sample-rate-independent description
 * of a Web Audio graph.
 *
 * ## Why an IR exists
 *
 * Phase 2 has to produce the same sound twice: once as live `AudioNode`s (the
 * playground, the offline renderer) and once as a string of vanilla JavaScript
 * (the export). Writing the DSP twice — once per backend — would mean fourteen
 * primitives implemented in two languages that must agree sample for sample.
 * They would not stay in agreement.
 *
 * So the DSP lives in exactly one place. Every primitive and effect emits
 * {@link AudioIR}, and the two backends are dumb players of it:
 * `compile/graph.ts` instantiates it, `compile/codegen.ts` prints it. The
 * parity test in `test/codegen.test.ts` renders both and compares samples,
 * which now checks two *players*, not two copies of the same synthesis.
 *
 * ## What is and is not in here
 *
 * Times are seconds **relative to the sound onset** — `when` is added by the
 * backend, because the exported function takes it as an argument and must not
 * have it baked in. Buffer contents are recipes, not samples: the sample rate
 * is unknown until a context exists, and a 1 KB export cannot carry a rendered
 * noise buffer.
 *
 * @packageDocumentation
 */

/** Oscillator waveform, in Web Audio's spelling (`tri` becomes `triangle`). */
export type IROscWave = 'sine' | 'triangle' | 'sawtooth' | 'square';

/** Biquad response used by the `lp` / `hp` / `bp` effects. */
export type IRFilterType = 'lowpass' | 'highpass' | 'bandpass';

/** Noise spectral tilt; mirrors `NOISE_COLORS` in the grammar. */
export type IRNoiseColor = 'white' | 'pink' | 'brown';

/**
 * One scheduled point on an `AudioParam`.
 *
 * `set` is `setValueAtTime`, `lin` is `linearRampToValueAtTime`, `exp` is
 * `exponentialRampToValueAtTime`. Exponential targets are already clamped away
 * from zero by the builders — see {@link EXP_EPSILON}.
 */
export interface IRParamEvent {
  readonly type: 'set' | 'lin' | 'exp';
  readonly value: number;
  /** Seconds relative to the sound onset. */
  readonly at: number;
}

/**
 * Trajectory of one `AudioParam`.
 *
 * A single `set` event at or before the node's start time is emitted as a plain
 * `param.value = v` assignment, which is both shorter in the export and
 * cheaper at runtime.
 */
export interface IRParam {
  /** Non-empty, sorted by `at`; the first event is always a `set`. */
  readonly events: readonly IRParamEvent[];
}

/**
 * Smallest value an exponential ramp may target.
 *
 * `exponentialRampToValueAtTime` throws on zero and behaves badly near it. This
 * is a hard floor applied to every exponential endpoint, independent of
 * `GLOBAL_LIMITS.minExpTarget` — that one is the *audible* floor for envelopes
 * (-60 dBFS), this one only keeps the Web Audio call legal for quantities like
 * frequency where -60 dB is meaningless.
 */
export const EXP_EPSILON = 1e-6;

/* ------------------------------------------------------------------------- *
 * Buffer recipes
 * ------------------------------------------------------------------------- */

/**
 * Procedural recipe for an `AudioBuffer`.
 *
 * Every recipe is a pure function of its fields plus the sample rate, so the
 * same recipe yields the same samples in the browser, in the offline renderer
 * and in the exported code. Stochastic recipes carry an explicit `seed` for
 * exactly that reason — `Math.random()` would make render snapshots and
 * optimizer fitness drift between runs.
 */
export type IRBufferSpec =
  /** Broadband noise with a spectral tilt. */
  | { readonly kind: 'noise'; readonly color: IRNoiseColor; readonly seed: number; readonly sec: number }
  /** Short decaying noise burst — the `click` primitive's transient. */
  | { readonly kind: 'burst'; readonly seed: number; readonly sec: number }
  /** Additive bank of exponentially decaying partials — the `modal` primitive. */
  | {
      readonly kind: 'modal';
      readonly freq: number;
      readonly ratios: readonly number[];
      readonly q: number;
      readonly sec: number;
    }
  /** Karplus-Strong string, rendered ahead of time. */
  | {
      readonly kind: 'pluck';
      readonly freq: number;
      readonly damp: number;
      readonly bright: number;
      readonly seed: number;
      readonly sec: number;
    }
  /** Dense bank of stretched modes with frequency-independent decay — `plate`. */
  | {
      readonly kind: 'plate';
      /** Frequency of the lowest mode. */
      readonly freq: number;
      /** How many modes. */
      readonly modes: number;
      /** Exponent of the mode series: mode k sits at `freq * k ** stretch`. */
      readonly stretch: number;
      /** Amplitude law: mode k is `k ** -slope` of the lowest. */
      readonly slope: number;
      /** Time the lowest mode takes to fall 60 dB, in seconds. */
      readonly decay: number;
      /** How much faster high modes die: `tau(k) = tau(1) * k ** -tilt`. */
      readonly tilt: number;
      readonly seed: number;
      readonly sec: number;
    }
  /** Scatter of short damped pings — the `grains` primitive. */
  | {
      readonly kind: 'grains';
      readonly freq: number;
      /** Grains per second. */
      readonly rate: number;
      /** Length of one grain, in seconds. */
      readonly width: number;
      /** Frequency scatter in octaves. */
      readonly spread: number;
      /** Timing randomness, 0..1. */
      readonly jitter: number;
      /** Frequency at the end of a grain, as a multiple of its start. */
      readonly bend: number;
      readonly seed: number;
      readonly sec: number;
    }
  /** Decaying noise impulse response for the `verb` effect's convolver. */
  | { readonly kind: 'verb'; readonly sec: number; readonly damp: number; readonly seed: number };

/* ------------------------------------------------------------------------- *
 * Nodes
 * ------------------------------------------------------------------------- */

/** A node in the graph. `id` is its index in {@link AudioIR.nodes}. */
export type IRNode =
  | {
      readonly kind: 'osc';
      readonly id: number;
      readonly wave: IROscWave;
      readonly freq: IRParam;
      readonly start: number;
      readonly stop: number;
    }
  | {
      readonly kind: 'player';
      readonly id: number;
      /** Index into {@link AudioIR.buffers}. */
      readonly buffer: number;
      readonly loop: boolean;
      readonly start: number;
      readonly stop: number;
    }
  | { readonly kind: 'gain'; readonly id: number; readonly gain: IRParam }
  | {
      readonly kind: 'filter';
      readonly id: number;
      readonly filter: IRFilterType;
      readonly freq: IRParam;
      readonly q: number;
    }
  /** Waveshaper; the curve is generated from `drive` by `shaperCurve()`. */
  | { readonly kind: 'shaper'; readonly id: number; readonly drive: number }
  | { readonly kind: 'delay'; readonly id: number; readonly max: number; readonly time: number }
  | { readonly kind: 'convolver'; readonly id: number; readonly buffer: number };

/** Where an edge lands: a node input, the graph output, or an `AudioParam`. */
export type IRTarget =
  | number
  | 'out'
  /** Modulation input, used by `fm` to drive the carrier's frequency. */
  | { readonly node: number; readonly param: 'freq' };

/** A connection between two nodes. */
export interface IREdge {
  readonly from: number;
  readonly to: IRTarget;
}

/** A complete graph description. */
export interface AudioIR {
  readonly buffers: readonly IRBufferSpec[];
  readonly nodes: readonly IRNode[];
  readonly edges: readonly IREdge[];
  /**
   * Length of the sound including effect tails, in seconds — what the renderer
   * allocates and what the exported function's caller should expect to hear.
   */
  readonly durationSec: number;
}

/* ------------------------------------------------------------------------- *
 * Parameter helpers
 * ------------------------------------------------------------------------- */

/** A parameter that never moves. */
export function constantParam(value: number): IRParam {
  return { events: [{ type: 'set', value, at: 0 }] };
}

/**
 * Whether a parameter can be emitted as a plain `param.value = v` assignment.
 *
 * One `set` event and nothing else — and the event's *time* does not matter. That
 * is safe because of how the compiler builds layers: every parameter belongs to
 * exactly one layer's chain, and nothing reaches that chain before the layer's
 * source starts. A filter whose cutoff is set at 25 ms is filtering silence until
 * then, so scheduling the value and assigning it are indistinguishable — and the
 * assignment is shorter in the export and cheaper at runtime.
 */
export function isConstant(param: IRParam): boolean {
  const [first] = param.events;
  return param.events.length === 1 && first !== undefined && first.type === 'set';
}

/** Value of a constant parameter. */
export function constantValue(param: IRParam): number {
  const [first] = param.events;
  if (first === undefined) throw new Error('IRParam has no events');
  return first.value;
}

/** Clamp an exponential-ramp endpoint away from zero, preserving sign. */
export function safeExpTarget(value: number): number {
  if (value > EXP_EPSILON || value < -EXP_EPSILON) return value;
  return value < 0 ? -EXP_EPSILON : EXP_EPSILON;
}

/**
 * Fold any number into the noise generator's legal seed range, `[1, 2^31-2]`.
 *
 * The MINSTD generator in `buffers.ts` is `s = s * 16807 mod (2^31-1)`, which is
 * absorbing at zero: seed it with 0 and every sample is 0, so a sound would
 * render silent with no error anywhere. Normalizing here — at the one door every
 * buffer recipe passes through — means the exported code can carry a bare
 * `let s=seed` and both backends are safe even against a hand-written IR.
 */
export function normalizeSeed(seed: number): number {
  return (Math.abs(Math.trunc(seed)) % 2147483646) + 1;
}

/* ------------------------------------------------------------------------- *
 * Builder
 * ------------------------------------------------------------------------- */

/**
 * Accumulates nodes, edges and buffer recipes while the compiler walks the AST.
 *
 * Primitives and effects never touch a real `AudioContext`; they call these
 * methods and hand back the id of their output node. That is the whole reason
 * `parse` -> `compile` works in a Node process with no audio stack at all.
 */
export class IRBuilder {
  private readonly nodes: IRNode[] = [];
  private readonly edges: IREdge[] = [];
  private readonly buffers: IRBufferSpec[] = [];

  /** Register a buffer recipe, reusing an identical one. */
  buffer(spec: IRBufferSpec): number {
    const normalized = ('seed' in spec ? { ...spec, seed: normalizeSeed(spec.seed) } : spec) as IRBufferSpec;
    const key = JSON.stringify(normalized);
    const existing = this.buffers.findIndex((b) => JSON.stringify(b) === key);
    if (existing >= 0) return existing;
    this.buffers.push(normalized);
    return this.buffers.length - 1;
  }

  osc(wave: IROscWave, freq: IRParam, start: number, stop: number): number {
    return this.push({ kind: 'osc', id: this.nodes.length, wave, freq, start, stop });
  }

  player(buffer: number, loop: boolean, start: number, stop: number): number {
    return this.push({ kind: 'player', id: this.nodes.length, buffer, loop, start, stop });
  }

  gain(gain: IRParam): number {
    return this.push({ kind: 'gain', id: this.nodes.length, gain });
  }

  filter(filter: IRFilterType, freq: IRParam, q: number): number {
    return this.push({ kind: 'filter', id: this.nodes.length, filter, freq, q });
  }

  shaper(drive: number): number {
    return this.push({ kind: 'shaper', id: this.nodes.length, drive });
  }

  delay(max: number, time: number): number {
    return this.push({ kind: 'delay', id: this.nodes.length, max, time });
  }

  convolver(buffer: number): number {
    return this.push({ kind: 'convolver', id: this.nodes.length, buffer });
  }

  connect(from: number, to: IRTarget): void {
    this.edges.push({ from, to });
  }

  /** Freeze the accumulated graph. */
  finish(durationSec: number): AudioIR {
    return {
      buffers: [...this.buffers],
      nodes: [...this.nodes],
      edges: [...this.edges],
      durationSec,
    };
  }

  private push(node: IRNode): number {
    this.nodes.push(node);
    return node.id;
  }
}

/* ------------------------------------------------------------------------- *
 * Quantization
 * ------------------------------------------------------------------------- */

/**
 * Decimal places every number in a finished IR is rounded to.
 *
 * Six is chosen from both ends. It erases binary-float noise (`0.1 + 0.2` becomes
 * `0.3`) and it shortens the export: a modal buffer length of
 * `0.191891363534` seconds becomes `.191891`, seven bytes cheaper and different by
 * less than half a sample. It leaves every integer we carry — node ids, buffer
 * indices, seeds, frequencies — untouched, and it is far above the floor that
 * exponential ramps are clamped to.
 */
const IR_DECIMALS = 1e6;

function quantizeValue(value: unknown): unknown {
  if (typeof value === 'number') {
    const rounded = Math.round(value * IR_DECIMALS) / IR_DECIMALS;
    // A value smaller than the last decimal place must not collapse to zero: an
    // exponential ramp target of 0 throws, and a gain of 0 is silence.
    return rounded === 0 && value !== 0 ? Number(value.toPrecision(6)) : rounded;
  }
  if (Array.isArray(value)) return value.map(quantizeValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = quantizeValue(item);
    return out;
  }
  return value;
}

/**
 * Round every number in an IR to a stable decimal.
 *
 * This is what makes the two backends comparable. The exported code carries
 * numbers as decimal literals, so if the IR held `0.15100000000000002` the
 * export would either grow by ten bytes or round — and a rounded export would
 * generate a *different* noise buffer length than the reference renderer, which
 * misaligns every sample after it. Quantizing once, here, means both backends
 * read the same numbers and the parity test can demand near-exact equality.
 */
export function quantizeIR(ir: AudioIR): AudioIR {
  return quantizeValue(ir) as AudioIR;
}
