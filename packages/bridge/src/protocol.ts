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

/* --- the reference model, `model.*` --------------------------------------- */

/**
 * How far the local Stable Audio installation has got.
 *
 * An ordered story rather than a boolean, because the Model tab shows a different
 * screen for each step and "not ready" alone would leave it saying so without saying
 * what to press. `unavailable` is the only one nothing on the machine can fix.
 */
export type ModelStage = 'unavailable' | 'needs-python' | 'needs-venv' | 'needs-weights' | 'ready';

/** A render a terminal run left in the workspace's `out/`. */
export interface RenderFile {
  readonly file: string;
  readonly bytes: number;
  readonly modifiedMs: number;
}

/**
 * `model.status` — what is installed, where, and how much of the disk it took.
 *
 * The paths and the byte counts are in the payload because the panel is asked to show
 * them: an installation that quietly puts six gigabytes somewhere is a thing people
 * discover when a disk fills, and the tab that started it is the honest place to say
 * so. They are measured, never assumed — see `stable-audio.ts`.
 */
export interface ModelStatus {
  readonly stage: ModelStage;
  /** True exactly when a render can start right now. */
  readonly ready: boolean;
  readonly busy: boolean;
  /** What the busy child is doing, or null. */
  readonly running: 'render' | 'provision' | null;
  /** Why not, when `ready` is false and there is something actionable to say. */
  readonly reason?: string;
  /** Where `run.py`, the venv and `out/` live. */
  readonly workDir: string;
  readonly script: string | null;
  readonly venv: {
    readonly path: string;
    readonly present: boolean;
    readonly bytes: number;
    /** `cpu`, `cu128`, `''` for a venv from before the stamp, or null when absent. */
    readonly torch: string | null;
  };
  readonly weights: {
    readonly repo: string;
    readonly dir: string;
    readonly present: boolean;
    readonly bytes: number;
  };
  /** The shared Hugging Face cache the weights go into. */
  readonly cacheDir: string;
  /** Whether this repo is the one behind Stability's licence click. */
  readonly gated: boolean;
  readonly licenceUrl: string;
  readonly tokensUrl: string;
  readonly hasToken: boolean;
  readonly tokenSource: 'env' | 'file' | null;
  /** How `run.py` would be started from cold, for the panel to name. */
  readonly launcher: string | null;
  readonly uv: string | null;
  readonly python: string | null;
  readonly defaults: { readonly seconds: number; readonly steps: number; readonly repo: string };
  readonly renders: readonly RenderFile[];
}

/** What the panel may ask for. Everything is optional but the prompt. */
export interface ModelRenderParams {
  readonly prompt?: unknown;
  readonly seconds?: unknown;
  readonly steps?: unknown;
  readonly seed?: unknown;
  readonly model?: unknown;
  readonly repo?: unknown;
  /**
   * A Hugging Face token for this call only.
   *
   * Never stored and never written to a file: it travels in the request the human
   * started, is handed to the child in its environment, and dies with the process —
   * the same contract `apps/web/src/lib/keystore.ts` documents for a pasted API key.
   */
  readonly token?: string | undefined;
}

/** `model.render` — the audio, in the answer, because nothing was written down. */
export interface ModelRenderResult {
  /** `<slug>-<seed>.mp3` — named by `run.py`, so the naming rule has one home. */
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
  readonly ms: number;
}

/** `model.provision` — build the environment and fetch the weights. */
export interface ModelProvisionParams {
  readonly repo?: string | undefined;
  readonly model?: string | undefined;
  readonly token?: string | undefined;
  /** Provision the CPU torch wheels even on a GPU box — saves a ~3 GB download. */
  readonly cpuTorch?: boolean | undefined;
}

export interface ModelProvisionResult {
  /** The status as it is *after* the run, so the caller need not ask again. */
  readonly status: ModelStatus;
  readonly torch?: string;
  readonly device?: string;
}

/**
 * One line of a running child, or the command it was started with.
 *
 * A first install downloads gigabytes and a CPU render takes tens of seconds; the
 * child's own lines ("loaded in 10.1s on cpu", a pip resolver, a download bar) are the
 * only honest progress there is, and a spinner in their place would hide the licence
 * gate, the download and every other reason a run is slow. These reach the playground
 * as `model.log` events on the socket that asked.
 */
export type ModelEvent =
  | { readonly type: 'start'; readonly argv: readonly string[] }
  | { readonly type: 'log'; readonly line: string };

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
