/**
 * The playground's half of the Stable Audio endpoint.
 *
 * A diffusion render is the *target*, never the answer: the model returns 1–2 MB
 * of WAV, and what this project ships is a recipe. So everything here ends in the
 * same place a dropped file does — `App`'s reference — and from there the existing
 * machinery applies unchanged: A/B in the Compare panel, `match reference` on a
 * generate run, and `⌖ Fit to reference` on the sliders.
 *
 * Never throws for "the endpoint is not there": a static build has no dev server,
 * and the panel simply does not appear. See `plugins/stable-audio.ts` for what is
 * on the other end and why it refuses to provision anything.
 *
 * @packageDocumentation
 */

/** One render already sitting in `test/stable-audio/out/`. */
export interface RenderFile {
  readonly file: string;
  readonly bytes: number;
  readonly modifiedMs: number;
}

/** What the endpoint says about itself. */
export interface StableAudioStatus {
  readonly ready: boolean;
  readonly reason?: string;
  readonly busy: boolean;
  readonly renders: readonly RenderFile[];
  readonly defaults: { readonly seconds: number; readonly steps: number; readonly repo: string };
  /** Whether the dev server can see an `HF_TOKEN` — the gated default needs one. */
  readonly hasToken: boolean;
}

/** A line of progress, or the outcome. Mirrors the plugin's `RenderEvent`. */
export type RenderEvent =
  | { readonly type: 'start'; readonly argv: readonly string[] }
  | { readonly type: 'log'; readonly line: string }
  | { readonly type: 'done'; readonly file: string; readonly ms: number }
  | { readonly type: 'error'; readonly message: string };

/** What the panel asks for. Everything but the prompt falls back to `run.py`'s preset. */
export interface RenderRequest {
  readonly prompt: string;
  readonly seconds?: number | undefined;
  readonly steps?: number | undefined;
  readonly seed?: number | undefined;
  /** A Hugging Face repo id, when the machine's cache holds a mirror of the gated one. */
  readonly repo?: string | undefined;
}

/** True where the dev endpoint can exist at all. */
export const stableAudioSupported: boolean = import.meta.env.DEV;

/** Where a finished render can be fetched from. */
export function renderUrl(file: string): string {
  return `/__stable-audio/out/${encodeURIComponent(file)}`;
}

/**
 * Ask the endpoint what it can do.
 *
 * @returns Null when there is no endpoint — a static build, or the plugin removed.
 */
export async function stableAudioStatus(): Promise<StableAudioStatus | null> {
  if (!stableAudioSupported) return null;
  try {
    const response = await fetch('/__stable-audio');
    if (!response.ok) return null;
    return (await response.json()) as StableAudioStatus;
  } catch {
    return null;
  }
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

/**
 * Render a prompt with Stable Audio, reporting progress as it arrives.
 *
 * The response is a stream because the render is tens of seconds of CPU: the
 * child's own lines ("loaded in 10.1s on cpu", "sampled in 8.1s, decoding 3s") are
 * the only honest progress, and a spinner in their place would hide the model
 * download, the licence gate, and every other reason a first run takes minutes.
 *
 * @returns The file name of the render, resolvable with {@link renderUrl}.
 * @throws When the endpoint refuses, the child fails, or the caller aborts.
 */
export async function renderTarget(
  request: RenderRequest,
  options: { onEvent?: (event: RenderEvent) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const response = await fetch('/__stable-audio', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok || response.body === null) {
    /* A refusal is JSON, not a stream: no venv, another render in flight, or a
       parameter out of range. Its message is the actionable part. */
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `stable-audio endpoint answered ${String(response.status)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let file: string | null = null;
  let failure: string | null = null;

  const take = (line: string): void => {
    const event = parseEvent(line);
    if (event === null) return;
    options.onEvent?.(event);
    if (event.type === 'done') file = event.file;
    if (event.type === 'error') failure = event.message;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const parts = (carry + decoder.decode(value, { stream: true })).split('\n');
    carry = parts.pop() ?? '';
    for (const part of parts) take(part);
  }
  if (carry !== '') take(carry);

  if (failure !== null) throw new Error(failure);
  if (file === null) throw new Error('the render ended without producing a file');
  return file;
}

/** Fetch a finished render as a `File`, ready for the reference decoder. */
export async function fetchRender(file: string): Promise<File> {
  const response = await fetch(renderUrl(file));
  if (!response.ok) throw new Error(`${file} → HTTP ${String(response.status)}`);
  return new File([await response.blob()], file, { type: 'audio/wav' });
}
