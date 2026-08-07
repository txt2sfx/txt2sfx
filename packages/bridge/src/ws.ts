/**
 * A minimal RFC 6455 server on the http `upgrade` event, hand-rolled.
 *
 * Hand-rolled because the zero-runtime-dependency rule is a load-bearing
 * project value, not a badge decoration, and the subset a loopback bridge
 * needs is genuinely small: text frames, client masking, close, ping/pong and
 * inbound fragmentation. What is deliberately *not* here: permessage-deflate
 * (the frames are sub-kilobyte JSON), binary messages (the protocol is one
 * JSON object per text frame — a binary frame is answered with close 1003),
 * and outbound fragmentation (nothing we send approaches a size that needs
 * it).
 *
 * The parser is defensive where the RFC says MUST: an unmasked client frame,
 * a reserved bit, or a fragmented control frame each close the connection
 * with 1002 rather than being tolerated — lenience here does not help a
 * well-behaved browser and hides a broken client until it corrupts a message.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

/** RFC 6455 §1.3 — the fixed GUID of the accept-hash handshake. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Frames larger than this close the socket with 1009 (message too big).
 * The protocol's largest message is a recipe plus a profile — kilobytes —
 * so 16 MiB is not a limit anyone hits by accident short of a bug or abuse. */
const MAX_PAYLOAD = 16 * 1024 * 1024;

/** `Sec-WebSocket-Accept` for a client key. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** One parsed frame, mask already removed. */
export interface WsFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/** Raised by the parser on a MUST violation; carries the close code to send. */
export class WsProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'WsProtocolError';
    this.code = code;
  }
}

/** XOR a payload with its 4-byte mask, in place. Its own function so the
 * masking logic is testable without a socket. */
export function unmask(payload: Buffer, mask: Buffer): Buffer {
  for (let i = 0; i < payload.length; i++) {
    payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  }
  return payload;
}

/** Server→client frame: never masked (RFC 6455 §5.1). */
export function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Client→server frame, masked — the tests are the client, so they need one. */
export function encodeClientFrame(
  opcode: number,
  payload: Buffer,
  mask: Buffer = Buffer.from([0x12, 0x34, 0x56, 0x78]),
  fin = true,
): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = unmask(Buffer.from(payload), mask); // XOR is its own inverse
  return Buffer.concat([header, mask, masked]);
}

/**
 * Incremental frame parser. Feed it chunks as they arrive; it hands back every
 * complete frame and keeps the remainder — TCP owes nobody frame alignment.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): WsFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: WsFrame[] = [];

    for (;;) {
      const frame = this.tryRead();
      if (frame === undefined) return frames;
      frames.push(frame);
    }
  }

  private tryRead(): WsFrame | undefined {
    const data = this.buffer;
    if (data.length < 2) return undefined;

    const first = data[0] ?? 0;
    const second = data[1] ?? 0;
    if ((first & 0x70) !== 0) {
      throw new WsProtocolError(1002, 'reserved bits set without a negotiated extension');
    }
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (!masked) {
      /* §5.1: a server MUST close on an unmasked client frame. Tolerating it
         would also defeat the masking's actual purpose — cache poisoning by
         attacker-chosen bytes on the wire. */
      throw new WsProtocolError(1002, 'client frames must be masked');
    }

    let length = second & 0x7f;
    let offset = 2;
    if (opcode >= 0x8) {
      if (!fin) throw new WsProtocolError(1002, 'control frames must not be fragmented');
      if (length > 125) throw new WsProtocolError(1002, 'control frame payload over 125 bytes');
    }
    if (length === 126) {
      if (data.length < offset + 2) return undefined;
      length = data.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (data.length < offset + 8) return undefined;
      const big = data.readBigUInt64BE(offset);
      if (big > BigInt(MAX_PAYLOAD)) throw new WsProtocolError(1009, 'frame too large');
      length = Number(big);
      offset += 8;
    }
    if (length > MAX_PAYLOAD) throw new WsProtocolError(1009, 'frame too large');

    if (data.length < offset + 4 + length) return undefined;
    const mask = data.subarray(offset, offset + 4);
    const payload = Buffer.from(data.subarray(offset + 4, offset + 4 + length));
    this.buffer = data.subarray(offset + 4 + length);

    return { fin, opcode, payload: unmask(payload, mask) };
  }
}

/** Callbacks a connection reports through. */
export interface WsCallbacks {
  onMessage(text: string): void;
  onClose(): void;
}

/**
 * One accepted connection: fragment assembly, control frames, clean close.
 *
 * `send` takes text because the protocol is one JSON object per text frame —
 * offering a binary path would be an invitation to use it.
 */
export class WsConnection {
  private readonly socket: Duplex;
  private readonly reader = new FrameReader();
  private readonly callbacks: WsCallbacks;
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closed = false;

  constructor(socket: Duplex, callbacks: WsCallbacks) {
    this.socket = socket;
    this.callbacks = callbacks;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.teardown());
    socket.on('close', () => this.teardown());
    /* An http upgrade socket is half-open: when the peer dies, the server side
       gets 'end' and *only* 'end' — 'close' waits for us to end our half. A
       browser tab that vanished used to stay counted as a connected playground
       forever because this listener was missing. */
    socket.on('end', () => this.teardown());
  }

  send(text: string): void {
    if (this.closed) return;
    this.socket.write(encodeServerFrame(0x1, Buffer.from(text, 'utf8')));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.socket.write(encodeServerFrame(0x8, body));
    this.teardown();
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.callbacks.onClose();
  }

  private onData(chunk: Buffer): void {
    let frames: WsFrame[];
    try {
      frames = this.reader.push(chunk);
    } catch (error) {
      const code = error instanceof WsProtocolError ? error.code : 1002;
      this.close(code, error instanceof Error ? error.message : 'protocol error');
      return;
    }
    for (const frame of frames) {
      this.onFrame(frame);
      if (this.closed) return;
    }
  }

  private onFrame(frame: WsFrame): void {
    switch (frame.opcode) {
      case 0x1: // text
      case 0x2: // binary
        if (frame.opcode === 0x2) {
          this.close(1003, 'this protocol is one JSON object per text frame');
          return;
        }
        if (this.fragments.length > 0) {
          this.close(1002, 'new message started inside a fragmented one');
          return;
        }
        if (frame.fin) {
          this.callbacks.onMessage(frame.payload.toString('utf8'));
        } else {
          this.fragmentOpcode = frame.opcode;
          this.fragments = [frame.payload];
        }
        return;

      case 0x0: {
        // continuation
        if (this.fragments.length === 0) {
          this.close(1002, 'continuation frame with nothing to continue');
          return;
        }
        this.fragments.push(frame.payload);
        if (!frame.fin) return;
        const whole = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragmentOpcode === 0x1) this.callbacks.onMessage(whole.toString('utf8'));
        return;
      }

      case 0x8: // close: echo once, then drop
        if (!this.closed) {
          this.socket.write(encodeServerFrame(0x8, frame.payload.subarray(0, 2)));
        }
        this.teardown();
        return;

      case 0x9: // ping → pong with the same payload (§5.5.3)
        this.socket.write(encodeServerFrame(0xa, frame.payload));
        return;

      case 0xa: // pong — unsolicited pongs are allowed and ignored
        return;

      default:
        this.close(1002, `unknown opcode ${String(frame.opcode)}`);
    }
  }
}

/**
 * Complete the upgrade handshake and hand back the connection.
 *
 * Authentication is the caller's job — this function assumes the request was
 * already judged worthy, because "who may connect" is policy (token, origin)
 * and this file is mechanics.
 */
export function acceptUpgrade(
  request: { headers: Record<string, string | string[] | undefined> },
  socket: Duplex,
  callbacks: WsCallbacks,
): WsConnection {
  const key = request.headers['sec-websocket-key'];
  const keyValue = Array.isArray(key) ? key[0] : key;
  if (keyValue === undefined) throw new Error('missing Sec-WebSocket-Key');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(keyValue)}\r\n` +
      '\r\n',
  );
  return new WsConnection(socket, callbacks);
}
