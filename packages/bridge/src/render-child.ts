/**
 * The render subprocess: one soundline in, one measured render out.
 *
 * ## Why rendering happens in a child at all
 *
 * `node-web-audio-api` never frees an `OfflineAudioContext`. Measured on 2.1.0:
 * constructing one and dropping it on the floor costs ~95 KB that no garbage
 * collection returns, and a real render costs ~68 KB — over a thousand renders
 * the process grows ~63 MB while `heapUsed` stays flat at ~10 MB and
 * `external`/`arrayBuffers` do not move at all. V8 cannot see those bytes, so
 * nothing about them looks like pressure and a forced `global.gc()` reclaims
 * none of it. Two equal batches of a thousand constructions cost +95.7 MB and
 * +95.0 MB, which is what rules out allocator retention: that would plateau.
 *
 * The cause is one line of the library's own facade. Its `OfflineAudioContext`
 * constructor registers a state-change callback on the napi object
 * (`js/OfflineAudioContext.js:83`, `this[kNapiObj].onstatechange(...)`), which
 * roots the native context in a threadsafe function, and the offline context
 * has no `close()` to release it — the library exposes one only on the online
 * `AudioContext`. Deleting that registration in a decoupled copy of 2.1.0 and
 * re-running the same load: four batches of a thousand cost +6.1, +3.9, +3.9
 * and +3.8 MB, so the leak goes from ~95 KB per context to about four bytes.
 *
 * So the durable fix is upstream, and this file is not pretending otherwise.
 * It exists because the *published* bridge cannot apply it: `node-web-audio-api`
 * is an optional dependency resolved by the user's own npm and deliberately
 * left external to the bundle, so until a fixed release exists and the floor is
 * raised, every `npx txt2sfx-bridge` runs against the leak. Inside this
 * repository a `pnpm patch` would fix it at the source for `apps/server` too,
 * and that is the better tool there — this subprocess is not a reason to skip
 * it.
 *
 * That would be a footnote if renders were rare. They are not: `sfx_fit` is a
 * population of renders per generation. The bridge's own tool caps a search at
 * 16 x 30, so ~480 renders and ~33 MB; a search left on `DE_DEFAULTS` (24 x 60)
 * is ~1460 evaluations. A measured fit of `examples/laser` did 382 renders in
 * 3.8 s and left 25.5 MB behind — memory the daemon never gives back.
 *
 * ## Why a child process and not a worker thread
 *
 * Worker threads share the process address space, so leaked native memory
 * outlives them: measured, a parent went from 52.5 MB to 78.0 MB running this
 * load in a worker and *stayed* there after `terminate()`. A child process has
 * its own address space and the operating system reclaims all of it on exit —
 * the same load through a child moved the parent by 0.6 MB, which is noise.
 * Cold `fork` to first completed render is ~155 ms.
 *
 * ## Why the source text crosses, not the AST
 *
 * The parent holds a `SoundAST` and sends `serialize(ast)`. That leans on the
 * round-trip this repository already guarantees and tests — canonical text
 * parses back to the same tree, numbers stored as written — and in exchange the
 * request is a short string instead of an object graph whose cloneability would
 * be a new thing to keep true every time the AST grows a field.
 *
 * The reply carries samples as a `Float32Array` over structured clone
 * (`serialization: 'advanced'`). Measured against JSON on a 10 143-sample
 * buffer: 0.30 ms per round trip versus 3.16 ms. A render is ~10 ms, so the
 * channel costs about 3% and the parent keeps the per-render seam it already
 * had rather than moving the whole optimizer down here.
 *
 * @packageDocumentation
 */

import process from 'node:process';
import { codegen, parse, peakOf, renderSound, type OfflineContextFactory } from '@txt2sfx/core';
import { extractProfile } from '@txt2sfx/analyzer';
import { RENDER_CHILD_ARG, type ChildReply, type ChildRequest } from './render-protocol.js';

/**
 * Load the optional native module, once.
 *
 * The same guard the in-process renderer uses and for the same reason: the
 * module is an `optionalDependency` so that `npx txt2sfx-bridge` still installs
 * on a platform with no prebuilt binary. The failure is kept as prose and
 * reported to the parent, never thrown — the parent turns it into the sentence
 * a model reads.
 */
async function loadFactory(): Promise<{ factory: OfflineContextFactory | undefined; reason: string }> {
  try {
    const module = (await import('node-web-audio-api')) as {
      OfflineAudioContext: new (options: {
        numberOfChannels: number;
        length: number;
        sampleRate: number;
      }) => unknown;
    };
    return {
      factory: ((options) => new module.OfflineAudioContext(options) as OfflineAudioContext) as OfflineContextFactory,
      reason: 'node-web-audio-api is installed; renders happen in a render subprocess at 44.1 kHz',
    };
  } catch (error) {
    return {
      factory: undefined,
      reason: `node-web-audio-api is not installed (${
        error instanceof Error ? (error.message.split('\n')[0] ?? 'import failed') : 'import failed'
      })`,
    };
  }
}

/**
 * Serve renders until the parent closes the channel.
 *
 * Exported so a test can drive it without a process; the module runs it on
 * import only when the parent's marker argv is present — see
 * {@link RENDER_CHILD_ARG} for the accident that rules out.
 */
export async function serveRenders(
  send: (reply: ChildReply) => void,
  on: (handler: (request: ChildRequest) => void) => void,
): Promise<void> {
  const { factory, reason } = await loadFactory();
  send({ t: 'ready', available: factory !== undefined, reason });
  if (factory === undefined) return;

  on((request: ChildRequest) => {
    void (async (): Promise<void> => {
      try {
        const ast = parse(request.source);
        const result = await renderSound(ast, {
          context: factory,
          ...(request.seed === undefined ? {} : { seed: request.seed }),
        });
        /* Copy out of the native buffer before the reply is serialized.
           `getChannelData` returns a view into memory the native context owns,
           and this repository learned the hard way that holding it across the
           next render is a profile full of NaN and then a process death with no
           JS stack. Structured clone would copy anyway; doing it here keeps the
           rule in one place rather than relying on the channel to enforce it. */
        const samples = Float32Array.from(result.buffer.getChannelData(0));
        const sampleRate = result.buffer.sampleRate;
        const generated = codegen(ast);
        send({
          t: 'rendered',
          id: request.id,
          result: {
            samples,
            sampleRate,
            peak: peakOf(result.buffer),
            clipped: result.clipped,
            durationMs: result.durationMs,
            profile: extractProfile({ samples, sampleRate }),
            bytes: generated.bytes,
            withinBudget: generated.withinBudget,
          },
        });
      } catch (error) {
        send({
          t: 'failed',
          id: request.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}

/* Serve only when the parent asked for it by name. Importing this module —
   from `index.ts`, from a test, from a bundler's dependency walk — starts
   nothing. */
if (process.argv.includes(RENDER_CHILD_ARG) && process.channel !== undefined) {
  await serveRenders(
    (reply) => {
      process.send?.(reply);
    },
    (handler) => {
      process.on('message', (message: ChildRequest) => {
        handler(message);
      });
    },
  );
}
