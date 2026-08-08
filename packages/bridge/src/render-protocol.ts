/**
 * What crosses the render subprocess channel.
 *
 * Its own module so that `render.ts` (parent) and `render-child.ts` (child) can
 * share the shape without either importing the other: the child is bundled as a
 * separate entry point, and an import edge between the two would pull the whole
 * parent — hub, HTTP server, Stable Audio — into the child's bundle.
 *
 * @packageDocumentation
 */

import type { SoundProfile } from '@txt2sfx/shared';

/**
 * The argv the parent forks a child with, and the only thing that makes
 * `render-child.ts` start serving.
 *
 * "Do I have an IPC channel?" is the obvious test and it is wrong: a vitest
 * worker is itself a forked process, so merely importing the module inside the
 * test suite made it claim `process.on('message')` and post objects into
 * vitest's own channel, which fails as a deserialization error somewhere else
 * entirely. An explicit marker cannot be true by accident.
 */
export const RENDER_CHILD_ARG = '--txt2sfx-render-child';

/** One render, asked for. `source` is canonical soundline text — see `render-child.ts`. */
export interface ChildRequest {
  readonly id: number;
  readonly source: string;
  readonly seed?: number;
}

/** What a render measured. Mirrors `NativeRenderResult`, which is its only consumer. */
export interface ChildRenderResult {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly peak: number;
  readonly clipped: boolean;
  readonly durationMs: number;
  readonly profile: SoundProfile;
  readonly bytes: number;
  readonly withinBudget: boolean;
}

/**
 * Anything the child says.
 *
 * `ready` comes once, unasked, and carries the optional-dependency verdict: the
 * parent cannot answer `available()` until the child has tried the import, and
 * a boolean plus the prose reason is the whole of what it needs.
 */
export type ChildReply =
  | { readonly t: 'ready'; readonly available: boolean; readonly reason: string }
  | { readonly t: 'rendered'; readonly id: number; readonly result: ChildRenderResult }
  | { readonly t: 'failed'; readonly id: number; readonly message: string };
