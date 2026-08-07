/**
 * The switchboard, driven with a fake tab — no socket, no port.
 *
 * What is under test is the two disciplines inherited from the in-page
 * `Bridge`: monotonic ids with stale answers refused, and one outstanding
 * direction-B job. Plus the failure prose, because "no playground is
 * connected — …" is part of the contract, not decoration.
 */

import { describe, expect, it } from 'vitest';
import { Hub, silentLog, createNativeRenderer } from '../src/index.js';
import type { Frame, PlaygroundPort } from '../src/index.js';

/** A tab that never renders: enough for every switchboard concern. */
function fakeTab(): { port: PlaygroundPort; frames: Frame[] } {
  const frames: Frame[] = [];
  return { frames, port: { send: (frame) => frames.push(frame), close: () => {} } };
}

/** Native renderer whose import always fails — the hub only asks availability. */
const noNative = createNativeRenderer(() => Promise.reject(new Error('not installed')));

function makeHub(): Hub {
  return new Hub({ version: '0.0.0-test', native: noNative, log: silentLog });
}

/** Attach and greet a tab, swallowing the welcome. */
async function greet(hub: Hub): Promise<{ port: PlaygroundPort; frames: Frame[] }> {
  const tab = fakeTab();
  hub.attach(tab.port);
  hub.handleFrame(tab.port, { t: 'hello', role: 'playground', version: 1, app: 'test' });
  /* welcome is sent after an async renderer resolution */
  await new Promise((resolve) => setTimeout(resolve, 0));
  return tab;
}

describe('hello / welcome', () => {
  it('answers hello with a welcome carrying version, renderer and agent status', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    const welcome = tab.frames.find((frame) => frame.t === 'welcome');
    expect(welcome).toMatchObject({
      t: 'welcome',
      version: 1,
      bridge: '0.0.0-test',
      renderer: 'playground',
      agent: { connected: false, client: null, sampling: false },
    });
    expect(hub.playgroundCount()).toBe(1);
  });

  it('counts only tabs that said hello', () => {
    const hub = makeHub();
    const tab = fakeTab();
    hub.attach(tab.port);
    expect(hub.playgroundCount()).toBe(0);
  });

  it('answers an app-level ping with a pong', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.handleFrame(tab.port, { t: 'ping' });
    expect(tab.frames.at(-1)).toEqual({ t: 'pong' });
  });
});

describe('direction A: relayed calls', () => {
  it('relays a call and resolves on the result frame', async () => {
    const hub = makeHub();
    const tab = await greet(hub);

    const pending = hub.callPlayground('playground.audition', { soundline: 'x' });
    const call = tab.frames.find((frame) => frame.t === 'call');
    expect(call).toMatchObject({ t: 'call', method: 'playground.audition', params: { soundline: 'x' } });

    hub.handleFrame(tab.port, {
      t: 'result',
      id: (call as { id: string }).id,
      result: { durationMs: 42, peak: 0.5, clipped: false },
    });
    await expect(pending).resolves.toEqual({ durationMs: 42, peak: 0.5, clipped: false });
  });

  it('rejects on an error frame, with the playground\'s own message', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    const pending = hub.callPlayground('playground.open', {});
    const call = tab.frames.find((frame) => frame.t === 'call') as { id: string };
    hub.handleFrame(tab.port, { t: 'error', id: call.id, error: { message: 'no such recipe' } });
    await expect(pending).rejects.toThrow('no such recipe');
  });

  it('fails with the one-sentence fix when no tab is connected', async () => {
    const hub = makeHub();
    await expect(hub.callPlayground('playground.audition', {})).rejects.toThrow(
      'no playground is connected — open http://localhost:5173 and check the bridge badge',
    );
  });

  it('times out instead of hanging on a tab that never answers', async () => {
    const hub = makeHub();
    await greet(hub);
    await expect(hub.callPlayground('playground.render', {}, 30)).rejects.toThrow('did not answer');
  });

  it('ignores a stale result rather than resolving the wrong call', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    /* No pending relay: a made-up id must land nowhere. */
    hub.handleFrame(tab.port, { t: 'result', id: 'b999', result: {} });
    expect(tab.frames.filter((frame) => frame.t === 'error')).toEqual([]);
  });

  it('rejects pending calls when their tab disconnects', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    const pending = hub.callPlayground('playground.render', {});
    hub.detach(tab.port);
    await expect(pending).rejects.toThrow('disconnected');
  });
});

describe('calls from the playground', () => {
  it('answers an unknown method with code unsupported, never a dropped frame', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.handleFrame(tab.port, { t: 'call', id: 'p1', method: 'agent.reboot', params: {} });
    expect(tab.frames.at(-1)).toMatchObject({
      t: 'error',
      id: 'p1',
      error: { code: 'unsupported' },
    });
  });

  it('answers agent.status', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.handleFrame(tab.port, { t: 'call', id: 'p2', method: 'agent.status', params: {} });
    expect(tab.frames.at(-1)).toEqual({
      t: 'result',
      id: 'p2',
      result: { connected: false, client: null, sampling: false },
    });
  });
});

describe('direction B: park, poll, answer', () => {
  const completeFrame = (id: string): Frame => ({
    t: 'call',
    id,
    method: 'agent.complete',
    params: { turn: 1, messages: [{ role: 'user', content: 'write a coin sound' }], system: 'THE CONTRACT' },
  });

  it('parks a job, hands it to a poller, and answers the right frame', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.handleFrame(tab.port, completeFrame('c1'));

    const next = await hub.nextRequest(1000);
    expect('request' in next && next.request).toMatchObject({
      turn: 1,
      system: 'THE CONTRACT',
      systemBytes: 'THE CONTRACT'.length,
      messages: [{ role: 'user', content: 'write a coin sound' }],
    });
    const id = 'request' in next ? next.request.id : '';

    expect(hub.answer(id, '```\nsound "x" 40ms ui\n```')).toBe(true);
    expect(tab.frames.at(-1)).toMatchObject({
      t: 'result',
      id: 'c1',
      result: { text: '```\nsound "x" 40ms ui\n```' },
    });
  });

  it('broadcasts job.parked and job.answered so the tab can show progress', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.handleFrame(tab.port, completeFrame('c1'));
    const parked = tab.frames.find((frame) => frame.t === 'event' && frame.event === 'job.parked');
    expect(parked).toBeDefined();

    const next = await hub.nextRequest(1000);
    hub.answer('request' in next ? next.request.id : '', 'text');
    const answered = tab.frames.find((frame) => frame.t === 'event' && frame.event === 'job.answered');
    expect(answered).toBeDefined();
  });

  it('refuses a second job while one is parked — one outstanding, like Bridge.enqueue', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.handleFrame(tab.port, completeFrame('c1'));
    hub.handleFrame(tab.port, completeFrame('c2'));
    expect(tab.frames.at(-1)).toMatchObject({
      t: 'error',
      id: 'c2',
      error: { message: 'a request is already waiting for a reply', code: 'busy' },
    });
  });

  it('refuses a stale answer instead of answering the wrong turn', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.handleFrame(tab.port, completeFrame('c1'));
    const next = await hub.nextRequest(1000);
    const id = 'request' in next ? next.request.id : '';
    expect(hub.answer(id, 'first')).toBe(true);
    expect(hub.answer(id, 'second')).toBe(false);
    expect(hub.answer('job-999', 'never parked')).toBe(false);
  });

  it('hands the same parked job to a second poll — reading is idempotent', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.handleFrame(tab.port, completeFrame('c1'));
    const first = await hub.nextRequest(1000);
    const second = await hub.nextRequest(1000);
    expect(first).toEqual(second);
  });

  it('expires a long-poll with { none: true } instead of hanging', async () => {
    const hub = makeHub();
    const started = Date.now();
    await expect(hub.nextRequest(50)).resolves.toEqual({ none: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('wakes a waiting poll the moment a job parks', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    const waiting = hub.nextRequest(5000);
    hub.handleFrame(tab.port, completeFrame('c1'));
    const result = await waiting;
    expect('request' in result).toBe(true);
  });

  it('fails the job back to the playground as an error frame', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.handleFrame(tab.port, completeFrame('c1'));
    const next = await hub.nextRequest(1000);
    expect(hub.fail('request' in next ? next.request.id : '', 'cannot do voices')).toBe(true);
    expect(tab.frames.at(-1)).toMatchObject({
      t: 'error',
      id: 'c1',
      error: { message: 'cannot do voices' },
    });
  });

  it('drops the job when the asking tab disconnects', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.handleFrame(tab.port, completeFrame('c1'));
    const next = await hub.nextRequest(1000);
    hub.detach(tab.port);
    expect(hub.answer('request' in next ? next.request.id : '', 'too late')).toBe(false);
  });
});

describe('agent status', () => {
  it('reflects an attached MCP session, and its departure', () => {
    const hub = makeHub();
    hub.setAgent('claude-code', true);
    expect(hub.agentStatus()).toEqual({ connected: true, client: 'claude-code', sampling: true });
    hub.clearAgent();
    expect(hub.agentStatus()).toEqual({ connected: false, client: null, sampling: false });
  });

  it('counts an open long-poll as a connected agent', async () => {
    const hub = makeHub();
    const poll = hub.nextRequest(100);
    expect(hub.agentStatus().connected).toBe(true);
    await poll;
    expect(hub.agentStatus().connected).toBe(false);
  });
});

describe('sampling fulfilment', () => {
  it('answers the job through the fulfiller with no parking', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.setAgent('sampler', true, (request) => Promise.resolve(`answering turn ${String(request.turn)}`));
    hub.handleFrame(tab.port, {
      t: 'call',
      id: 'c1',
      method: 'agent.complete',
      params: { turn: 3, messages: [], system: '' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tab.frames.at(-1)).toMatchObject({ t: 'result', id: 'c1', result: { text: 'answering turn 3' } });
  });

  it('falls back to parking when the fulfiller rejects', async () => {
    const hub = makeHub();
    const tab = await greet(hub);
    hub.setAgent('sampler', true, () => Promise.reject(new Error('the user declined')));
    hub.handleFrame(tab.port, {
      t: 'call',
      id: 'c1',
      method: 'agent.complete',
      params: { turn: 1, messages: [], system: '' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = await hub.nextRequest(1000);
    expect('request' in next).toBe(true);
  });
});
