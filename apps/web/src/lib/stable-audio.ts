/**
 * The playground's half of the reference model — over the bridge, or over `pnpm dev`.
 *
 * A diffusion render is the *target*, never the answer: the model returns a few
 * hundred KB of audio, and what this project ships is a recipe. So everything here
 * ends in the same place a dropped file does — `App`'s reference — and from there the
 * existing machinery applies unchanged: A/B in the Compare panel, `match reference`
 * on a generate run, and `⌖ Fit to reference` on the sliders.
 *
 * ## Two transports, one implementation
 *
 * The model runs on the human's machine, and there are exactly two ways this page can
 * reach a process there:
 *
 * - **the bridge** — `npx txt2sfx-bridge`, already connected for the agent, already
 *   carrying its own copy of `run.py`. This is the one that works for a visitor who
 *   has never cloned the repository, which is to say: for everyone. Preferred whenever
 *   a bridge is live.
 * - **the dev server** — `/__stable-audio`, which exists only under `vite dev`. Kept
 *   so a contributor editing this panel does not need a second terminal.
 *
 * Both ends run the same module (`packages/bridge/src/stable-audio.ts`), so the two
 * paths cannot disagree about what is installed or what an argument means. The choice
 * is re-made on every call rather than latched at startup, because starting the bridge
 * while the tab is open is the normal way this goes from "not available" to "ready".
 *
 * ## Why the install is a button here
 *
 * Because the alternative is worse. The weights are gated, the environment is a
 * multi-gigabyte download, and the old answer — "run this in a terminal first" — meant
 * the Model tab's honest state was a paragraph telling you to go somewhere else. What
 * the tab shows now is what the download will fetch, where it will land, the licence to
 * accept and the token to paste, and then every line the child prints. Nothing is
 * hidden behind a spinner, which was the actual objection.
 *
 * @packageDocumentation
 */

import { bridgeClient, type BridgeClient } from './bridge-client.js';

/** One render sitting in the workspace's `out/`, left there by a terminal run. */
export interface RenderFile {
  readonly file: string;
  readonly bytes: number;
  readonly modifiedMs: number;
}

/** How far the installation has got. See `docs/BRIDGE.md`. */
export type ModelStage = 'unavailable' | 'needs-python' | 'needs-venv' | 'needs-weights' | 'ready';

/**
 * What the far end says about itself.
 *
 * Declared here rather than imported from the bridge package, the same way
 * `bridge-client.ts` declares its own frames: this is a client written against the
 * protocol document, and sharing the file would hide the day the two drift.
 */
export interface ModelStatus {
  readonly stage: ModelStage;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly running: 'render' | 'provision' | null;
  readonly reason?: string;
  readonly workDir: string;
  readonly script: string | null;
  readonly venv: {
    readonly path: string;
    readonly present: boolean;
    readonly bytes: number;
    readonly torch: string | null;
  };
  readonly weights: {
    readonly repo: string;
    readonly dir: string;
    readonly present: boolean;
    readonly bytes: number;
  };
  readonly cacheDir: string;
  readonly gated: boolean;
  readonly licenceUrl: string;
  readonly tokensUrl: string;
  readonly hasToken: boolean;
  readonly tokenSource: 'env' | 'file' | null;
  readonly launcher: string | null;
  readonly uv: string | null;
  readonly python: string | null;
  readonly defaults: { readonly seconds: number; readonly steps: number; readonly repo: string };
  readonly renders: readonly RenderFile[];
  /** Which of the two doors answered. Shown, because it decides where the venv is. */
  readonly transport: 'bridge' | 'dev';
}

/** A line of progress, or the outcome. */
export type RenderEvent =
  | { readonly type: 'start'; readonly argv: readonly string[] }
  | { readonly type: 'log'; readonly line: string }
  | {
      readonly type: 'done';
      /** `<slug>-<seed>.mp3`, named by `run.py` — this file exists nowhere on disk. */
      readonly name: string;
      readonly mime: string;
      readonly bytes: number;
      readonly ms: number;
      /** The encoded audio, base64. */
      readonly audio: string;
    }
  | { readonly type: 'error'; readonly message: string };

/** What the panel asks for. Everything but the prompt falls back to `run.py`'s preset. */
export interface RenderRequest {
  readonly prompt: string;
  readonly seconds?: number | undefined;
  readonly steps?: number | undefined;
  readonly seed?: number | undefined;
  /** A Hugging Face repo id, when the machine's cache holds a mirror of the gated one. */
  readonly repo?: string | undefined;
  /**
   * A token for this call only.
   *
   * Never persisted — not to `localStorage`, not through the bank. It lives in the
   * panel's React state and travels in the request the human started, which is exactly
   * what `lib/keystore.ts` documents for a pasted API key.
   */
  readonly token?: string | undefined;
}

/** What an install run is told. */
export interface ProvisionRequest {
  readonly repo?: string | undefined;
  readonly token?: string | undefined;
}

/** How long the browser waits before declaring a call lost. */
const RENDER_TIMEOUT_MS = 15 * 60_000;
/** An install fetches gigabytes on whatever line the machine has. */
const PROVISION_TIMEOUT_MS = 3 * 60 * 60_000;

/** True where the dev endpoint can exist at all — `vite dev`, never a static build. */
export const devEndpointPossible: boolean = import.meta.env.DEV;

/** Is a bridge connected right now? Re-asked per call; a daemon can start any time. */
function bridgeLive(client: BridgeClient): boolean {
  return client.current().state === 'live';
}

/**
 * Read one NDJSON line.
 *
 * Anything unparseable is surfaced as a log line rather than dropped: the far end
 * is a Python process, and the one time it writes something unexpected is exactly
 * the time you want to see it.
 */
export function parseEvent(line: string): RenderEvent | null {
  const text = line.trim();
  if (text === '') return null;
  try {
    const value = JSON.parse(text) as RenderEvent;
    if (typeof value === 'object' && value !== null && typeof value.type === 'string') return value;
    return { type: 'log', line: text };
  } catch {
    return { type: 'log', line: text };
  }
}

/** Base64 from the far end back into the bytes a `File` can be built from. */
function decodeBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

/* --- the bridge transport ---------------------------------------------------- */

/**
 * Call a `model.*` method and forward the daemon's `model.log` events while it runs.
 *
 * The subscription is opened before the call and closed in `finally`, so a panel that
 * is torn down mid-install does not keep a listener alive — and so two panels cannot
 * both narrate one run, since only the socket that asked is sent the events.
 */
async function bridgeCall(
  client: BridgeClient,
  method: string,
  params: Record<string, unknown>,
  options: { onEvent?: (event: RenderEvent) => void; signal?: AbortSignal; timeoutMs: number },
): Promise<unknown> {
  const stop = client.onEvent((event, data) => {
    if (event !== 'model.log') return;
    const parsed = data as RenderEvent;
    if (parsed.type === 'log' || parsed.type === 'start') options.onEvent?.(parsed);
  });
  /* Abort has to reach the child, not just this promise: a torn-off render would
     otherwise keep every core busy for another minute with nobody listening. */
  const onAbort = (): void => void client.call('model.cancel', {}).catch(() => undefined);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await client.call(method, params, options.timeoutMs);
  } finally {
    stop();
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/* --- the dev transport ------------------------------------------------------- */

/** Drive one NDJSON route, reporting every line and returning the `done` event. */
async function devStream(
  path: string,
  body: unknown,
  options: { onEvent?: (event: RenderEvent) => void; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok || response.body === null) {
    /* A refusal is JSON, not a stream: a parameter out of range, or a body too big.
       Its message is the actionable part. */
    const failure = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(failure.error ?? `the model endpoint answered ${String(response.status)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: RenderEvent[] = [];
  let carry = '';

  const take = (line: string): void => {
    const event = parseEvent(line);
    if (event === null) return;
    options.onEvent?.(event);
    events.push(event);
  };

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const parts = (carry + decoder.decode(chunk.value, { stream: true })).split('\n');
    carry = parts.pop() ?? '';
    for (const part of parts) take(part);
  }
  if (carry !== '') take(carry);

  /* The first failure rather than the last: an error is terminal on the far end, and
     anything after it is fallout. */
  const failure = events.find((event) => event.type === 'error');
  if (failure !== undefined) throw new Error(failure.message);
  const done = events.find((event) => event.type === 'done');
  if (done === undefined) throw new Error('the run ended without an outcome');
  return done as unknown as Record<string, unknown>;
}

/* --- the three things the panel does ------------------------------------------ */

/**
 * Ask whichever door is open what it can do.
 *
 * @returns Null when neither is — a static build with no bridge running, which is the
 *   ordinary state of a first visit and not an error worth reporting anywhere.
 */
export async function modelStatus(
  params: { readonly repo?: string } = {},
  client: BridgeClient = bridgeClient,
): Promise<ModelStatus | null> {
  /* The repo travels with the question because the answer depends on it: a community
     mirror lives in a different cache directory, is not behind the licence click, and
     may well be the one already on this disk. Asking about the default and reporting
     "not downloaded" to somebody who has the weights would be wrong twice over. */
  const query = params.repo === undefined || params.repo === '' ? '' : `?repo=${encodeURIComponent(params.repo)}`;

  if (bridgeLive(client)) {
    try {
      const status = (await client.call('model.status', { ...params }, 30_000)) as ModelStatus;
      return { ...status, transport: 'bridge' };
    } catch {
      /* An older bridge answers `unsupported`. Fall through to the dev endpoint
         rather than reporting a failure the user cannot act on from here. */
    }
  }
  if (!devEndpointPossible) return null;
  try {
    const response = await fetch(`/__stable-audio${query}`);
    if (!response.ok) return null;
    return { ...((await response.json()) as ModelStatus), transport: 'dev' };
  } catch {
    return null;
  }
}

/**
 * Build the environment and download the weights, reporting every line.
 *
 * @returns The status afterwards, so the panel can redraw itself from one answer.
 * @throws With the child's own words — a licence gate, a missing interpreter, a full
 *   disk. Each of those has a different fix and the message is the only place it is
 *   written down.
 */
export async function provisionModel(
  request: ProvisionRequest = {},
  options: { onEvent?: (event: RenderEvent) => void; signal?: AbortSignal; client?: BridgeClient } = {},
): Promise<ModelStatus> {
  const client = options.client ?? bridgeClient;
  if (bridgeLive(client)) {
    const result = (await bridgeCall(client, 'model.provision', { ...request }, {
      ...options,
      timeoutMs: PROVISION_TIMEOUT_MS,
    })) as { status: ModelStatus };
    return { ...result.status, transport: 'bridge' };
  }
  const done = await devStream('/__stable-audio/provision', request, options);
  return { ...(done['status'] as ModelStatus), transport: 'dev' };
}

/**
 * Render a prompt with Stable Audio, reporting progress as it arrives.
 *
 * @returns The render itself, named as `run.py` named it and not written to disk.
 * @throws When the far end refuses, the child fails, or the caller aborts.
 */
export async function renderTarget(
  request: RenderRequest,
  options: { onEvent?: (event: RenderEvent) => void; signal?: AbortSignal; client?: BridgeClient } = {},
): Promise<File> {
  const client = options.client ?? bridgeClient;

  if (bridgeLive(client)) {
    const done = (await bridgeCall(client, 'model.render', { ...request }, {
      ...options,
      timeoutMs: RENDER_TIMEOUT_MS,
    })) as { name: string; mime: string; bytes: number; ms: number; audio: string };
    options.onEvent?.({ type: 'done', ...done });
    return new File([decodeBase64(done.audio)], done.name, { type: done.mime });
  }

  const done = await devStream('/__stable-audio', request, options);
  return new File([decodeBase64(String(done['audio']))], String(done['name']), {
    type: String(done['mime']),
  });
}
