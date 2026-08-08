/**
 * Dev-only HTTP door to the reference model, for a playground with no bridge running.
 *
 * ## What is left here, and what moved
 *
 * Everything that *does* the work — locating `run.py`, deciding what is installed,
 * building the argv, spawning the child, reading its result line — now lives in
 * `packages/bridge/src/stable-audio.ts`, because the bridge is what a user who does
 * not have this repository installs. A second spawn path in this file would be a
 * second definition of the licence gate and of the argv, wrong the first time either
 * moved. What remains is the transport: four routes, NDJSON, `apply: 'serve'`.
 *
 * It stays because `pnpm dev` should not require a second terminal. A contributor
 * editing the panel gets the model through Vite; everyone else gets it through
 * `npx txt2sfx-bridge`, and `apps/web/src/lib/stable-audio.ts` prefers the bridge when
 * one is connected. Both roads end in the same module.
 *
 * The module note there explains why provisioning is now offered from a page at all,
 * having once been refused: the objection was to a licence gate behind a spinner, and
 * the Model tab now shows the licence, the target directory and every line the child
 * prints.
 *
 * @packageDocumentation
 */

import type { Plugin } from 'vite';
import { StableAudio } from '../../../packages/bridge/src/stable-audio.js';
import type {
  ModelEvent,
  ModelProvisionParams,
  ModelRenderParams,
} from '../../../packages/bridge/src/protocol.js';

/** Largest request body. The body is a prompt, four numbers and maybe a token. */
const MAX_BODY = 8 * 1024;

/**
 * One line of a run, as the browser reads it.
 *
 * The same union `lib/stable-audio.ts` parses, and deliberately *not* the bridge's
 * `ModelEvent`: `done` carries the outcome, which differs between a render (audio,
 * base64) and an install (the status afterwards), and neither exists on the wire the
 * child speaks.
 */
export type StreamEvent =
  | ModelEvent
  | { readonly type: 'done'; readonly [key: string]: unknown }
  | { readonly type: 'error'; readonly message: string };

/** Read a request body with a hard size ceiling. */
async function readBody(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.byteLength;
    if (total > MAX_BODY) throw new Error(`body exceeds ${String(MAX_BODY)} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Serve `/__stable-audio` — status, install, render, and the renders left in `out/`.
 *
 * @param stableAudioDir Absolute path of `test/stable-audio`.
 */
export function stableAudio(stableAudioDir: string): Plugin {
  /* One instance for the dev server, so the "one child at a time" lock is real: torch
     saturates every core, and two renders would each take twice as long as one. */
  const model = new StableAudio({ dir: stableAudioDir });

  return {
    name: 'txt2sfx:stable-audio',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__stable-audio', (req, res, next) => {
        const send = (status: number, body: unknown): void => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };
        /* `use('/prefix')` strips the prefix, so this is '/', '/out/x.wav', … */
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = url.pathname;

        /**
         * Run one job and narrate it.
         *
         * NDJSON rather than one JSON at the end: an install downloads gigabytes and a
         * CPU render is tens of seconds of silence otherwise, and the child's own lines
         * are the only honest progress there is.
         */
        const stream = async (job: (emit: (event: StreamEvent) => void) => Promise<unknown>): Promise<void> => {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          const emit = (event: StreamEvent): void => {
            res.write(`${JSON.stringify(event)}\n`);
          };
          try {
            const done = await job(emit);
            emit({ type: 'done', ...(done as Record<string, unknown>) });
          } catch (error: unknown) {
            emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
          }
          res.end();
        };

        if (req.method === 'GET' && path === '/') {
          /* `?repo=` asks about a mirror rather than the default checkpoint — a
             different cache directory, and not behind the licence click. */
          const repo = url.searchParams.get('repo');
          void model
            .status(repo === null || repo === '' ? {} : { repo })
            .then((status) => send(200, status))
            .catch((error: unknown) => send(500, { error: String(error) }));
          return;
        }

        if (req.method === 'GET' && path.startsWith('/out/')) {
          void (async () => {
            const { bytes, mime } = await model.read(decodeURIComponent(path.slice('/out/'.length)));
            res.statusCode = 200;
            res.setHeader('content-type', mime);
            res.setHeader('content-length', String(bytes.byteLength));
            /* Named after its seed and never rewritten with different audio, but a
               dev server has no business teaching a browser to keep anything. */
            res.setHeader('cache-control', 'no-cache');
            res.end(bytes);
          })().catch((error: unknown) => send(404, { error: String(error) }));
          return;
        }

        if (req.method === 'POST' && (path === '/' || path === '/provision')) {
          void (async () => {
            let asked: Record<string, unknown>;
            try {
              asked = JSON.parse(await readBody(req)) as Record<string, unknown>;
            } catch (error: unknown) {
              send(400, { error: error instanceof Error ? error.message : String(error) });
              return;
            }

            /* The Stop button has to work, and so does closing the tab: a run nobody
               is waiting for is eight cores of nothing, or a download into a void. */
            const onClose = (): void => void model.cancel();
            res.on('close', onClose);
            try {
              await stream(async (emit) => {
                const forward = (event: ModelEvent): void => emit(event);
                if (path === '/provision') {
                  const result = await model.provision(asked as ModelProvisionParams, forward);
                  return { status: result.status };
                }
                const result = await model.render(asked as ModelRenderParams, forward);
                const { audio, ...rest } = result;
                /* The render came down in the child's stdout and was never written to
                   `out/`, so there is nothing to fetch afterwards — the bytes travel
                   in the last line, ~130 KB of base64 for a three-second MP3. */
                return { ...rest, audio: audio.toString('base64') };
              });
            } finally {
              res.off('close', onClose);
            }
          })().catch((error: unknown) => {
            if (!res.headersSent) send(500, { error: String(error) });
            else res.end();
          });
          return;
        }

        next();
      });
    },
  };
}
