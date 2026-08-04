/**
 * Dev-only write-back endpoint for `examples/*.soundline`.
 *
 * The playground's whole point is to shorten the loop between "turn a knob" and
 * "hear the difference", and that loop is only closed if the improved recipe can
 * land back in the repository — otherwise every good take has to be copied out
 * of the browser by hand.
 *
 * Deliberately narrow: `apply: 'serve'` keeps it out of production builds
 * entirely, the only writable directory is `examples/`, and the only accepted
 * file name is `[a-z0-9-]+.soundline`. A playground served to a browser must not
 * become a way to write arbitrary paths on the machine that runs it.
 *
 * @packageDocumentation
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

/** Names we are willing to create or overwrite. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Largest soundline we accept. A recipe is a few hundred bytes; 64 KB is slack. */
const MAX_BYTES = 64 * 1024;

interface SaveRequest {
  readonly name?: unknown;
  readonly source?: unknown;
}

/** Read a request body with a hard size ceiling. */
async function readBody(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.byteLength;
    if (total > MAX_BYTES) throw new Error(`body exceeds ${String(MAX_BYTES)} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Serve `GET /__examples` (list) and `POST /__examples` (save).
 *
 * @param examplesDir Absolute path of the `examples/` directory.
 */
export function examplesFs(examplesDir: string): Plugin {
  const root = resolve(examplesDir);

  /** Resolve a recipe name to a path, or explain why it is not allowed. */
  const pathFor = (name: string): string => {
    if (!NAME_RE.test(name)) {
      throw new Error(`invalid recipe name '${name}' — expected [a-z0-9-]+`);
    }
    const target = resolve(root, `${name}.soundline`);
    // Belt and braces: NAME_RE already excludes separators and dots.
    if (target !== join(root, `${name}.soundline`) || !target.startsWith(root + sep)) {
      throw new Error(`refusing to write outside examples/: ${target}`);
    }
    return target;
  };

  return {
    name: 'txt2sfx:examples-fs',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__examples', (req, res, next) => {
        const send = (status: number, body: unknown): void => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };

        if (req.method === 'GET') {
          void (async () => {
            const files = (await readdir(root)).filter((f) => f.endsWith('.soundline')).sort();
            const recipes = await Promise.all(
              files.map(async (file) => ({
                name: basename(file, '.soundline'),
                source: await readFile(join(root, file), 'utf8'),
              })),
            );
            send(200, { recipes });
          })().catch((error: unknown) => send(500, { error: String(error) }));
          return;
        }

        if (req.method === 'POST') {
          void (async () => {
            const payload = JSON.parse(await readBody(req)) as SaveRequest;
            if (typeof payload.name !== 'string' || typeof payload.source !== 'string') {
              send(400, { error: "expected { name: string, source: string }" });
              return;
            }
            const target = pathFor(payload.name);
            // LF only: `.gitattributes` forces `eol=lf`, and CRLF here would
            // break the round-trip tests the moment the file is committed.
            await writeFile(target, payload.source.replace(/\r\n/g, '\n'), 'utf8');
            server.config.logger.info(`  saved examples/${payload.name}.soundline`);
            send(200, { ok: true, path: `examples/${payload.name}.soundline` });
          })().catch((error: unknown) => send(400, { error: String(error) }));
          return;
        }

        next();
      });
    },
  };
}
