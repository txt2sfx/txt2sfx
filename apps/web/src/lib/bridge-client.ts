/**
 * The playground's half of the agent bridge.
 *
 * The protocol is specified in `docs/BRIDGE.md` and this module implements the
 * browser side of it verbatim. Two things travel over one socket, in opposite
 * directions, and both matter:
 *
 * - **The agent drives the tab.** `playground.audition` makes this page play a
 *   recipe out loud; `playground.render` measures one in the same
 *   `OfflineAudioContext` that produced the picture on screen; `playground.open`
 *   hands a recipe to the studio so a human can take over. An agent that can make
 *   a noise and be told what it measured does not need an API key: it *is* the
 *   model, and what it was missing was a validator, a renderer and an ear.
 * - **The tab drives the agent.** Choosing `agent` in the provider picker parks the
 *   loop's request in the daemon; the agent answers it with `sfx_answer` and the
 *   loop resumes — validator, render, optimizer, repair message on failure, all
 *   unchanged. This is the existing devtools `Bridge` protocol (`lib/bridge.ts`)
 *   moved onto a socket, which is why the request shape is identical.
 *
 * ## Why a socket and not polling
 *
 * The first direction requires the daemon to *initiate*. A page can only be reached
 * by something it dialled itself, so the tab opens the connection and both
 * directions ride it. `fetch` could serve the second half alone and nothing would
 * make the first work.
 *
 * ## Why this connects to nothing by default
 *
 * `connect()` is called once, at mount, and quietly gives up when there is no
 * daemon: a playground whose console fills with connection errors because the user
 * has not run `npx txt2sfx-bridge` would be punishing them for not using an
 * optional feature. The header badge says `bridge offline` and that is the whole of
 * it — no toast, no modal, no retry storm. Probing backs off to a slow heartbeat so
 * that starting the daemon later is noticed within a couple of seconds without the
 * tab hammering a closed port for an afternoon.
 *
 * @packageDocumentation
 */

import { ProviderError, type CompletionRequest, type LLMProvider, type Message } from '@txt2sfx/agent';

/** Wire version. Bumped only for a breaking change; the daemon reports its own. */
export const PROTOCOL = 1;

/** The default the daemon binds, and what the header badge probes. */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4455';

/** Where a render can happen, in the daemon's order of preference. */
export type Renderer = 'playground' | 'native' | 'none';

/** What `GET /health` answers. Secret-free by contract — it is CORS-open. */
export interface BridgeHealth {
  readonly ok: boolean;
  readonly version: string;
  readonly protocol: number;
  readonly renderer: Renderer;
  readonly tools: readonly string[];
  readonly playgrounds: number;
  readonly agent: {
    readonly connected: boolean;
    readonly client?: string;
    /** Whether the MCP client can be asked for a completion without being polled. */
    readonly sampling: boolean;
  };
}

/** Connection state, as the badge and the dialog read it. */
export interface BridgeStatus {
  readonly state: 'offline' | 'connecting' | 'live';
  readonly url: string;
  readonly health: BridgeHealth | null;
  /** Why it is offline, when there is something useful to say. */
  readonly error: string | null;
}

/** A method the daemon may call on this tab. */
export type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

/* ------------------------------------------------------------------------- *
 * Frames
 * ------------------------------------------------------------------------- */

interface CallFrame {
  readonly t: 'call';
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}
interface ResultFrame {
  readonly t: 'result';
  readonly id: string;
  readonly result: unknown;
}
interface ErrorFrame {
  readonly t: 'error';
  readonly id: string;
  readonly error: { readonly message: string; readonly code?: string };
}
interface WelcomeFrame {
  readonly t: 'welcome';
  readonly version: number;
  readonly bridge: string;
  readonly renderer: Renderer;
  readonly agent: BridgeHealth['agent'];
}
interface EventFrame {
  readonly t: 'event';
  readonly event: string;
  readonly data?: unknown;
}

type Inbound = CallFrame | ResultFrame | ErrorFrame | WelcomeFrame | EventFrame | { readonly t: 'ping' | 'pong' };

/** How long an outbound call waits before it is declared lost. */
const CALL_TIMEOUT_MS = 60_000;

/** How long `agent.complete` waits. A human-in-the-loop agent is slow on purpose. */
const COMPLETE_TIMEOUT_MS = 15 * 60_000;

/**
 * How often to look for a daemon that is not there.
 *
 * Backed off rather than fixed, and the reason is the browser's console. A `fetch` to a
 * closed port always logs `ERR_CONNECTION_REFUSED`, and nothing in JavaScript can
 * suppress it — so a flat two-second probe writes an error into devtools every two
 * seconds for as long as the tab is open, which is a hostile thing to do to someone
 * debugging their own recipe. The first few attempts stay fast, because "I just ran npx
 * and I am watching the badge" is the moment that matters; after that it settles to once
 * a minute, which still finds a daemon started later without anyone noticing the wait.
 */
const PROBE_STEPS_MS: readonly number[] = [2500, 2500, 2500, 5000, 10_000, 30_000, 60_000];

/* ------------------------------------------------------------------------- *
 * The client
 * ------------------------------------------------------------------------- */

/**
 * One connection to one daemon.
 *
 * A singleton for the same reason `bridge` is: two sockets would both receive
 * `playground.audition` and the page would play a sound twice.
 */
export class BridgeClient {
  private socket: WebSocket | null = null;
  private url = DEFAULT_BRIDGE_URL;
  private status: BridgeStatus = { state: 'offline', url: DEFAULT_BRIDGE_URL, health: null, error: null };
  private readonly handlers = new Map<string, Handler>();
  private readonly listeners = new Set<(status: BridgeStatus) => void>();
  private readonly events = new Set<(event: string, data: unknown) => void>();
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: number }
  >();
  private sequence = 0;
  private probe: number | null = null;
  private misses = 0;
  private stopped = true;

  /* --- what the UI reads --- */

  current(): BridgeStatus {
    return this.status;
  }

  /** Subscribe to status changes. Fires immediately with the current one. */
  onStatus(listener: (status: BridgeStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to the daemon's fire-and-forget events. */
  onEvent(listener: (event: string, data: unknown) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  /**
   * Register what this tab can do for an agent.
   *
   * Called once per method by `App`, from a ref-backed closure — the handlers must
   * see the *current* recipe rather than the one that was on screen when the effect
   * ran, which is the same hazard `window.txt2sfx` solved with `live`.
   */
  handle(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  /* --- lifecycle --- */

  /** Start probing for a daemon and stay connected to whichever one answers. */
  start(url = DEFAULT_BRIDGE_URL): void {
    this.url = url.replace(/\/+$/, '');
    this.stopped = false;
    this.misses = 0;
    this.emit({ state: 'offline', url: this.url, health: null, error: null });
    void this.attempt();
    this.schedule();
  }

  /** Arm the next probe at whatever the current backoff step is. */
  private schedule(): void {
    if (this.probe !== null) window.clearTimeout(this.probe);
    if (this.stopped) return;
    const step = PROBE_STEPS_MS[Math.min(this.misses, PROBE_STEPS_MS.length - 1)] ?? 60_000;
    this.probe = window.setTimeout(() => {
      this.probe = null;
      if (this.stopped || this.socket !== null) {
        this.schedule();
        return;
      }
      void this.attempt().finally(() => this.schedule());
    }, step);
  }

  /** Give up, close, and stop probing. */
  stop(): void {
    this.stopped = true;
    if (this.probe !== null) {
      window.clearTimeout(this.probe);
      this.probe = null;
    }
    this.socket?.close();
    this.socket = null;
    this.emit({ state: 'offline', url: this.url, health: null, error: null });
  }

  /** Point at a different daemon. */
  retarget(url: string): void {
    this.stop();
    this.start(url);
  }

  /** Ask again, right now — what the dialog's Re-check button does. */
  async recheck(): Promise<BridgeStatus> {
    /* Reset the backoff: someone pressing this button has just done something, and the
       probe being an hour into its slow phase is not their problem. */
    this.misses = 0;
    if (this.socket === null) await this.attempt();
    else await this.refreshHealth();
    this.schedule();
    return this.status;
  }

  /**
   * One connection attempt: health, then pair, then socket.
   *
   * In that order because each answers a different question, and reporting the
   * wrong one is a support burden: a closed port and a daemon that refused to pair
   * with this origin look identical from a failed WebSocket.
   */
  private async attempt(): Promise<void> {
    if (this.stopped || this.socket !== null) return;

    const health = await this.fetchHealth();
    if (health === null) {
      this.misses++;
      this.emit({ state: 'offline', url: this.url, health: null, error: null });
      return;
    }
    /* A daemon answered, so the next disconnection deserves the fast probe again. */
    this.misses = 0;
    if (health.protocol !== PROTOCOL) {
      this.emit({
        state: 'offline',
        url: this.url,
        health,
        error: `the daemon speaks protocol ${String(health.protocol)}, this playground speaks ${String(PROTOCOL)} — upgrade one of them`,
      });
      return;
    }

    this.emit({ state: 'connecting', url: this.url, health, error: null });

    let token: string;
    try {
      const response = await fetch(`${this.url}/pair`, { credentials: 'omit' });
      if (!response.ok) {
        this.emit({
          state: 'offline',
          url: this.url,
          health,
          error:
            response.status === 403
              ? `the daemon will not pair with ${window.location.origin} — restart it with --allow-origin ${window.location.origin}`
              : `pairing failed with HTTP ${String(response.status)}`,
        });
        return;
      }
      token = ((await response.json()) as { token?: string }).token ?? '';
    } catch (error: unknown) {
      this.emit({ state: 'offline', url: this.url, health, error: describe(error) });
      return;
    }

    this.open(token, health);
  }

  private open(token: string, health: BridgeHealth): void {
    const ws = new URL(this.url);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
    ws.pathname = '/ws';
    ws.search = `?token=${encodeURIComponent(token)}&role=playground`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(ws.toString());
    } catch (error: unknown) {
      this.emit({ state: 'offline', url: this.url, health, error: describe(error) });
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ t: 'hello', role: 'playground', version: PROTOCOL, app: 'txt2sfx-playground' }));
    };

    socket.onmessage = (message: MessageEvent<string>) => {
      let frame: Inbound;
      try {
        frame = JSON.parse(message.data) as Inbound;
      } catch {
        /* A frame we cannot parse is the daemon's bug, not a reason to drop the
           connection: everything else on this socket still works. */
        return;
      }
      void this.receive(frame, socket);
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.failAllPending('the bridge connection closed');
      if (this.stopped) return;
      /* A daemon that was here a moment ago is usually restarting, so go back to the fast
         probe rather than inheriting whatever step the last cold start left behind. */
      this.misses = 0;
      this.emit({ state: 'offline', url: this.url, health: null, error: null });
      this.schedule();
    };

    /* No handler body: a failed connection arrives as `close` too, and reporting
       the same fact twice would make the badge flicker. */
    socket.onerror = () => {};
  }

  private async receive(frame: Inbound, socket: WebSocket): Promise<void> {
    switch (frame.t) {
      case 'welcome':
        this.emit({
          state: 'live',
          url: this.url,
          health: { ...(this.status.health ?? blankHealth(this.url)), renderer: frame.renderer, agent: frame.agent },
          error: null,
        });
        return;

      case 'ping':
        socket.send(JSON.stringify({ t: 'pong' }));
        return;

      case 'event':
        for (const listener of this.events) listener(frame.event, frame.data);
        /* Agent attach and detach change what the badge should say, and the tab has
           no other way to learn it — the socket is to the daemon, not to the agent. */
        if (frame.event === 'agent.attached' || frame.event === 'agent.detached') void this.refreshHealth();
        return;

      case 'result': {
        const waiting = this.pending.get(frame.id);
        if (waiting === undefined) return;
        this.pending.delete(frame.id);
        window.clearTimeout(waiting.timer);
        waiting.resolve(frame.result);
        return;
      }

      case 'error': {
        const waiting = this.pending.get(frame.id);
        if (waiting === undefined) return;
        this.pending.delete(frame.id);
        window.clearTimeout(waiting.timer);
        waiting.reject(new Error(frame.error.message));
        return;
      }

      case 'call': {
        const handler = this.handlers.get(frame.method);
        if (handler === undefined) {
          /* Named `unsupported` rather than dropped. A bridge that silently ignores
             a method makes an agent wait out its timeout and then guess why. */
          socket.send(
            JSON.stringify({
              t: 'error',
              id: frame.id,
              error: { code: 'unsupported', message: `the playground does not implement ${frame.method}` },
            }),
          );
          return;
        }
        try {
          const result = await handler(frame.params ?? {});
          socket.send(JSON.stringify({ t: 'result', id: frame.id, result: result ?? null }));
        } catch (error: unknown) {
          socket.send(JSON.stringify({ t: 'error', id: frame.id, error: { message: describe(error) } }));
        }
        return;
      }

      default:
        return;
    }
  }

  /* --- outbound --- */

  /** Call a method on the daemon. Rejects on timeout, close, or a remote error. */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('the bridge is not connected'));
    }
    const id = `pg-${String(++this.sequence)}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${String(Math.round(timeoutMs / 1000))}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ t: 'call', id, method, params }));
    });
  }

  /** Tell the daemon what this tab is holding, so `sfx_bank_*` can name things. */
  announce(names: readonly string[], selected: string): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ t: 'event', event: 'catalog', data: { names, selected } }));
  }

  private failAllPending(reason: string): void {
    for (const [, waiting] of this.pending) {
      window.clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private async fetchHealth(): Promise<BridgeHealth | null> {
    try {
      const response = await fetch(`${this.url}/health`, { credentials: 'omit' });
      if (!response.ok) return null;
      const body = (await response.json()) as Partial<BridgeHealth>;
      if (body.ok !== true) return null;
      return { ...blankHealth(this.url), ...body } as BridgeHealth;
    } catch {
      /* No daemon, or one that is not ours. Either way: offline, quietly. */
      return null;
    }
  }

  private async refreshHealth(): Promise<void> {
    const health = await this.fetchHealth();
    if (health === null) return;
    this.emit({ ...this.status, health });
  }

  private emit(status: BridgeStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

function blankHealth(_url: string): BridgeHealth {
  return {
    ok: true,
    version: 'unknown',
    protocol: PROTOCOL,
    renderer: 'none',
    tools: [],
    playgrounds: 0,
    agent: { connected: false, sampling: false },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The one client. */
export const bridgeClient = new BridgeClient();

/* ------------------------------------------------------------------------- *
 * The agent as a provider
 * ------------------------------------------------------------------------- */

/**
 * A provider whose model is the coding agent on the other end of the bridge.
 *
 * The request shape is the devtools bridge's, unchanged, because the two are the
 * same idea with different transport — and because the daemon relays it to
 * `sfx_next_request` without rewriting it, so a message history the agent can read
 * is the *only* useful shape. The system prompt travels in full: it is the
 * generated contract, and an agent asked to write soundline without it will invent
 * a grammar.
 */
export function agentProvider(client: BridgeClient = bridgeClient): LLMProvider {
  let turn = 0;

  return {
    name: 'agent',
    model: 'bridge',
    complete: async (request: CompletionRequest): Promise<string> => {
      if (client.current().state !== 'live') {
        throw new ProviderError({
          provider: 'agent',
          message: 'no bridge is connected — run `npx txt2sfx-bridge` and check the badge in the header',
          retryable: false,
        });
      }
      const status = client.current().health?.agent;
      if (status?.connected !== true) {
        throw new ProviderError({
          provider: 'agent',
          message:
            'the bridge is up but no agent is attached — register txt2sfx as an MCP server in your agent and ask it to call sfx_next_request',
          retryable: false,
        });
      }

      turn += 1;
      const params: Record<string, unknown> = {
        turn,
        messages: request.messages as readonly Message[],
        system: request.system ?? '',
      };

      /* Abort has to reach the parked job, not just this promise: the agent is
         holding a request the user has decided to stop waiting for, and leaving it
         parked would make the next Generate fail with "already waiting". */
      const race = client.call('agent.complete', params, COMPLETE_TIMEOUT_MS);
      const signal = request.signal;
      if (signal === undefined) return textOf(await race);

      const aborted = new Promise<never>((_, reject) => {
        const fail = (): void =>
          reject(new ProviderError({ provider: 'agent', message: 'the request was aborted', retryable: false }));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });

      try {
        return textOf(await Promise.race([race, aborted]));
      } finally {
        if (signal.aborted) void client.call('agent.cancel', { turn }).catch(() => undefined);
      }
    },
  };
}

function textOf(result: unknown): string {
  const text = (result as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') throw new ProviderError({ provider: 'agent', message: 'the agent answered with no text' });
  return text;
}
