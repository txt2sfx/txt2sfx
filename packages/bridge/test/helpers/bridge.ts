/**
 * A real bridge on an ephemeral port, for the tests that need actual sockets.
 *
 * Everything else in the suite drives the hub directly; these helpers exist
 * for the handshake, the frame codec on a live wire, and the HTTP contract —
 * the parts where a fake would test the fake.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  Hub,
  createBridgeServer,
  createNativeRenderer,
  localToolHub,
  silentLog,
} from '../../src/index.js';
import type { ToolContext } from '../../src/index.js';

export interface TestBridge {
  readonly hub: Hub;
  readonly server: Server;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

/** Hub + HTTP + WS on 127.0.0.1:0. The native renderer always fails to import. */
export async function startTestBridge(allowOrigins: readonly string[] = []): Promise<TestBridge> {
  const token = randomBytes(8).toString('hex');
  const hub = new Hub({
    version: '0.0.0-test',
    native: createNativeRenderer(() => Promise.reject(new Error('not installed'))),
    log: silentLog,
  });
  /* The real dispatch, not a fake: `/tools/<name>` is a door onto `runTool`,
     and a test that stubbed it would prove only that the route exists. The
     bank points at a closed port so the tools that reach for it fail the way
     they do on a machine with no bank, immediately. */
  const ctx: ToolContext = {
    hub: localToolHub(hub),
    native: createNativeRenderer(() => Promise.reject(new Error('not installed'))),
    bankUrl: 'http://127.0.0.1:1',
    cwd: process.cwd(),
    allowWrite: [],
    log: silentLog,
  };
  const server = createBridgeServer({
    hub,
    token,
    version: '0.0.0-test',
    toolNames: ['sfx_contract'],
    toolContext: ctx,
    allowOrigins,
    log: silentLog,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    hub,
    server,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One decoded server→client frame. Server frames are never masked. */
export interface ServerFrame {
  readonly opcode: number;
  readonly payload: Buffer;
}

/** Decode as many unmasked frames as `buffer` holds; return the remainder. */
export function decodeServerFrames(buffer: Buffer): { frames: ServerFrame[]; rest: Buffer } {
  const frames: ServerFrame[] = [];
  let data = buffer;
  for (;;) {
    if (data.length < 2) return { frames, rest: data };
    const opcode = (data[0] ?? 0) & 0x0f;
    let length = (data[1] ?? 0) & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (data.length < 4) return { frames, rest: data };
      length = data.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (data.length < 10) return { frames, rest: data };
      length = Number(data.readBigUInt64BE(2));
      offset = 10;
    }
    if (data.length < offset + length) return { frames, rest: data };
    frames.push({ opcode, payload: Buffer.from(data.subarray(offset, offset + length)) });
    data = data.subarray(offset + length);
  }
}

/** A raw client socket that completed (or was refused) the upgrade. */
export interface RawClient {
  readonly socket: Socket;
  /** The HTTP response head, e.g. `HTTP/1.1 101 Switching Protocols`. */
  readonly statusLine: string;
  readonly headers: Record<string, string>;
  /** Collects everything after the handshake; call `frames()` to decode. */
  frames(): ServerFrame[];
  waitForFrame(predicate: (frame: ServerFrame) => boolean, timeoutMs?: number): Promise<ServerFrame>;
  close(): void;
}

/** Hand-rolled upgrade, because the test *is* the client implementation. */
export function rawUpgrade(
  port: number,
  options: { token?: string; origin?: string; key?: string } = {},
): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const key = options.key ?? randomBytes(16).toString('base64');
    let buffered = Buffer.alloc(0);
    let head: { statusLine: string; headers: Record<string, string> } | undefined;
    const listeners: { predicate: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void }[] = [];
    const collected: ServerFrame[] = [];

    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (head === undefined) {
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) return;
        const lines = buffered.subarray(0, end).toString('utf8').split('\r\n');
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':');
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        head = { statusLine: lines[0] ?? '', headers };
        buffered = Buffer.from(buffered.subarray(end + 4));
        resolve({
          socket,
          statusLine: head.statusLine,
          headers: head.headers,
          frames: () => collected,
          waitForFrame: (predicate, timeoutMs = 2000) =>
            new Promise((resolveFrame, rejectFrame) => {
              const existing = collected.find(predicate);
              if (existing !== undefined) {
                resolveFrame(existing);
                return;
              }
              const timer = setTimeout(() => rejectFrame(new Error('no frame arrived')), timeoutMs);
              listeners.push({
                predicate,
                resolve: (frame) => {
                  clearTimeout(timer);
                  resolveFrame(frame);
                },
              });
            }),
          close: () => socket.destroy(),
        });
        if (buffered.length === 0) return;
      }
      const { frames, rest } = decodeServerFrames(buffered);
      buffered = Buffer.from(rest);
      for (const frame of frames) {
        collected.push(frame);
        for (let i = listeners.length - 1; i >= 0; i--) {
          const listener = listeners[i];
          if (listener !== undefined && listener.predicate(frame)) {
            listeners.splice(i, 1);
            listener.resolve(frame);
          }
        }
      }
    });

    const origin = options.origin === undefined ? '' : `Origin: ${options.origin}\r\n`;
    const token = options.token === undefined ? '' : `token=${options.token}&`;
    socket.write(
      `GET /ws?${token}role=playground HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${String(port)}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        origin +
        '\r\n',
    );
  });
}
