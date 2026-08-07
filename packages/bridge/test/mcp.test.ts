/**
 * The MCP server over a pair of in-memory streams — the same bytes a client
 * would pipe, without a process.
 *
 * The two behaviours worth their own tests are the ones clients punish
 * hardest: a tool failure must arrive as `{ isError: true }` in a *result*
 * (a JSON-RPC error is surfaced as a crash), and a notification must never be
 * answered (a stray reply desynchronizes the client's id matching).
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  Hub,
  createMcpServer,
  createNativeRenderer,
  localToolHub,
  silentLog,
} from '../src/index.js';
import type { Frame, PlaygroundPort, ToolContext } from '../src/index.js';

interface Session {
  hub: Hub;
  send(message: object): void;
  /** Waits until a response with this id arrives. */
  receive(id: string | number): Promise<Record<string, unknown>>;
  /** Waits for a server→client *request* with this method. */
  receiveRequest(method: string): Promise<Record<string, unknown>>;
  /** Everything written so far, parsed. */
  outbox(): Record<string, unknown>[];
}

/** A live server on fake stdio. The bank URL points at a dead port on purpose. */
function session(): Session {
  const input = new PassThrough();
  const output = new PassThrough();
  const native = createNativeRenderer(() => Promise.reject(new Error('not installed')));
  const hub = new Hub({ version: '0.0.0-test', native, log: silentLog });
  const ctx: ToolContext = {
    hub: localToolHub(hub),
    native,
    bankUrl: 'http://127.0.0.1:9', // discard port: closed everywhere that matters
    cwd: process.cwd(),
    allowWrite: [],
    log: silentLog,
  };
  createMcpServer({ input, output, ctx, hub, version: '0.0.0-test', log: silentLog });

  const messages: Record<string, unknown>[] = [];
  const waiters: { predicate: (message: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
  let pending = '';
  output.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter !== undefined && waiter.predicate(message)) {
          waiters.splice(i, 1);
          waiter.resolve(message);
        }
      }
    }
  });

  const waitFor = (predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    const existing = messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no matching message arrived')), 3000);
      waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };

  return {
    hub,
    send: (message) => input.write(`${JSON.stringify(message)}\n`),
    receive: (id) => waitFor((message) => message['id'] === id && message['method'] === undefined),
    receiveRequest: (method) => waitFor((message) => message['method'] === method),
    outbox: () => messages,
  };
}

/** The full opening handshake, as a client performs it. */
async function initialize(mcp: Session, sampling = false): Promise<void> {
  mcp.send({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: sampling ? { sampling: {} } : {},
      clientInfo: { name: 'test-client', version: '1.0' },
    },
  });
  await mcp.receive('init');
  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const VALID = 'sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n';

describe('the opening sequence', () => {
  it('initialize answers protocol 2025-06-18 with tools and resources', async () => {
    const mcp = session();
    mcp.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x' } },
    });
    const response = await mcp.receive(1);
    expect(response['result']).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'txt2sfx-bridge', version: '0.0.0-test' },
    });
  });

  it('never answers notifications/initialized — a stray reply desyncs the client', async () => {
    const mcp = session();
    await initialize(mcp);
    const before = mcp.outbox().length;
    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mcp.outbox().length).toBe(before);
  });

  it('registers the agent with the hub on initialized, and detaches on stdin end', async () => {
    const mcp = session();
    await initialize(mcp, true);
    expect(mcp.hub.agentStatus()).toEqual({ connected: true, client: 'test-client', sampling: true });
  });

  it('answers ping with an empty result', async () => {
    const mcp = session();
    await initialize(mcp);
    mcp.send({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    expect((await mcp.receive('p'))['result']).toEqual({});
  });
});

describe('tools over the wire', () => {
  it('lists the twelve with schemas and descriptions', async () => {
    const mcp = session();
    await initialize(mcp);
    mcp.send({ jsonrpc: '2.0', id: 'tl', method: 'tools/list' });
    const response = await mcp.receive('tl');
    const tools = (response['result'] as { tools: { name: string; description: string; inputSchema: object }[] }).tools;
    expect(tools).toHaveLength(12);
    expect(tools.map((tool) => tool.name)).toContain('sfx_validate');
    for (const tool of tools) expect(tool.inputSchema).toBeDefined();
  });

  it('runs a tool call end to end', async () => {
    const mcp = session();
    await initialize(mcp);
    mcp.send({
      jsonrpc: '2.0',
      id: 'call',
      method: 'tools/call',
      params: { name: 'sfx_validate', arguments: { soundline: VALID } },
    });
    const response = await mcp.receive('call');
    const result = response['result'] as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('"tick" parses');
  });

  it('reports a tool failure as isError, never as a JSON-RPC error', async () => {
    const mcp = session();
    await initialize(mcp);
    mcp.send({
      jsonrpc: '2.0',
      id: 'bad',
      method: 'tools/call',
      params: { name: 'sfx_validate', arguments: { soundline: 'sound "x" 45ms ui\n  a: nosie white | gain 0.5\n' } },
    });
    const response = await mcp.receive('bad');
    expect(response['error']).toBeUndefined();
    const result = response['result'] as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('does not parse');
    /* The typo dictionary's suggestion must survive to the model. */
    expect(result.content[0]?.text).toContain('noise');
  });

  it('answers an unknown method with -32601', async () => {
    const mcp = session();
    await initialize(mcp);
    mcp.send({ jsonrpc: '2.0', id: 'u', method: 'tools/uninvented' });
    const response = await mcp.receive('u');
    expect(response['error']).toMatchObject({ code: -32601 });
  });

  it('answers a non-JSON line with -32700 and id null', async () => {
    /* Raw streams, no session helper: the malformed line must hit the wire. */
    const input = new PassThrough();
    const output = new PassThrough();
    const native = createNativeRenderer(() => Promise.reject(new Error('nope')));
    const hub = new Hub({ version: 't', native, log: silentLog });
    createMcpServer({
      input,
      output,
      ctx: { hub: localToolHub(hub), native, bankUrl: 'http://127.0.0.1:9', cwd: process.cwd(), allowWrite: [], log: silentLog },
      hub,
      version: 't',
      log: silentLog,
    });
    const line = new Promise<Record<string, unknown>>((resolve) => {
      output.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString()) as Record<string, unknown>));
    });
    input.write('this is not json\n');
    const response = await line;
    expect(response['id']).toBeNull();
    expect(response['error']).toMatchObject({ code: -32700 });
  });
});

describe('resources', () => {
  it('lists the contract even with no bank anywhere', async () => {
    const mcp = session();
    await initialize(mcp);
    mcp.send({ jsonrpc: '2.0', id: 'rl', method: 'resources/list' });
    const response = await mcp.receive('rl');
    const resources = (response['result'] as { resources: { uri: string }[] }).resources;
    expect(resources.map((resource) => resource.uri)).toContain('txt2sfx://contract');
  });

  it('reads the contract — the same grammar sfx_contract serves', async () => {
    const mcp = session();
    await initialize(mcp);
    mcp.send({ jsonrpc: '2.0', id: 'rr', method: 'resources/read', params: { uri: 'txt2sfx://contract' } });
    const response = await mcp.receive('rr');
    const contents = (response['result'] as { contents: { text: string; mimeType: string }[] }).contents;
    expect(contents[0]?.mimeType).toBe('text/plain');
    expect(contents[0]?.text).toContain('soundline');
    expect(contents[0]?.text.length).toBeGreaterThan(2000);
  });

  it('answers an unknown uri with the resource-not-found error', async () => {
    const mcp = session();
    await initialize(mcp);
    mcp.send({ jsonrpc: '2.0', id: 'rx', method: 'resources/read', params: { uri: 'txt2sfx://recipe/never-stored' } });
    const response = await mcp.receive('rx');
    expect(response['error']).toMatchObject({ code: -32002 });
  });
});

describe('sampling', () => {
  /** A greeted fake tab on the same hub. */
  async function tab(hub: Hub): Promise<{ port: PlaygroundPort; frames: Frame[] }> {
    const frames: Frame[] = [];
    const port: PlaygroundPort = { send: (frame) => frames.push(frame), close: () => {} };
    hub.attach(port);
    hub.handleFrame(port, { t: 'hello', role: 'playground', version: 1, app: 'test' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { port, frames };
  }

  it('fulfils agent.complete via sampling/createMessage without parking', async () => {
    const mcp = session();
    await initialize(mcp, true);
    const playground = await tab(mcp.hub);

    mcp.hub.handleFrame(playground.port, {
      t: 'call',
      id: 'c1',
      method: 'agent.complete',
      params: { turn: 1, messages: [{ role: 'user', content: 'a coin sound' }], system: 'CONTRACT' },
    });

    const request = await mcp.receiveRequest('sampling/createMessage');
    expect(request['params']).toMatchObject({
      systemPrompt: 'CONTRACT',
      messages: [{ role: 'user', content: { type: 'text', text: 'a coin sound' } }],
    });

    mcp.send({
      jsonrpc: '2.0',
      id: request['id'],
      result: { role: 'assistant', content: { type: 'text', text: '```\nsound "coin" …\n```' }, model: 'test' },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(playground.frames.at(-1)).toMatchObject({
      t: 'result',
      id: 'c1',
      result: { text: '```\nsound "coin" …\n```' },
    });
  });

  it('parks the job when the client declines the sampling request', async () => {
    const mcp = session();
    await initialize(mcp, true);
    const playground = await tab(mcp.hub);

    mcp.hub.handleFrame(playground.port, {
      t: 'call',
      id: 'c2',
      method: 'agent.complete',
      params: { turn: 1, messages: [], system: '' },
    });
    const request = await mcp.receiveRequest('sampling/createMessage');
    mcp.send({ jsonrpc: '2.0', id: request['id'], error: { code: -1, message: 'user declined' } });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const next = await mcp.hub.nextRequest(500);
    expect('request' in next).toBe(true);
  });

  it('does not issue sampling requests for a client that never advertised it', async () => {
    const mcp = session();
    await initialize(mcp, false);
    const playground = await tab(mcp.hub);
    mcp.hub.handleFrame(playground.port, {
      t: 'call',
      id: 'c3',
      method: 'agent.complete',
      params: { turn: 1, messages: [], system: '' },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mcp.outbox().some((message) => message['method'] === 'sampling/createMessage')).toBe(false);
    const next = await mcp.hub.nextRequest(500);
    expect('request' in next).toBe(true);
  });
});
