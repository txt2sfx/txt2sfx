/**
 * The hand-rolled RFC 6455 server, exercised at three depths:
 *
 * 1. the codec, as pure functions — masking is XOR and XOR lies only in tests
 *    that never run it;
 * 2. a raw socket doing its own handshake and framing — this is where the
 *    fragmentation, ping/pong and refusal behaviour is pinned;
 * 3. Node's own `WebSocket` client — an implementation we did not write
 *    agreeing with ours is the closest thing to an interop suite this side of
 *    autobahn.
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FrameReader,
  WsProtocolError,
  acceptKey,
  encodeClientFrame,
  encodeServerFrame,
  unmask,
} from '../src/index.js';
import type { Frame } from '../src/index.js';
import { decodeServerFrames, rawUpgrade, startTestBridge, type TestBridge } from './helpers/bridge.js';

let bridge: TestBridge | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

describe('the codec', () => {
  it('computes the RFC example accept key', () => {
    /* Straight out of RFC 6455 §1.3 — if this breaks, every browser refuses us. */
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    expect(acceptKey('x')).toBe(
      createHash('sha1').update('x258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'),
    );
  });

  it('masks and unmasks as its own inverse', () => {
    const payload = Buffer.from('{"t":"hello"}');
    const mask = Buffer.from([0xa1, 0xb2, 0xc3, 0xd4]);
    const masked = unmask(Buffer.from(payload), mask);
    expect(masked.equals(payload)).toBe(false);
    expect(unmask(Buffer.from(masked), mask).equals(payload)).toBe(true);
  });

  it('round-trips a masked client frame through the reader', () => {
    const reader = new FrameReader();
    const frames = reader.push(encodeClientFrame(0x1, Buffer.from('hello over the wire')));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.opcode).toBe(0x1);
    expect(frames[0]?.fin).toBe(true);
    expect(frames[0]?.payload.toString()).toBe('hello over the wire');
  });

  it('reassembles a frame split across arbitrary chunk boundaries', () => {
    const reader = new FrameReader();
    const wire = encodeClientFrame(0x1, Buffer.from('x'.repeat(300))); // 126-length path
    const first = reader.push(wire.subarray(0, 5));
    expect(first).toHaveLength(0);
    const rest = reader.push(wire.subarray(5));
    expect(rest).toHaveLength(1);
    expect(rest[0]?.payload.length).toBe(300);
  });

  it('parses two frames arriving glued together', () => {
    const reader = new FrameReader();
    const wire = Buffer.concat([
      encodeClientFrame(0x1, Buffer.from('one')),
      encodeClientFrame(0x1, Buffer.from('two')),
    ]);
    expect(reader.push(wire).map((frame) => frame.payload.toString())).toEqual(['one', 'two']);
  });

  it('refuses an unmasked client frame with close code 1002', () => {
    const reader = new FrameReader();
    let thrown: unknown;
    try {
      reader.push(encodeServerFrame(0x1, Buffer.from('unmasked')));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WsProtocolError);
    expect((thrown as WsProtocolError).code).toBe(1002);
  });

  it('encodes the three length shapes', () => {
    expect(encodeServerFrame(0x1, Buffer.alloc(125))[1]).toBe(125);
    expect(encodeServerFrame(0x1, Buffer.alloc(126))[1]).toBe(126);
    expect(encodeServerFrame(0x1, Buffer.alloc(70_000))[1]).toBe(127);
  });
});

describe('the live server, raw socket', () => {
  it('completes the handshake with the right accept hash', async () => {
    bridge = await startTestBridge();
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    const client = await rawUpgrade(bridge.port, { token: bridge.token, key });
    expect(client.statusLine).toContain('101');
    expect(client.headers['sec-websocket-accept']).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    expect(client.headers['upgrade']).toBe('websocket');
    client.close();
  });

  it('round-trips hello → welcome as text frames', async () => {
    bridge = await startTestBridge();
    const client = await rawUpgrade(bridge.port, { token: bridge.token });
    const hello: Frame = { t: 'hello', role: 'playground', version: 1, app: 'raw-test' };
    client.socket.write(encodeClientFrame(0x1, Buffer.from(JSON.stringify(hello))));
    const frame = await client.waitForFrame((candidate) => candidate.opcode === 0x1);
    const welcome = JSON.parse(frame.payload.toString()) as Frame;
    expect(welcome).toMatchObject({ t: 'welcome', version: 1, bridge: '0.0.0-test' });
    expect(bridge.hub.playgroundCount()).toBe(1);
    client.close();
  });

  it('answers a protocol ping with a pong carrying the same payload', async () => {
    bridge = await startTestBridge();
    const client = await rawUpgrade(bridge.port, { token: bridge.token });
    client.socket.write(encodeClientFrame(0x9, Buffer.from('are-you-there')));
    const pong = await client.waitForFrame((candidate) => candidate.opcode === 0xa);
    expect(pong.payload.toString()).toBe('are-you-there');
    client.close();
  });

  it('assembles an inbound fragmented text message', async () => {
    bridge = await startTestBridge();
    const client = await rawUpgrade(bridge.port, { token: bridge.token });
    const hello = JSON.stringify({ t: 'hello', role: 'playground', version: 1, app: 'frag' });
    const midpoint = Math.floor(hello.length / 2);
    client.socket.write(encodeClientFrame(0x1, Buffer.from(hello.slice(0, midpoint)), undefined, false));
    client.socket.write(encodeClientFrame(0x0, Buffer.from(hello.slice(midpoint)), undefined, true));
    const frame = await client.waitForFrame((candidate) => candidate.opcode === 0x1);
    expect((JSON.parse(frame.payload.toString()) as Frame).t).toBe('welcome');
    client.close();
  });

  it('closes 1003 on a binary frame — the protocol is JSON text', async () => {
    bridge = await startTestBridge();
    const client = await rawUpgrade(bridge.port, { token: bridge.token });
    client.socket.write(encodeClientFrame(0x2, Buffer.from([1, 2, 3])));
    const close = await client.waitForFrame((candidate) => candidate.opcode === 0x8);
    expect(close.payload.readUInt16BE(0)).toBe(1003);
    client.close();
  });

  it('refuses the upgrade without a valid token', async () => {
    bridge = await startTestBridge();
    const noToken = await rawUpgrade(bridge.port, {});
    expect(noToken.statusLine).toContain('401');
    const badToken = await rawUpgrade(bridge.port, { token: 'wrong' });
    expect(badToken.statusLine).toContain('401');
    expect(bridge.hub.playgroundCount()).toBe(0);
  });

  it('refuses the upgrade from a hostile origin even with the right token', async () => {
    bridge = await startTestBridge();
    const client = await rawUpgrade(bridge.port, { token: bridge.token, origin: 'https://evil.example' });
    expect(client.statusLine).toContain('403');
  });

  it('accepts localhost origins on any port, and --allow-origin extras', async () => {
    bridge = await startTestBridge(['https://sfx.example.com']);
    const local = await rawUpgrade(bridge.port, { token: bridge.token, origin: 'http://localhost:5173' });
    expect(local.statusLine).toContain('101');
    local.close();
    const extra = await rawUpgrade(bridge.port, { token: bridge.token, origin: 'https://sfx.example.com' });
    expect(extra.statusLine).toContain('101');
    extra.close();
  });

  it('detaches the playground when the socket dies', async () => {
    bridge = await startTestBridge();
    const client = await rawUpgrade(bridge.port, { token: bridge.token });
    client.socket.write(
      encodeClientFrame(0x1, Buffer.from(JSON.stringify({ t: 'hello', role: 'playground', version: 1, app: 'x' }))),
    );
    await client.waitForFrame((candidate) => candidate.opcode === 0x1);
    expect(bridge.hub.playgroundCount()).toBe(1);
    client.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.hub.playgroundCount()).toBe(0);
  });
});

describe('the live server, Node WebSocket client', () => {
  it('interoperates: handshake, hello/welcome, and a relayed call', async () => {
    bridge = await startTestBridge();
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(bridge.port)}/ws?token=${bridge.token}&role=playground`,
    );
    const frames: Frame[] = [];
    const opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('socket failed')));
    });
    const welcome = new Promise<Frame>((resolve) => {
      socket.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data)) as Frame;
        frames.push(frame);
        if (frame.t === 'welcome') resolve(frame);
        if (frame.t === 'call') {
          /* Play the playground's part: answer the relayed call. */
          socket.send(
            JSON.stringify({ t: 'result', id: frame.id, result: { durationMs: 55, peak: 0.4, clipped: false } }),
          );
        }
      });
    });

    await opened;
    socket.send(JSON.stringify({ t: 'hello', role: 'playground', version: 1, app: 'undici' }));
    expect((await welcome).t).toBe('welcome');

    const result = await bridge.hub.callPlayground('playground.audition', { soundline: 'sound…' });
    expect(result).toEqual({ durationMs: 55, peak: 0.4, clipped: false });
    socket.close();
  });

  it('refuses a wrong token in a way the client sees as failure', async () => {
    bridge = await startTestBridge();
    const socket = new WebSocket(`ws://127.0.0.1:${String(bridge.port)}/ws?token=nope&role=playground`);
    const failed = await new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => resolve(false));
      socket.addEventListener('error', () => resolve(true));
      socket.addEventListener('close', () => resolve(true));
    });
    expect(failed).toBe(true);
  });
});
