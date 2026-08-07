/**
 * The MCP server: newline-delimited JSON-RPC 2.0 over stdio, hand-rolled.
 *
 * Hand-rolled for the same reason as the WebSocket server — zero runtime
 * dependencies is a project value — and because the subset is small: MCP over
 * stdio is one JSON object per line, no `Content-Length` framing (that is the
 * LSP convention, and mixing the two is the classic way to hang both ends).
 *
 * Two distinctions this file must not blur, because clients genuinely behave
 * differently on each side of them:
 *
 * - **A tool failure is a result, not an error.** `{ content, isError: true }`
 *   reaches the model, which can read "your soundline does not parse" and fix
 *   it. A JSON-RPC error object is plumbing — clients surface it as a retry or
 *   a crash, and the model never sees the message it needed.
 * - **A notification gets no reply, ever.** Answering `notifications/initialized`
 *   with a result violates JSON-RPC and confuses strict clients into treating
 *   the stray reply as the answer to their *next* request.
 *
 * Sampling: when the client's `initialize` advertises the `sampling`
 * capability, this server registers a fulfiller with the hub, and direction B
 * jobs are answered by a `sampling/createMessage` server→client request
 * instead of parking — the human presses Generate and watches the recipe
 * appear, no polling. When that request errors (user declined, client gone),
 * the hub falls back to parking and the two polling tools still work.
 *
 * @packageDocumentation
 */

import type { Readable, Writable } from 'node:stream';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Hub } from './hub.js';
import type { Log } from './log.js';
import type { ChatMessage, ParkedRequest } from './protocol.js';
import { TOOLS, runTool, type ToolContext } from './tools.js';

/** The one protocol revision this server speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** JSON-RPC 2.0 error codes we can emit. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
/** MCP's "resource not found". */
const RESOURCE_NOT_FOUND = -32002;

/** How long a sampling round trip may take: a model call plus a human approving it. */
const SAMPLING_TIMEOUT_MS = 600_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Options of {@link createMcpServer}. */
export interface McpServerOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly ctx: ToolContext;
  /**
   * The in-process hub, when there is one. Absent in remote mode (`--stdio`
   * beside a running daemon), where sampling cannot be registered — the jobs
   * park at the daemon and the polling tools are the path.
   */
  readonly hub?: Hub;
  readonly version: string;
  readonly log: Log;
}

/** A running server. `done` settles when the client goes away. */
export interface McpServer {
  readonly done: Promise<void>;
  close(): void;
}

/** Start serving. Reads `input` until it ends; writes only JSON-RPC to `output`. */
export function createMcpServer(options: McpServerOptions): McpServer {
  const { input, output, ctx, hub, version, log } = options;

  let clientName = 'unknown client';
  let clientSampling = false;
  let initialized = false;
  let closed = false;

  /** Server→client requests in flight, by our own id space. */
  let outboundSequence = 0;
  const outbound = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  let resolveDone: () => void;
  const done = new Promise<void>((resolvePromise) => {
    resolveDone = resolvePromise;
  });

  const write = (message: object): void => {
    if (closed) return;
    output.write(`${JSON.stringify(message)}\n`);
  };

  const reply = (id: string | number | null, result: unknown): void =>
    write({ jsonrpc: '2.0', id, result });

  const replyError = (id: string | number | null, code: number, message: string): void =>
    write({ jsonrpc: '2.0', id, error: { code, message } });

  const sendRequest = (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
    const id = `srv-${++outboundSequence}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        outbound.delete(id);
        reject(new Error(`the client did not answer ${method} within ${String(Math.round(timeoutMs / 1000))}s`));
      }, timeoutMs);
      outbound.set(id, { resolve, reject, timer });
      write({ jsonrpc: '2.0', id, method, params });
    });
  };

  /** Direction B without polling — see the module note. */
  const fulfillBySampling = async (request: ParkedRequest): Promise<string> => {
    const response = (await sendRequest(
      'sampling/createMessage',
      {
        messages: request.messages.map((message: ChatMessage) => ({
          role: message.role,
          content: { type: 'text', text: message.content },
        })),
        systemPrompt: request.system,
        maxTokens: 8192,
      },
      SAMPLING_TIMEOUT_MS,
    )) as { content?: { type?: string; text?: string } };
    const content = response.content;
    if (content?.type !== 'text' || typeof content.text !== 'string') {
      throw new Error('sampling returned no text content');
    }
    return content.text;
  };

  /* --- resources ------------------------------------------------------------ */

  const contractText = async (): Promise<string> => {
    const result = await runTool('sfx_contract', {}, ctx);
    return result.content[0]?.text ?? '';
  };

  /** `examples/*.soundline` beside the cwd, when running inside the repo. */
  const exampleNames = (): string[] => {
    try {
      return readdirSync(join(ctx.cwd, 'examples'))
        .filter((file) => file.endsWith('.soundline'))
        .map((file) => file.replace(/\.soundline$/, ''));
    } catch {
      return [];
    }
  };

  const listResources = async (): Promise<unknown> => {
    const resources: { uri: string; name: string; description?: string; mimeType: string }[] = [
      {
        uri: 'txt2sfx://contract',
        name: 'soundline contract',
        description: 'The complete grammar, parameter tables, category limits and examples — same bytes as sfx_contract.',
        mimeType: 'text/plain',
      },
    ];
    const seen = new Set<string>();
    try {
      const fetchImpl = ctx.fetch ?? fetch;
      const response = await fetchImpl(`${ctx.bankUrl}/api/recipes?limit=50`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const body = (await response.json()) as { recipes?: { name: string; prompt: string }[] };
        for (const recipe of body.recipes ?? []) {
          if (seen.has(recipe.name)) continue;
          seen.add(recipe.name);
          resources.push({
            uri: `txt2sfx://recipe/${recipe.name}`,
            name: recipe.name,
            description: recipe.prompt,
            mimeType: 'text/plain',
          });
        }
      }
    } catch {
      /* No bank is not an error — the contract is still worth listing. */
    }
    for (const name of exampleNames()) {
      if (seen.has(name)) continue;
      seen.add(name);
      resources.push({ uri: `txt2sfx://recipe/${name}`, name, mimeType: 'text/plain' });
    }
    return { resources };
  };

  const readResource = async (uri: string): Promise<unknown> => {
    if (uri === 'txt2sfx://contract') {
      return { contents: [{ uri, mimeType: 'text/plain', text: await contractText() }] };
    }
    const match = /^txt2sfx:\/\/recipe\/(.+)$/.exec(uri);
    if (match !== null) {
      const name = match[1] ?? '';
      try {
        const fetchImpl = ctx.fetch ?? fetch;
        const response = await fetchImpl(
          `${ctx.bankUrl}/api/recipes?q=${encodeURIComponent(name)}&limit=10`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (response.ok) {
          const body = (await response.json()) as { recipes?: { name: string; soundline: string }[] };
          const recipe = (body.recipes ?? []).find((candidate) => candidate.name === name);
          if (recipe !== undefined) {
            return { contents: [{ uri, mimeType: 'text/plain', text: recipe.soundline }] };
          }
        }
      } catch {
        /* fall through to examples/ */
      }
      try {
        const text = readFileSync(join(ctx.cwd, 'examples', `${name}.soundline`), 'utf8');
        return { contents: [{ uri, mimeType: 'text/plain', text }] };
      } catch {
        /* fall through to the error */
      }
    }
    throw { code: RESOURCE_NOT_FOUND, message: `no resource at ${uri} — list resources for what exists` };
  };

  /* --- request dispatch -------------------------------------------------------- */

  const handleRequest = async (id: string | number | null, method: string, params: unknown): Promise<void> => {
    switch (method) {
      case 'initialize': {
        const init = (params ?? {}) as {
          clientInfo?: { name?: string };
          capabilities?: { sampling?: unknown };
        };
        clientName = init.clientInfo?.name ?? 'unknown client';
        clientSampling = init.capabilities?.sampling !== undefined;
        reply(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'txt2sfx-bridge', version },
        });
        return;
      }

      case 'ping':
        reply(id, {});
        return;

      case 'tools/list':
        reply(id, {
          tools: TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
        return;

      case 'tools/call': {
        const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof call.name !== 'string') {
          replyError(id, INVALID_PARAMS, 'tools/call params must carry a tool name');
          return;
        }
        const args =
          typeof call.arguments === 'object' && call.arguments !== null
            ? (call.arguments as Record<string, unknown>)
            : {};
        /* `runTool` converts everything a tool throws into `isError: true` —
           the model must see "does not parse", not a -32603. */
        reply(id, await runTool(call.name, args, ctx));
        return;
      }

      case 'resources/list':
        reply(id, await listResources());
        return;

      case 'resources/read': {
        const read = (params ?? {}) as { uri?: unknown };
        if (typeof read.uri !== 'string') {
          replyError(id, INVALID_PARAMS, 'resources/read params must carry a uri');
          return;
        }
        try {
          reply(id, await readResource(read.uri));
        } catch (error) {
          const failure = error as { code?: number; message?: string };
          replyError(id, failure.code ?? RESOURCE_NOT_FOUND, failure.message ?? 'resource not found');
        }
        return;
      }

      default:
        replyError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  };

  const handleNotification = (method: string): void => {
    if (method === 'notifications/initialized') {
      initialized = true;
      /* Registration waits for this notification: a client that advertises
         sampling in `initialize` may still not be ready to receive requests
         until it says it is. */
      hub?.setAgent(clientName, clientSampling, clientSampling ? fulfillBySampling : undefined);
      log(`mcp: ${clientName} initialized${clientSampling ? ' (sampling available)' : ''}`);
      return;
    }
    /* Every other notification — cancelled, progress — is legitimately ignorable here. */
  };

  const handleResponse = (message: JsonRpcMessage): void => {
    const id = typeof message.id === 'string' ? message.id : String(message.id);
    const pending = outbound.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    outbound.delete(id);
    if (message.error !== undefined) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      replyError(null, PARSE_ERROR, 'that line was not JSON');
      return;
    }
    if (typeof message !== 'object' || message === null) {
      replyError(null, INVALID_REQUEST, 'a JSON-RPC message must be an object');
      return;
    }

    if (message.method !== undefined && message.id !== undefined) {
      const requestId = message.id;
      void handleRequest(requestId, message.method, message.params).catch((error: unknown) => {
        /* A crash in a *handler* (not a tool) is genuinely protocol-level. */
        replyError(requestId, INVALID_REQUEST, error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (message.method !== undefined) {
      handleNotification(message.method);
      return;
    }
    if (message.result !== undefined || message.error !== undefined) {
      handleResponse(message);
      return;
    }
    /* Neither request, notification, nor response: nothing to say back. */
  };

  /* --- stdin plumbing ------------------------------------------------------------ */

  let pending = '';
  const onData = (chunk: Buffer | string): void => {
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      handleLine(line);
    }
  };

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    for (const [, waiting] of outbound) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('the MCP client went away'));
    }
    outbound.clear();
    if (initialized) hub?.clearAgent();
    input.off('data', onData);
    resolveDone();
  };

  input.on('data', onData);
  input.on('end', shutdown);
  input.on('close', shutdown);
  input.on('error', shutdown);

  return { done, close: shutdown };
}
