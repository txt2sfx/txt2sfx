/**
 * Backend two: {@link AudioIR} -> a string of vanilla JavaScript.
 *
 * The export is the product. A game does not want a WAV, it wants a function it
 * can call a thousand times for the price of the bytes it took to ship — so the
 * emitted code has no imports, no helpers from this package, and no runtime
 * beyond the Web Audio API the browser already has:
 *
 * ```js
 * const play = (c, w = 0) => { ... };   // c: AudioContext, w: start time
 * play(new AudioContext());
 * ```
 *
 * ## Where the bytes go
 *
 * `GLOBAL_LIMITS.maxExportBytes` is 1 KB, and reaching it for a four-layer sound
 * takes real effort, so the emitter earns its size back in a few specific ways:
 *
 * - single-letter aliases for the long `AudioParam` method names and for any
 *   `ctx.createX()` factory used more than once, each emitted only when it pays
 *   for its own declaration;
 * - buffer generators emitted per *kind and colour used*, so a two-layer laser
 *   ships no pink-noise filter;
 * - values equal to a Web Audio default (`gain` of 1, `Q` of 1, an `OscillatorNode`
 *   that is already a sine) are not written at all;
 * - one single `const` for the entire prelude — helpers, buffers, nodes and
 *   parameter aliases — which is legal because a `const` list initializes left to
 *   right, and saves the keyword six bytes at a time.
 *
 * Compactness is not the same as obfuscation: what comes out is still an ordinary
 * Web Audio graph, and `test/codegen.test.ts` proves it renders sample-for-sample
 * like the live one.
 *
 * @packageDocumentation
 */

import type { SoundAST } from '@txt2sfx/shared';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { bufferEmitter } from './buffers.js';
import { compileToIR, type CompileOptions } from './compile.js';
import { num } from './emit.js';
import { constantValue, isConstant, type AudioIR, type IRParam, type IRParamEvent } from './ir.js';

/** A generated export. */
export interface CodegenResult {
  /** A JavaScript arrow-function expression: `(c,w=0)=>{...}`. */
  readonly code: string;
  /** Size of {@link code} in bytes (UTF-8). */
  readonly bytes: number;
  /** Whether it fits `GLOBAL_LIMITS.maxExportBytes`. */
  readonly withinBudget: boolean;
  /** The IR it was generated from, for callers that also want to render it. */
  readonly ir: AudioIR;
}

/** `AudioParam` methods, with the helper name and the byte cost of each form. */
const METHODS = {
  set: { helper: 'S', method: 'setValueAtTime' },
  lin: { helper: 'L', method: 'linearRampToValueAtTime' },
  exp: { helper: 'X', method: 'exponentialRampToValueAtTime' },
} as const;

/**
 * Values Web Audio already uses, which therefore never need to be written.
 *
 * Reading these off the spec rather than guessing matters: skipping a `gain` of 1
 * is free, skipping a `Q` of 1 is free, and skipping a `frequency` of 350 — the
 * `BiquadFilterNode` default — would be a bug waiting for the one soundline that
 * asks for a 350 Hz cutoff and gets it by accident.
 */
const AUDIO_DEFAULTS = { gain: 1, Q: 1 } as const;

/**
 * Node factories worth aliasing, with the letter each gets.
 *
 * An alias costs `X=()=>c.createFoo(),` and saves `c.createFoo()` minus `X()` per
 * use, so it breaks even at two uses for every name on this list — which is why
 * the threshold below is simply "used more than once". `createDelay` takes an
 * argument and almost never appears twice, so it is not here.
 */
const FACTORIES = [
  { kind: 'gain', method: 'createGain', alias: 'G' },
  { kind: 'osc', method: 'createOscillator', alias: 'O' },
  { kind: 'player', method: 'createBufferSource', alias: 'B' },
  { kind: 'filter', method: 'createBiquadFilter', alias: 'F' },
  { kind: 'shaper', method: 'createWaveShaper', alias: 'H' },
  { kind: 'convolver', method: 'createConvolver', alias: 'C' },
] as const;

/** `w`-relative time expression for the inline form of a scheduling call. */
function timeExpr(at: number): string {
  return at === 0 ? 'w' : `w+${num(at)}`;
}

/** Deferred automation: an alias for the parameter plus the events to schedule. */
interface AutomationJob {
  readonly alias: string;
  readonly param: IRParam;
}

/** Emit the JavaScript for an IR. */
export function codegenFromIR(ir: AudioIR): string {
  const creations: string[] = [];
  const aliases: string[] = [];
  const config: string[] = [];
  const jobs: AutomationJob[] = [];

  /* Which factories are worth a one-letter alias in this particular sound. */
  const factoryAliases = new Map<string, string>();
  const factoryDecls: string[] = [];
  for (const factory of FACTORIES) {
    const uses = ir.nodes.filter((node) => node.kind === factory.kind).length;
    if (uses < 2) continue;
    factoryAliases.set(factory.kind, factory.alias);
    factoryDecls.push(`${factory.alias}=()=>c.${factory.method}()`);
  }
  const create = (kind: string, method: string): string => {
    const alias = factoryAliases.get(kind);
    return alias === undefined ? `c.${method}()` : `${alias}()`;
  };

  /**
   * Record a parameter: written as a plain assignment when it never moves,
   * aliased and scheduled when it does.
   */
  const record = (nodeVar: string, accessor: 'frequency' | 'gain' | 'Q' | 'delayTime', param: IRParam): void => {
    if (isConstant(param)) {
      const value = constantValue(param);
      const known = accessor === 'gain' ? AUDIO_DEFAULTS.gain : accessor === 'Q' ? AUDIO_DEFAULTS.Q : undefined;
      if (value === known) return;
      config.push(`${nodeVar}.${accessor}.value=${num(value)}`);
      return;
    }
    const alias = `p${jobs.length}`;
    aliases.push(`${alias}=${nodeVar}.${accessor}`);
    jobs.push({ alias, param });
  };

  for (const spec of ir.nodes) {
    const v = `n${spec.id}`;
    switch (spec.kind) {
      case 'osc':
        creations.push(`${v}=${create('osc', 'createOscillator')}`);
        // `sine` is the OscillatorNode default.
        if (spec.wave !== 'sine') config.push(`${v}.type="${spec.wave}"`);
        record(v, 'frequency', spec.freq);
        break;
      case 'player':
        creations.push(`${v}=${create('player', 'createBufferSource')}`);
        config.push(`${v}.buffer=b${spec.buffer}`);
        if (spec.loop) config.push(`${v}.loop=!0`);
        break;
      case 'gain':
        creations.push(`${v}=${create('gain', 'createGain')}`);
        record(v, 'gain', spec.gain);
        break;
      case 'filter':
        creations.push(`${v}=${create('filter', 'createBiquadFilter')}`);
        // `lowpass` is the BiquadFilterNode default.
        if (spec.filter !== 'lowpass') config.push(`${v}.type="${spec.filter}"`);
        if (spec.q !== AUDIO_DEFAULTS.Q) config.push(`${v}.Q.value=${num(spec.q)}`);
        record(v, 'frequency', spec.freq);
        break;
      case 'shaper':
        creations.push(`${v}=${create('shaper', 'createWaveShaper')}`);
        config.push(`${v}.curve=W(${num(spec.drive)})`);
        break;
      case 'delay':
        creations.push(`${v}=c.createDelay(${num(spec.max)})`);
        config.push(`${v}.delayTime.value=${num(spec.time)}`);
        break;
      case 'convolver':
        creations.push(`${v}=${create('convolver', 'createConvolver')}`);
        config.push(`${v}.buffer=b${spec.buffer}`);
        break;
    }
  }

  /* Helper aliases pay for themselves only above a usage count; count first. */
  const uses = { set: 0, lin: 0, exp: 0 };
  for (const job of jobs) for (const event of job.param.events) uses[event.type] += 1;
  const useHelper = {
    set: uses.set * 15 > METHODS.set.method.length + 20,
    lin: uses.lin * 22 > METHODS.lin.method.length + 20,
    exp: uses.exp * 27 > METHODS.exp.method.length + 20,
  };

  const call = (alias: string, event: IRParamEvent): string => {
    const { helper, method } = METHODS[event.type];
    if (useHelper[event.type]) return `${helper}(${alias},${num(event.value)},${num(event.at)})`;
    return `${alias}.${method}(${num(event.value)},${timeExpr(event.at)})`;
  };

  const automations = jobs.flatMap((job) => job.param.events.map((event) => call(job.alias, event)));

  let outEdges = 0;
  for (const edge of ir.edges) {
    if (edge.to === 'out') outEdges += 1;
  }
  const destination = outEdges > 1 ? 'D' : 'c.destination';

  /*
   * `N` and `T` are worth their declarations once a graph has a few edges and a
   * few sources: `N(a,b)` is six bytes shorter than `a.connect(b)`, and one
   * `T(n,a,b)` replaces a `start`/`stop` pair sixteen bytes longer. The
   * thresholds are where each declaration breaks even.
   */
  const sources = ir.nodes.filter((node) => node.kind === 'osc' || node.kind === 'player');
  const useConnect = ir.edges.length >= 4;
  const useSchedule = sources.length >= 3;

  const link = (from: string, to: string): string =>
    useConnect ? `N(${from},${to})` : `${from}.connect(${to})`;

  const edges = ir.edges.map((edge) => {
    const from = `n${edge.from}`;
    if (edge.to === 'out') return link(from, destination);
    if (typeof edge.to === 'number') return link(from, `n${edge.to}`);
    return link(from, `n${edge.to.node}.frequency`);
  });

  const schedule = sources.flatMap((spec) => {
    if (spec.kind !== 'osc' && spec.kind !== 'player') return [];
    const v = `n${spec.id}`;
    if (useSchedule) return [`T(${v},${num(spec.start)},${num(spec.stop)})`];
    return [`${v}.start(${timeExpr(spec.start)})`, `${v}.stop(${timeExpr(spec.stop)})`];
  });

  /*
   * One `const` for everything that is bound: context aliases, generators,
   * scheduling helpers, factory aliases, buffers, nodes, parameter aliases. The
   * order matters and is satisfied by construction — a `const` declaration list
   * evaluates its initializers left to right, so `b0=Z(...)` can call the `Z`
   * declared three items earlier, and `p0=n1.gain` can reach the `n1` before it.
   */
  const emitter = bufferEmitter(
    ir.buffers,
    ir.nodes.some((node) => node.kind === 'shaper'),
  );
  const bound: string[] = [];
  if (ir.buffers.length > 0) bound.push('R=c.sampleRate');
  if (outEdges > 1) bound.push('D=c.destination');
  bound.push(...emitter.helpers);
  for (const type of ['set', 'lin', 'exp'] as const) {
    if (!useHelper[type]) continue;
    const { helper, method } = METHODS[type];
    bound.push(`${helper}=(p,v,t)=>p.${method}(v,w+t)`);
  }
  if (useConnect) bound.push('N=(a,b)=>a.connect(b)');
  if (useSchedule) bound.push('T=(n,a,b)=>{n.start(w+a),n.stop(w+b)}');
  bound.push(...factoryDecls);
  ir.buffers.forEach((spec, i) => bound.push(`b${i}=${emitter.expr(spec)}`));
  bound.push(...creations, ...aliases);

  const body = [...(bound.length > 0 ? [`const ${bound.join(',')}`] : []), ...config, ...automations, ...edges, ...schedule];
  return `(c,w=0)=>{${body.join(';')}}`;
}

/**
 * Compile a sound and emit its exported function.
 *
 * `withinBudget` is reported rather than enforced: a four-layer explosion with
 * three noise colours and two swept filters legitimately needs more than 1 KB,
 * and silently truncating it — or refusing to export it — would be worse than
 * telling the caller what it cost.
 */
export function codegen(ast: SoundAST, options: CompileOptions = {}): CodegenResult {
  const ir = compileToIR(ast, options);
  const code = codegenFromIR(ir);
  const bytes = new TextEncoder().encode(code).length;
  return { code, bytes, withinBudget: bytes <= GLOBAL_LIMITS.maxExportBytes, ir };
}
