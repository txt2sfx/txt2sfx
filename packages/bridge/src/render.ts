/**
 * Renderer resolution: `playground` | `native` | `none`.
 *
 * `@txt2sfx/core` deliberately owns no audio stack — the offline context is a
 * parameter — so the bridge is where "can this process make samples?" is
 * actually decided. Three tiers, tried in order and re-evaluated on every call,
 * because a tab can connect at any moment and the answer the agent got a minute
 * ago is not the answer now:
 *
 * 1. a connected playground tab (preferred: the number the agent is told and
 *    the number on the human's screen come from the same render);
 * 2. `node-web-audio-api`, an **optional** dependency imported behind a guard —
 *    it is a native module, and an `npx` that fails to install on a platform
 *    with no prebuilt binary would be worse than one that renders a little
 *    less;
 * 3. none — validation, the contract and the bank still work, and anything
 *    that needs samples fails with one sentence naming which of the two to fix.
 *
 * The import failure is cached but the tier decision is not: availability of a
 * native module cannot change within a process, presence of a tab can.
 *
 * @packageDocumentation
 */

import type { SoundAST } from '@txt2sfx/shared';
import {
  codegen,
  peakOf,
  renderSound,
  type OfflineContextFactory,
} from '@txt2sfx/core';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { extractProfile } from '@txt2sfx/analyzer';
import type { SoundProfile } from '@txt2sfx/shared';
import type { Renderer } from './protocol.js';

/** The tier plus the reason, because `doctor` and error messages both need the why. */
export interface RendererResolution {
  readonly renderer: Renderer;
  readonly why: string;
}

/** What a native render measures. Samples are copied — see {@link createNativeRenderer}. */
export interface NativeRenderResult {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly peak: number;
  readonly clipped: boolean;
  readonly durationMs: number;
  readonly profile: SoundProfile;
  readonly bytes: number;
  readonly withinBudget: boolean;
}

/** Tier 2, behind its guard. */
export interface NativeRenderer {
  available(): Promise<boolean>;
  /** Why it is or is not available — one sentence, for `doctor`. */
  reason(): Promise<string>;
  render(ast: SoundAST, seed?: number): Promise<NativeRenderResult>;
}

/** How the module is obtained. A parameter so tests can make it fail on purpose. */
export type NativeImporter = () => Promise<{ OfflineAudioContext: new (options: {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
}) => unknown }>;

const defaultImporter: NativeImporter = () =>
  import('node-web-audio-api') as ReturnType<NativeImporter>;

/**
 * Build the guarded native renderer.
 *
 * The absence of the module must never throw at startup — a user on a platform
 * with no prebuilt binary still gets `sfx_validate`, `sfx_contract` and the
 * bank. So the import happens lazily, once, inside a catch, and the failure is
 * kept as prose instead of being rethrown.
 */
export function createNativeRenderer(importer: NativeImporter = defaultImporter): NativeRenderer {
  let probe: Promise<{ factory: OfflineContextFactory | undefined; reason: string }> | undefined;

  const load = (): NonNullable<typeof probe> => {
    probe ??= importer().then(
      (module) => ({
        factory: ((options) =>
          new module.OfflineAudioContext(options) as OfflineAudioContext) as OfflineContextFactory,
        reason: 'node-web-audio-api is installed; renders happen in-process at 44.1 kHz',
      }),
      (error: unknown) => ({
        factory: undefined,
        reason: `node-web-audio-api is not installed (${error instanceof Error ? error.message.split('\n')[0] ?? 'import failed' : 'import failed'})`,
      }),
    );
    return probe;
  };

  return {
    async available(): Promise<boolean> {
      return (await load()).factory !== undefined;
    },

    async reason(): Promise<string> {
      return (await load()).reason;
    },

    async render(ast: SoundAST, seed?: number): Promise<NativeRenderResult> {
      const { factory, reason } = await load();
      if (factory === undefined) throw new Error(reason);

      const result = await renderSound(ast, {
        context: factory,
        ...(seed === undefined ? {} : { seed }),
      });
      /* Copy out of the native buffer before anything else touches the context.
         `getChannelData` returns a view into memory the native context owns, and
         the repo learned the hard way that holding it across the next render is
         a profile full of NaN and then a process death with no JS stack. */
      const samples = Float32Array.from(result.buffer.getChannelData(0));
      const sampleRate = result.buffer.sampleRate;
      const generated = codegen(ast);

      return {
        samples,
        sampleRate,
        peak: peakOf(result.buffer),
        clipped: result.clipped,
        durationMs: result.durationMs,
        profile: extractProfile({ samples, sampleRate }),
        bytes: generated.bytes,
        withinBudget: generated.withinBudget,
      };
    },
  };
}

/** Sanity export for callers that report against the budget. */
export const MAX_PEAK = GLOBAL_LIMITS.maxPeak;

/** Pick the tier. Called per tool call, never cached — see the module note. */
export async function resolveRenderer(
  playgroundConnected: boolean,
  native: NativeRenderer,
): Promise<RendererResolution> {
  if (playgroundConnected) {
    return {
      renderer: 'playground',
      why: 'a playground tab is connected; renders happen in its OfflineAudioContext',
    };
  }
  if (await native.available()) {
    return { renderer: 'native', why: await native.reason() };
  }
  return {
    renderer: 'none',
    why: `no playground tab is connected and ${await native.reason()}`,
  };
}
