/**
 * Backend one: {@link AudioIR} -> live `AudioNode`s.
 *
 * Used by the playground (a real `AudioContext`) and by the offline renderer (an
 * `OfflineAudioContext`). The module is types-only against Web Audio — it calls
 * the standard factory methods on whatever context it is handed and imports
 * nothing, so `@txt2sfx/core` keeps its zero runtime dependencies and works
 * unchanged in a browser and in Node with `node-web-audio-api` injected.
 *
 * @packageDocumentation
 */

import type { SoundAST } from '@txt2sfx/shared';
import { bufferLength, fillBuffer, shaperCurve } from './buffers.js';
import { compileToIR, type CompileOptions } from './compile.js';
import { constantValue, isConstant, type AudioIR, type IRNode, type IRParam } from './ir.js';

/** Where to send the sound and when to start it. */
export interface GraphOptions {
  /** Defaults to `ctx.destination`. */
  readonly destination?: AudioNode;
  /** Context time at which the sound's onset happens. Defaults to 0. */
  readonly when?: number;
}

/** Options of {@link buildGraph}. */
export interface BuildGraphOptions extends CompileOptions, GraphOptions {}

/**
 * Apply a parameter trajectory.
 *
 * A parameter that never moves is written straight to `.value` instead of being
 * scheduled: it is cheaper, and a scheduled event on a parameter with no ramp
 * would pin it against later `cancelScheduledValues` calls in the playground.
 */
function applyParam(target: AudioParam, param: IRParam, when: number): void {
  if (isConstant(param)) {
    target.value = constantValue(param);
    return;
  }
  for (const event of param.events) {
    const at = when + event.at;
    if (event.type === 'set') target.setValueAtTime(event.value, at);
    else if (event.type === 'lin') target.linearRampToValueAtTime(event.value, at);
    else target.exponentialRampToValueAtTime(event.value, at);
  }
}

function createNode(ctx: BaseAudioContext, spec: IRNode, buffers: readonly AudioBuffer[], when: number): AudioNode {
  switch (spec.kind) {
    case 'osc': {
      const node = ctx.createOscillator();
      node.type = spec.wave;
      applyParam(node.frequency, spec.freq, when);
      return node;
    }
    case 'player': {
      const node = ctx.createBufferSource();
      const buffer = buffers[spec.buffer];
      if (buffer === undefined) throw new Error(`IR references buffer ${spec.buffer}, which does not exist`);
      node.buffer = buffer;
      node.loop = spec.loop;
      return node;
    }
    case 'gain': {
      const node = ctx.createGain();
      applyParam(node.gain, spec.gain, when);
      return node;
    }
    case 'filter': {
      const node = ctx.createBiquadFilter();
      node.type = spec.filter;
      node.Q.value = spec.q;
      applyParam(node.frequency, spec.freq, when);
      return node;
    }
    case 'shaper': {
      const node = ctx.createWaveShaper();
      node.curve = shaperCurve(spec.drive);
      return node;
    }
    case 'delay': {
      const node = ctx.createDelay(spec.max);
      node.delayTime.value = spec.time;
      return node;
    }
    case 'convolver': {
      const node = ctx.createConvolver();
      const buffer = buffers[spec.buffer];
      if (buffer === undefined) throw new Error(`IR references buffer ${spec.buffer}, which does not exist`);
      node.buffer = buffer;
      return node;
    }
  }
}

/**
 * Instantiate an IR into a context.
 *
 * Nodes first, then edges, then `start`/`stop`: an `AudioParam` target has to
 * exist before something can be connected to it, and a source may as well be
 * fully wired before it is scheduled.
 */
export function instantiate(ctx: BaseAudioContext, ir: AudioIR, options: GraphOptions = {}): void {
  const when = options.when ?? 0;
  const destination = options.destination ?? ctx.destination;

  const buffers = ir.buffers.map((spec) => {
    const buffer = ctx.createBuffer(1, bufferLength(spec, ctx.sampleRate), ctx.sampleRate);
    buffer.getChannelData(0).set(fillBuffer(spec, ctx.sampleRate));
    return buffer;
  });

  const nodes = ir.nodes.map((spec) => createNode(ctx, spec, buffers, when));

  const nodeAt = (id: number): AudioNode => {
    const node = nodes[id];
    if (node === undefined) throw new Error(`IR references node ${id}, which does not exist`);
    return node;
  };

  for (const edge of ir.edges) {
    const from = nodeAt(edge.from);
    if (edge.to === 'out') {
      from.connect(destination);
    } else if (typeof edge.to === 'number') {
      from.connect(nodeAt(edge.to));
    } else {
      const target = nodeAt(edge.to.node);
      from.connect((target as OscillatorNode).frequency);
    }
  }

  for (const spec of ir.nodes) {
    if (spec.kind !== 'osc' && spec.kind !== 'player') continue;
    const node = nodeAt(spec.id) as AudioScheduledSourceNode;
    node.start(when + spec.start);
    node.stop(when + spec.stop);
  }
}

/**
 * Compile a sound and instantiate it in one step.
 *
 * @returns The IR that was built, so a caller can inspect timings or reuse it
 *   for the exported code without compiling twice.
 */
export function buildGraph(ctx: BaseAudioContext, ast: SoundAST, options: BuildGraphOptions = {}): AudioIR {
  const ir = compileToIR(ast, options);
  instantiate(ctx, ir, options);
  return ir;
}
