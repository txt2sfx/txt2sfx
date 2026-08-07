/**
 * Wire protocol v1, as types — the shared vocabulary of the three participants.
 *
 * This file is the TypeScript rendering of the tables in `docs/BRIDGE.md`, and
 * the document wins every disagreement: a browser client is written against the
 * same prose, so a shape invented here and not there is a bug even if both ends
 * of *this* repository agree on it. Method params and results are typed rather
 * than left as `unknown` so the daemon's callers and the playground's handlers
 * cannot drift apart without a compile error — the same "one description, two
 * players" argument that gives the compiler its IR.
 *
 * Profile and issue shapes are imported from `@txt2sfx/shared` instead of being
 * redeclared: the playground fills them from the same package, and a copy here
 * would be the copy that rots.
 *
 * @packageDocumentation
 */

import type { SoundProfile, ValidationIssue } from '@txt2sfx/shared';

/** Version of the wire protocol, in `hello`/`welcome` frames and `/health`. */
export const PROTOCOL_VERSION = 1;

/**
 * Where `sfx_render` will get its samples, re-evaluated per call because a tab
 * can connect at any moment.
 *
 * - `playground` — a tab is connected; renders happen there, in the same
 *   `OfflineAudioContext` that produced the picture the human is looking at.
 * - `native` — `node-web-audio-api` imported successfully.
 * - `none` — validate, contract and the bank tools still work; anything that
 *   needs samples fails with one sentence naming which of the two to fix.
 */
export type Renderer = 'playground' | 'native' | 'none';

/** What the playground is told about the agent side. */
export interface AgentStatus {
  readonly connected: boolean;
  /** MCP client name from `initialize`, or `null` when unknown/not connected. */
  readonly client: string | null;
  /** Whether the client advertised `sampling` — direction B without polling. */
  readonly sampling: boolean;
}

/** One JSON object per WebSocket text frame. `call` travels in both directions. */
export type Frame =
  | { t: 'hello'; role: 'playground'; version: 1; app: string }
  | { t: 'welcome'; version: 1; bridge: string; renderer: Renderer; agent: AgentStatus }
  | { t: 'call'; id: string; method: string; params: unknown }
  | { t: 'result'; id: string; result: unknown }
  | { t: 'error'; id: string; error: { message: string; code?: string } }
  | { t: 'event'; event: string; data: unknown }
  | { t: 'ping' }
  | { t: 'pong' };

/* --- methods the daemon calls on the playground -------------------------- */

export interface PlaygroundStateResult {
  readonly name: string;
  readonly soundline: string;
  readonly prompt: string;
  readonly issues: readonly ValidationIssue[];
  readonly peak: number;
  readonly clipped: boolean;
  readonly durationMs: number;
  readonly bytes: number;
  readonly seed: number;
  /** Name/description of the loaded reference, or `null` when none is loaded. */
  readonly reference: string | null;
  readonly names: readonly string[];
}

export interface AuditionParams {
  readonly soundline: string;
  readonly seed?: number;
  readonly loop?: boolean;
  readonly select?: boolean;
}

export interface AuditionResult {
  readonly durationMs: number;
  readonly peak: number;
  readonly clipped: boolean;
}

export interface RenderParams {
  readonly soundline: string;
  readonly seed?: number;
}

export interface RenderResult {
  readonly peak: number;
  readonly clipped: boolean;
  readonly durationMs: number;
  readonly profile: SoundProfile;
  readonly bytes: number;
  readonly withinBudget: boolean;
}

export interface OpenParams {
  readonly soundline: string;
  readonly name: string;
  readonly prompt?: string;
}

export interface CompareParams {
  readonly soundline?: string;
  readonly seed?: number;
}

export interface CompareResult {
  /** Candidate-vs-reference metrics as a markdown table. */
  readonly metrics: string;
  /** What the reference is — a file name, a recipe name. */
  readonly reference: string;
  readonly distance: number;
  readonly directives: readonly string[];
}

export interface FitParams {
  readonly soundline?: string;
  readonly generations?: number;
  readonly seed?: number;
}

export interface FitResult {
  readonly soundline: string;
  readonly initialDistance: number;
  readonly distance: number;
  readonly stopped: string;
}

/* --- methods the playground calls on the daemon -------------------------- */

/** One conversation turn, exactly as `@txt2sfx/agent` shapes them. */
export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** `agent.complete` — a generation request to park until the agent answers. */
export interface CompleteParams {
  readonly turn: number;
  readonly messages: readonly ChatMessage[];
  readonly system: string;
}

export interface CompleteResult {
  readonly text: string;
}

/* --- direction B over HTTP ------------------------------------------------ */

/** What `GET /agent/next` hands the polling agent. */
export interface ParkedRequest {
  readonly id: string;
  readonly turn: number;
  readonly messages: readonly ChatMessage[];
  readonly system: string;
  readonly systemBytes: number;
}

export type NextResult = { readonly request: ParkedRequest } | { readonly none: true };

/* --- HTTP payloads --------------------------------------------------------- */

/** `GET /health` — no token, CORS `*`, and not a secret anywhere in it. */
export interface HealthPayload {
  readonly ok: boolean;
  readonly version: string;
  readonly protocol: number;
  readonly renderer: Renderer;
  readonly tools: readonly string[];
  readonly playgrounds: number;
  readonly agent: AgentStatus;
}

/** `GET /pair` — origin-checked, and the only route that serves the token. */
export interface PairPayload {
  readonly token: string;
  readonly protocol: number;
}

/* --- timeouts -------------------------------------------------------------- */

/**
 * How long a relayed call may wait for the playground.
 *
 * A closed laptop lid must be a clear error, not a hang: the tab's socket stays
 * technically open while the machine sleeps, so without a deadline the MCP
 * client waits forever on a peer that will never answer. Sixty seconds covers
 * every render a browser can do; a fit is a population of renders per
 * generation and legitimately runs minutes, so it gets its own budget.
 */
export const RELAY_TIMEOUT_MS = 60_000;

/** `playground.fit` only — see {@link RELAY_TIMEOUT_MS}. */
export const FIT_TIMEOUT_MS = 600_000;

/** The deadline a relayed method gets, chosen by name in one place. */
export function timeoutForMethod(method: string): number {
  return method === 'playground.fit' ? FIT_TIMEOUT_MS : RELAY_TIMEOUT_MS;
}

/** Default and ceiling for the `timeout` query of `GET /agent/next`. */
export const NEXT_DEFAULT_TIMEOUT_MS = 25_000;
export const NEXT_MAX_TIMEOUT_MS = 120_000;

/* --- recognizing our own -------------------------------------------------- */

/**
 * Does a `/health` answer look like another txt2sfx bridge?
 *
 * Needed by the "port already taken" path: running `npx txt2sfx-bridge` twice
 * should say "already running" and exit 0, not crash — but only when the
 * occupant really is one of us, because exiting quietly while some other
 * service holds the port would hide a real conflict.
 */
export function looksLikeBridge(payload: unknown): payload is HealthPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const health = payload as Record<string, unknown>;
  return (
    health['ok'] === true &&
    typeof health['protocol'] === 'number' &&
    (health['renderer'] === 'playground' || health['renderer'] === 'native' || health['renderer'] === 'none')
  );
}
