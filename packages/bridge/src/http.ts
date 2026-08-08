/**
 * The loopback HTTP surface: `/health`, `/pair`, `/tools*`, `/agent/*`, and the
 * WS upgrade.
 *
 * `node:http` and nothing else — the zero-dependency rule again — and bound to
 * `127.0.0.1` by the caller, never here overridable by a header. The routes
 * split by what guards them, and the split is the security model:
 *
 * - `/health` is open and secret-free: it is the playground badge's heartbeat
 *   and the "is that occupant one of us?" probe, and either would be defeated
 *   by a token requirement.
 * - `/pair` is gated on `Origin` because loopback is not a boundary in a
 *   browser — same-origin policy does not apply to WebSockets, so any page
 *   could open `ws://127.0.0.1:4455` if the token were free to fetch. The list
 *   is localhost, {@link PLAYGROUND_ORIGIN} and whatever `--allow-origin`
 *   adds; each is argued for where it is defined. A request *without* an
 *   `Origin` header is allowed: browsers always attach one to cross-origin
 *   fetches, so its absence means curl or Node, which can read the token file
 *   anyway.
 * - `/agent/*` takes the token in `x-txt2sfx-token`: these are called by local
 *   processes that read `~/.txt2sfx/bridge.json`, and origin means nothing to
 *   them.
 * - `/tools*` takes the same token and runs the twelve directly — the same
 *   dispatch the MCP server calls, one route deep.
 *
 * ## Why the tools are on HTTP as well as on stdio
 *
 * MCP is the better door: the client gets names, descriptions and JSON schemas
 * in its own tool list, and the model picks from them without being told. But
 * registering a server costs a restart of the client, and no prompt can perform
 * a restart — which makes "paste this and go" impossible for the one shape of
 * onboarding people actually use. An agent that can run `curl` can use every
 * tool through `POST /tools/<name>` in the turn it was asked, and read the
 * schemas from `GET /tools` instead of from its tool list. Same context, same
 * dispatch, same words back; only the transport is worse.
 *
 * A tool that fails answers `200` with `ok: false`, never a 4xx. The reason is
 * the one `tools.ts` gives for `isError`: "your soundline does not parse" is an
 * answer the model must read and act on, and a caller who has been taught that
 * non-2xx means plumbing will retry it or, worse, hide the text that says how
 * to fix it. Status codes here describe the *route*, not the sound.
 *
 * The WS upgrade requires **both** a valid token and an acceptable origin —
 * the token to keep hostile pages out, the origin check as the second lock in
 * case a token ever leaks into a log.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Hub } from './hub.js';
import type { ToolHub } from './hub.js';
import { NoPlaygroundError } from './hub.js';
import type { Log } from './log.js';
import {
  NEXT_DEFAULT_TIMEOUT_MS,
  NEXT_MAX_TIMEOUT_MS,
  PROTOCOL_VERSION,
  timeoutForMethod,
} from './protocol.js';
import type { AgentStatus, Frame, HealthPayload, NextResult } from './protocol.js';
import { TOOLS, runTool, type ToolContext } from './tools.js';
import { acceptUpgrade } from './ws.js';

/** Bodies past this are refused. The largest legitimate payload is a parked
 * conversation — a 12 KB system prompt plus a few turns — so 4 MiB is not a
 * limit, it is a tripwire. */
const MAX_BODY = 4 * 1024 * 1024;

/** Options of {@link createBridgeServer}. */
export interface BridgeServerOptions {
  readonly hub: Hub;
  readonly token: string;
  readonly version: string;
  readonly toolNames: readonly string[];
  /** Everything the tools need, so `/tools/<name>` can run them here. */
  readonly toolContext: ToolContext;
  /** Extra allowed origins, verbatim, from `--allow-origin`. */
  readonly allowOrigins: readonly string[];
  readonly log: Log;
}

/**
 * The published playground, allowed to pair without a flag.
 *
 * ## Why the default list is not only localhost
 *
 * The argument for this daemon is "code that must run on the human's machine,
 * reached from a page that may be served from anywhere". For almost everyone the
 * page served from anywhere is *this* one — and until it was on this list, the
 * advertised path failed by default: a visitor got a 403 from `/pair`, and the
 * sentence explaining which flag fixes it was two clicks deep, inside the bridge
 * dialog. A default that makes the documented workflow fail is a bug in the
 * default, not a lesson for the user.
 *
 * ## What it grants, stated plainly
 *
 * Everything pairing grants: this origin can read the token from `/pair`, open
 * the WebSocket, and drive the playground methods — render, audition, measure,
 * fit, and write into whatever `--allow-write` was given. That is the same trust
 * already implied by running `npx txt2sfx-bridge` and opening this page, which is
 * the only reason the daemon is running at all.
 *
 * What it is *not* is a blanket "any https page": one exact origin, compared whole,
 * with no port and no wildcard. Every other origin still needs `--allow-origin`.
 *
 * ## The residual risk, because it is worth writing down
 *
 * This is a `*.github.io` host, and GitHub serves every repository of the same
 * owner from it — an organization site at `/` and any project site at `/<repo>/`.
 * Today `/` is the whole origin: Pages is off on the source repository and the
 * site repository holds nothing but the built playground. But a future repository
 * in that organization could publish a page there and inherit this trust, which is
 * exactly the argument for moving to a domain the project owns end to end.
 */
export const PLAYGROUND_ORIGIN = 'https://txt2sfx.github.io';

/**
 * Is this `Origin` allowed to pair?
 *
 * `http://localhost:*` and `http://127.0.0.1:*` on any port, because the
 * playground's dev port is Vite's choice, not ours; {@link PLAYGROUND_ORIGIN},
 * for the reasons above. Extras are matched verbatim — a user who passes
 * `--allow-origin https://sfx.example.com` meant exactly that string, and
 * prefix-matching user input is how allowlists grow holes.
 */
export function originAllowed(origin: string | undefined, extra: readonly string[]): boolean {
  if (origin === undefined) return true; // not a browser; see the module note
  if (origin === PLAYGROUND_ORIGIN) return true;
  if (extra.includes(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/** Read a JSON body, refusing anything oversized or malformed. */
function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed: unknown = text === '' ? {} : JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null) {
          reject(new Error('body must be a JSON object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown, cors?: string): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...(cors === undefined ? {} : { 'access-control-allow-origin': cors, vary: 'Origin' }),
  });
  response.end(text);
}

/** Build the server. Listening is the caller's job — tests use port 0. */
export function createBridgeServer(options: BridgeServerOptions): Server {
  const { hub, token, version, toolNames, toolContext, allowOrigins, log } = options;

  const authorized = (request: IncomingMessage): boolean =>
    request.headers['x-txt2sfx-token'] === token;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      log(`http: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'internal', message: 'the bridge hit an internal error; see its stderr' });
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': origin ?? '*',
        'access-control-allow-headers': 'content-type, x-txt2sfx-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const resolution = await hub.renderer();
      const payload: HealthPayload = {
        ok: true,
        version,
        protocol: PROTOCOL_VERSION,
        renderer: resolution.renderer,
        tools: toolNames,
        playgrounds: hub.playgroundCount(),
        agent: hub.agentStatus(),
      };
      sendJson(response, 200, payload, '*');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/pair') {
      if (!originAllowed(origin, allowOrigins)) {
        sendJson(response, 403, {
          error: 'forbidden-origin',
          message: `${origin ?? 'this origin'} may not pair — the bridge pairs with localhost pages, with ${PLAYGROUND_ORIGIN}, and with origins passed via --allow-origin`,
        });
        return;
      }
      sendJson(response, 200, { token, protocol: PROTOCOL_VERSION }, origin ?? '*');
      return;
    }

    if (url.pathname === '/tools' || url.pathname.startsWith('/tools/')) {
      if (!authorized(request)) {
        sendJson(response, 401, {
          error: 'bad-token',
          message: 'missing or wrong x-txt2sfx-token — the token lives in ~/.txt2sfx/bridge.json next to the port',
        });
        return;
      }

      /* The schemas, because a curl client has no tool list to read them from.
         The same three fields `tools/list` returns over MCP, so a model that
         has seen one recognises the other. */
      if (request.method === 'GET' && url.pathname === '/tools') {
        sendJson(response, 200, {
          tools: TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/tools/')) {
        const name = decodeURIComponent(url.pathname.slice('/tools/'.length));
        if (!TOOLS.some((tool) => tool.name === name)) {
          /* Names, not a bare 404: the caller guessed once and will guess
             again unless the answer is the list it should have read. */
          sendJson(response, 404, {
            error: 'no-tool',
            message: `no tool named "${name}" — GET /tools lists them with their schemas`,
            tools: TOOLS.map((tool) => tool.name),
          });
          return;
        }
        let args: Record<string, unknown>;
        try {
          args = await readJson(request);
        } catch (error) {
          sendJson(response, 400, {
            error: 'bad-args',
            message: `${error instanceof Error ? error.message : String(error)} — the body must be the tool's arguments as a JSON object, e.g. {"soundline":"sound \\"pop\\" 200ms pop"}`,
          });
          return;
        }
        const result = await runTool(name, args, toolContext);
        sendJson(response, 200, {
          ok: result.isError !== true,
          text: result.content.map((block) => block.text).join('\n'),
        });
        return;
      }
    }

    if (url.pathname.startsWith('/agent/')) {
      if (!authorized(request)) {
        sendJson(response, 401, {
          error: 'bad-token',
          message: 'missing or wrong x-txt2sfx-token — the token lives in ~/.txt2sfx/bridge.json next to the port',
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/agent/call') {
        const body = await readJson(request);
        const method = body['method'];
        if (typeof method !== 'string') {
          sendJson(response, 400, { error: 'bad-call', message: 'body must be { method, params }' });
          return;
        }
        try {
          const result = await hub.callPlayground(method, body['params'], timeoutForMethod(method));
          sendJson(response, 200, result ?? null);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          /* Status by failure class so the remote ToolHub can tell "fix the
             tab" from "the tab said no": 503 no tab, 504 no answer, 502 the
             playground answered with an error of its own. */
          const status =
            error instanceof NoPlaygroundError ? 503 : message.includes('did not answer') ? 504 : 502;
          sendJson(response, status, { error: 'relay-failed', message });
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/agent/next') {
        const raw = Number(url.searchParams.get('timeout') ?? NEXT_DEFAULT_TIMEOUT_MS);
        const timeout = Number.isFinite(raw)
          ? Math.min(Math.max(raw, 0), NEXT_MAX_TIMEOUT_MS)
          : NEXT_DEFAULT_TIMEOUT_MS;
        sendJson(response, 200, await hub.nextRequest(timeout));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/agent/answer') {
        const body = await readJson(request);
        const ok =
          typeof body['id'] === 'string' && typeof body['text'] === 'string'
            ? hub.answer(body['id'], body['text'])
            : false;
        if (ok) sendJson(response, 200, { ok: true });
        else
          sendJson(response, 409, {
            error: 'stale-id',
            message: 'that request is not waiting — it was already answered, or the playground went away',
          });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/agent/fail') {
        const body = await readJson(request);
        const ok =
          typeof body['id'] === 'string' && typeof body['message'] === 'string'
            ? hub.fail(body['id'], body['message'])
            : false;
        if (ok) sendJson(response, 200, { ok: true });
        else
          sendJson(response, 409, {
            error: 'stale-id',
            message: 'that request is not waiting — it was already answered, or the playground went away',
          });
        return;
      }
    }

    sendJson(response, 404, {
      error: 'no-route',
      message: `${request.method ?? 'GET'} ${url.pathname} is not a route. Start at GET /health.`,
    });
  }

  /* Sockets that completed the WS upgrade leave `http.Server`'s books —
     `closeAllConnections()` does not know them, so `server.close()` would wait
     forever on one connected tab. Track them here and destroy them when the
     server is asked to close; without this, every test teardown and every
     Ctrl-C with a playground open hangs. */
  const upgraded = new Set<Duplex>();
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    for (const socket of upgraded) socket.destroy();
    upgraded.clear();
    return close(callback);
  }) as typeof server.close;

  server.on('upgrade', (request, socket: Duplex) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;

    const refuse = (status: number, message: string): void => {
      socket.write(`HTTP/1.1 ${String(status)} ${message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    if (url.pathname !== '/ws') {
      refuse(404, 'Not Found');
      return;
    }
    if (url.searchParams.get('token') !== token) {
      refuse(401, 'Unauthorized');
      return;
    }
    if (!originAllowed(origin, allowOrigins)) {
      refuse(403, 'Forbidden');
      return;
    }

    /* Adapter first, port second: the hub wants something it can hand frames
       to before the first byte arrives. */
    const port = {
      send: (frame: Frame): void => connection.send(JSON.stringify(frame)),
      close: (): void => connection.close(),
    };
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    const connection = acceptUpgrade(request, socket, {
      onMessage: (text) => {
        let frame: Frame;
        try {
          frame = JSON.parse(text) as Frame;
        } catch {
          log('ws: dropped a frame that was not JSON');
          return;
        }
        hub.handleFrame(port, frame);
      },
      onClose: () => hub.detach(port),
    });
    hub.attach(port);
  });

  return server;
}

/* --- the client side of the same wire -------------------------------------- */

/** One loopback JSON exchange over `node:http`, with no client-side deadline.
 *
 * Not `fetch`: undici gives up waiting for response headers after 300 s, and a
 * relayed `playground.fit` legitimately holds its response open for up to ten
 * minutes — the daemon owns the deadlines, and a second, shorter one on the
 * client turns a working fit into a mystery abort at exactly five minutes. */
function loopbackJson(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      url,
      {
        method,
        headers: {
          ...headers,
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: response.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) });
          } catch {
            reject(new Error(`the daemon answered ${String(response.statusCode)} with a body that was not JSON`));
          }
        });
      },
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

/**
 * A {@link ToolHub} over a *remote* daemon — `--stdio` next to an already
 * running bridge. Lives in this file rather than beside the server routes'
 * consumers so the two halves of each path cannot drift without the diff
 * showing them side by side.
 */
export function remoteToolHub(baseUrl: string, token: string): ToolHub {
  const auth = { 'x-txt2sfx-token': token };

  const health = async (): Promise<{ playgrounds: number; agent: AgentStatus }> => {
    const answer = await loopbackJson('GET', `${baseUrl}/health`, {});
    return answer.body as { playgrounds: number; agent: AgentStatus };
  };

  return {
    async callPlayground(method, params): Promise<unknown> {
      const answer = await loopbackJson('POST', `${baseUrl}/agent/call`, auth, { method, params });
      if (answer.status < 200 || answer.status >= 300) {
        const body = answer.body as Record<string, unknown> | null;
        const message =
          body !== null && typeof body['message'] === 'string'
            ? body['message']
            : `the daemon answered ${String(answer.status)}`;
        throw new Error(message);
      }
      return answer.body;
    },

    async nextRequest(timeoutMs): Promise<NextResult> {
      const answer = await loopbackJson('GET', `${baseUrl}/agent/next?timeout=${String(timeoutMs)}`, auth);
      return answer.body as NextResult;
    },

    async answer(id, text): Promise<boolean> {
      return (await loopbackJson('POST', `${baseUrl}/agent/answer`, auth, { id, text })).status === 200;
    },

    async fail(id, message): Promise<boolean> {
      return (await loopbackJson('POST', `${baseUrl}/agent/fail`, auth, { id, message })).status === 200;
    },

    async agentStatus(): Promise<AgentStatus> {
      return (await health()).agent;
    },

    async playgroundConnected(): Promise<boolean> {
      return (await health()).playgrounds > 0;
    },
  };
}
