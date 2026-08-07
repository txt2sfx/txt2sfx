/**
 * The loopback HTTP contract: what needs a token, what needs an origin, and
 * what a caller is told when it brings neither.
 *
 * These are the routes a *different* program will be written against — the
 * playground badge, the remote `--stdio` client — so the tests pin payload
 * shapes, not just status codes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { remoteToolHub } from '../src/index.js';
import type { Frame, HealthPayload, PlaygroundPort } from '../src/index.js';
import { startTestBridge, type TestBridge } from './helpers/bridge.js';

let bridge: TestBridge | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

const url = (path: string): string => `http://127.0.0.1:${String(bridge?.port ?? 0)}${path}`;

/** A greeted fake tab, wired straight into the hub. */
async function fakeTab(): Promise<{ port: PlaygroundPort; frames: Frame[] }> {
  const frames: Frame[] = [];
  const port: PlaygroundPort = { send: (frame) => frames.push(frame), close: () => {} };
  bridge?.hub.attach(port);
  bridge?.hub.handleFrame(port, { t: 'hello', role: 'playground', version: 1, app: 'test' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { port, frames };
}

describe('GET /health', () => {
  it('answers without a token, with CORS *, and never leaks the token', async () => {
    bridge = await startTestBridge();
    const response = await fetch(url('/health'));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const text = await response.text();
    expect(text).not.toContain(bridge.token);
    const body = JSON.parse(text) as HealthPayload;
    expect(body).toMatchObject({
      ok: true,
      version: '0.0.0-test',
      protocol: 1,
      renderer: 'none',
      playgrounds: 0,
      agent: { connected: false, client: null, sampling: false },
    });
    expect(body.tools).toContain('sfx_contract');
  });

  it('reports the playground tier the moment a tab is connected', async () => {
    bridge = await startTestBridge();
    await fakeTab();
    const body = (await (await fetch(url('/health'))).json()) as HealthPayload;
    expect(body.renderer).toBe('playground');
    expect(body.playgrounds).toBe(1);
  });
});

describe('GET /pair', () => {
  it('serves the token to a localhost origin', async () => {
    bridge = await startTestBridge();
    const response = await fetch(url('/pair'), { headers: { origin: 'http://localhost:5173' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: bridge.token, protocol: 1 });
  });

  it('refuses a foreign origin — loopback is not a boundary in a browser', async () => {
    bridge = await startTestBridge();
    const response = await fetch(url('/pair'), { headers: { origin: 'https://evil.example' } });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('--allow-origin');
  });

  it('honours --allow-origin verbatim', async () => {
    bridge = await startTestBridge(['https://sfx.example.com']);
    const allowed = await fetch(url('/pair'), { headers: { origin: 'https://sfx.example.com' } });
    expect(allowed.status).toBe(200);
    /* Prefix tricks stay refused: the extra is an exact string, not a pattern. */
    const trick = await fetch(url('/pair'), { headers: { origin: 'https://sfx.example.com.evil.example' } });
    expect(trick.status).toBe(403);
  });

  it('serves a client with no Origin header — curl can read the file anyway', async () => {
    bridge = await startTestBridge();
    const response = await fetch(url('/pair'));
    expect(response.status).toBe(200);
  });
});

describe('the /tools routes', () => {
  /* The door for an agent that cannot restart itself into an MCP config:
     same dispatch, same words back, one `curl` deep. */
  const VALID = 'sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n';

  const call = (name: string, args: unknown): Promise<Response> =>
    fetch(url(`/tools/${name}`), {
      method: 'POST',
      headers: { 'x-txt2sfx-token': bridge?.token ?? '', 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });

  it('refuses a missing or wrong token, like /agent', async () => {
    bridge = await startTestBridge();
    for (const headers of [{}, { 'x-txt2sfx-token': 'wrong' }]) {
      const response = await fetch(url('/tools'), { headers });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { message: string }).message).toContain('bridge.json');
    }
  });

  it('lists every tool with the schema an MCP client would have been given', async () => {
    bridge = await startTestBridge();
    const response = await fetch(url('/tools'), { headers: { 'x-txt2sfx-token': bridge.token } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
    };
    expect(body.tools).toHaveLength(12);
    const validate = body.tools.find((tool) => tool.name === 'sfx_validate');
    expect(validate?.description).toContain('soundline');
    expect(validate?.inputSchema).toMatchObject({ required: ['soundline'] });
  });

  it('runs a tool and answers ok:true with the text the model should read', async () => {
    bridge = await startTestBridge();
    const response = await call('sfx_validate', { soundline: VALID });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; text: string };
    expect(body.ok).toBe(true);
    expect(body.text).toContain('"tick" parses');
  });

  it('answers a tool failure 200 with ok:false — the text is the repair, not plumbing', async () => {
    bridge = await startTestBridge();
    const response = await call('sfx_validate', { soundline: 'sound "x" 45ms ui\n  a: nosie white\n' });
    /* 200 on purpose: a caller taught that non-2xx means "retry or give up"
       throws away the one paragraph that says how to fix the recipe. */
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; text: string };
    expect(body.ok).toBe(false);
    expect(body.text).toContain('does not parse');
  });

  it('answers an unknown tool with the list it should have read', async () => {
    bridge = await startTestBridge();
    const response = await call('sfx_make_it_good', {});
    expect(response.status).toBe(404);
    const body = (await response.json()) as { message: string; tools: string[] };
    expect(body.message).toContain('GET /tools');
    expect(body.tools).toContain('sfx_contract');
  });

  it('names the shape of the body when the body is not JSON', async () => {
    bridge = await startTestBridge();
    const response = await fetch(url('/tools/sfx_validate'), {
      method: 'POST',
      headers: { 'x-txt2sfx-token': bridge.token, 'content-type': 'application/json' },
      body: 'soundline=sound "tick"',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain('arguments as a JSON object');
  });

  it('relays through the hub, so a tab renders for the HTTP door too', async () => {
    bridge = await startTestBridge();
    const tab = await fakeTab();
    const pending = call('sfx_render', { soundline: VALID });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const relayed = tab.frames.find((frame) => frame.t === 'call') as { id: string; method: string };
    expect(relayed.method).toBe('playground.render');
    bridge.hub.handleFrame(tab.port, {
      t: 'result',
      id: relayed.id,
      result: {
        peak: 0.7,
        clipped: false,
        durationMs: 45,
        bytes: 400,
        withinBudget: true,
        profile: {
          durationMs: 45,
          attackMs: 1,
          rmsEnvelope: [1, 0.5],
          centroidHz: [1800],
          flatness: 0.01,
          noiseRatio: 0.02,
          peakHz: 1800,
          loudnessLufsApprox: -16,
        },
      },
    });
    const body = (await (await pending).json()) as { ok: boolean; text: string };
    expect(body.ok).toBe(true);
    expect(body.text).toContain('in the playground tab');
  });

  it('does not answer a browser: no CORS header, so a page cannot read a result', async () => {
    bridge = await startTestBridge();
    const response = await call('sfx_validate', { soundline: VALID });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('the /agent routes', () => {
  it('refuse a missing or wrong token with a sentence naming the file', async () => {
    bridge = await startTestBridge();
    for (const headers of [{}, { 'x-txt2sfx-token': 'wrong' }]) {
      const response = await fetch(url('/agent/next?timeout=1'), { headers });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { message: string }).message).toContain('bridge.json');
    }
  });

  it('answers /agent/call 503 with the fix when no playground is connected', async () => {
    bridge = await startTestBridge();
    const response = await fetch(url('/agent/call'), {
      method: 'POST',
      headers: { 'x-txt2sfx-token': bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'playground.audition', params: {} }),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('no playground is connected');
  });

  it('relays /agent/call to a connected tab and returns what it returned', async () => {
    bridge = await startTestBridge();
    const tab = await fakeTab();
    const pending = fetch(url('/agent/call'), {
      method: 'POST',
      headers: { 'x-txt2sfx-token': bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'playground.render', params: { soundline: 's' } }),
    });
    /* Answer the relayed call once it lands on the tab. */
    await new Promise((resolve) => setTimeout(resolve, 20));
    const call = tab.frames.find((frame) => frame.t === 'call') as { id: string };
    bridge.hub.handleFrame(tab.port, { t: 'result', id: call.id, result: { peak: 0.7 } });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ peak: 0.7 });
  });

  it('expires /agent/next on its own timeout with { none: true }', async () => {
    bridge = await startTestBridge();
    const started = Date.now();
    const response = await fetch(url('/agent/next?timeout=100'), {
      headers: { 'x-txt2sfx-token': bridge.token },
    });
    expect(await response.json()).toEqual({ none: true });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('walks a job through park → next → answer over the wire', async () => {
    bridge = await startTestBridge();
    const tab = await fakeTab();
    bridge.hub.handleFrame(tab.port, {
      t: 'call',
      id: 'c1',
      method: 'agent.complete',
      params: { turn: 1, messages: [{ role: 'user', content: 'a coin' }], system: 'CONTRACT' },
    });

    const next = (await (
      await fetch(url('/agent/next?timeout=1000'), { headers: { 'x-txt2sfx-token': bridge.token } })
    ).json()) as { request: { id: string; system: string; systemBytes: number } };
    expect(next.request.system).toBe('CONTRACT');
    expect(next.request.systemBytes).toBe('CONTRACT'.length);

    const answered = await fetch(url('/agent/answer'), {
      method: 'POST',
      headers: { 'x-txt2sfx-token': bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ id: next.request.id, text: 'the recipe' }),
    });
    expect(await answered.json()).toEqual({ ok: true });
    expect(tab.frames.at(-1)).toMatchObject({ t: 'result', id: 'c1', result: { text: 'the recipe' } });

    /* Answering twice is a 409, mirroring the hub's staleness rule. */
    const again = await fetch(url('/agent/answer'), {
      method: 'POST',
      headers: { 'x-txt2sfx-token': bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ id: next.request.id, text: 'again' }),
    });
    expect(again.status).toBe(409);
  });

  it('fails a job through /agent/fail as an error frame to the tab', async () => {
    bridge = await startTestBridge();
    const tab = await fakeTab();
    bridge.hub.handleFrame(tab.port, {
      t: 'call',
      id: 'c9',
      method: 'agent.complete',
      params: { turn: 1, messages: [], system: '' },
    });
    const next = (await (
      await fetch(url('/agent/next?timeout=1000'), { headers: { 'x-txt2sfx-token': bridge.token } })
    ).json()) as { request: { id: string } };
    await fetch(url('/agent/fail'), {
      method: 'POST',
      headers: { 'x-txt2sfx-token': bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ id: next.request.id, message: 'no voices' }),
    });
    expect(tab.frames.at(-1)).toMatchObject({ t: 'error', id: 'c9', error: { message: 'no voices' } });
  });
});

describe('remoteToolHub', () => {
  it('speaks the same wire the server serves', async () => {
    bridge = await startTestBridge();
    const tab = await fakeTab();
    const hub = remoteToolHub(url(''), bridge.token);

    expect(await hub.playgroundConnected()).toBe(true);
    expect((await hub.agentStatus()).connected).toBe(false);

    bridge.hub.handleFrame(tab.port, {
      t: 'call',
      id: 'c1',
      method: 'agent.complete',
      params: { turn: 2, messages: [], system: 'S' },
    });
    const next = await hub.nextRequest(1000);
    expect('request' in next && next.request.turn).toBe(2);
    expect(await hub.answer('request' in next ? next.request.id : '', 'answered remotely')).toBe(true);
    expect(tab.frames.at(-1)).toMatchObject({ t: 'result', result: { text: 'answered remotely' } });
  });

  it('surfaces the daemon\'s one-sentence relay failures as thrown errors', async () => {
    bridge = await startTestBridge();
    const hub = remoteToolHub(url(''), bridge.token);
    await expect(hub.callPlayground('playground.audition', {})).rejects.toThrow('no playground is connected');
  });
});

describe('the edges', () => {
  it('404s an unknown route and points at /health', async () => {
    bridge = await startTestBridge();
    const response = await fetch(url('/nope'));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { message: string }).message).toContain('/health');
  });
});
