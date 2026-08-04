/**
 * AST -> {@link AudioIR}: the actual compiler.
 *
 * One layer becomes `source -> envelope -> chain`, and every layer's chain output
 * lands on the graph output. That order is the frozen decision behind the whole
 * DSL: a soundline *writes* `source >> chain | envelope` because that reads well,
 * but the envelope shapes the source and the chain runs after it, which is why
 * `delay` and `verb` tails outlive the decay instead of being cut by it.
 *
 * @packageDocumentation
 */

import type { SoundAST } from '@txt2sfx/shared';
import { primitiveDef, effectDef, type BuildContext } from '../primitives/index.js';
import { declaredDurationMs, soundDurationMs } from './duration.js';
import { envelopeParam, envelopeTiming } from './envelope.js';
import { IRBuilder, quantizeIR, type AudioIR } from './ir.js';

/** Options shared by every consumer of the compiler. */
export interface CompileOptions {
  /**
   * Seed for stochastic buffers. Fixed by default, because a soundline plus a
   * seed has to be one specific sound: render snapshots, peak measurements and
   * optimizer fitness all depend on it.
   */
  readonly seed?: number;
  /**
   * Hard ceiling on the compiled length, in milliseconds. Protects against a
   * near-unity delay feedback asking for a minute of audio.
   */
  readonly maxDurationMs?: number;
}

/** Default render seed. Arbitrary, fixed, and written down so it stays fixed. */
export const DEFAULT_SEED = 0x5eed;

/** Default ceiling on compiled length. */
export const DEFAULT_MAX_DURATION_MS = 5000;

/**
 * Per-layer seed.
 *
 * Two noise layers in one sound must not be handed the same stream — correlated
 * noise sums to 6 dB of the same texture instead of a wider one. Knuth's
 * multiplicative hash over the layer index decorrelates them while keeping the
 * whole thing a pure function of the render seed.
 */
function layerSeed(base: number, index: number): number {
  const mixed = Math.imul(base ^ (index + 1), 2654435761) >>> 0;
  return mixed === 0 ? 1 : mixed;
}

/**
 * Compile a parsed sound into a backend-independent graph description.
 *
 * Pure and audio-free: no `AudioContext` is touched, so this runs in a plain
 * Node process, in a worker, or in a browser tab that never asked for audio.
 */
export function compileToIR(ast: SoundAST, options: CompileOptions = {}): AudioIR {
  const ir = new IRBuilder();
  const seed = options.seed ?? DEFAULT_SEED;

  ast.layers.forEach((layer, index) => {
    const timing = envelopeTiming(layer.envelope);
    const ctx: BuildContext = {
      ir,
      seed: layerSeed(seed, index),
      start: timing.startSec,
      stop: timing.endSec,
    };

    const source = primitiveDef(layer.source.name).build(layer.source.args, ctx);
    const envelope = ir.gain(envelopeParam(timing));
    ir.connect(source, envelope);

    let output = envelope;
    for (const effect of layer.chain) {
      output = effectDef(effect.name).build(output, effect.args, ctx);
    }
    ir.connect(output, 'out');
  });

  const ceiling = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  // Render at least what the header promises — a sound that decays early still
  // occupies its declared slot — and at most what it actually needs.
  const durationMs = Math.min(Math.max(declaredDurationMs(ast), soundDurationMs(ast)), ceiling);
  return quantizeIR(ir.finish(durationMs / 1000));
}
