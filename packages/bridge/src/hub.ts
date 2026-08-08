/**
 * The switchboard: playground clients, parked jobs, request ids, relay.
 *
 * Three participants and no two of them can address each other directly (see
 * `docs/BRIDGE.md`), so everything meets here. The hub deliberately knows
 * nothing about sockets or HTTP — a playground is anything that can be handed a
 * {@link Frame}, which is what lets the tests drive it with a fake tab and no
 * port, exactly the way `apps/server` tests drive Fastify through `inject()`.
 *
 * Two disciplines are inherited from the in-page `Bridge` provider
 * (`apps/web/src/lib/bridge.ts`) and kept on purpose:
 *
 * - **Monotonic ids.** Every relayed call and every parked job gets a fresh id,
 *   and a stale answer is refused rather than delivered to the wrong turn.
 * - **One outstanding job.** `generateSound` never issues two completions at
 *   once, so a second `agent.complete` while one is parked is a bug on the
 *   caller's side — failing loudly beats making `sfx_answer` ambiguous.
 *
 * @packageDocumentation
 */

import type { Log } from './log.js';
import { PROTOCOL_VERSION, timeoutForMethod } from './protocol.js';
import type {
  AgentStatus,
  ChatMessage,
  CompleteParams,
  Frame,
  ModelEvent,
  ModelProvisionParams,
  ModelProvisionResult,
  ModelRenderParams,
  ModelRenderResult,
  ModelStatus,
  NextResult,
  ParkedRequest,
} from './protocol.js';
import { resolveRenderer, type NativeRenderer, type RendererResolution } from './render.js';

/** Anything that can be handed a frame. The WS layer adapts real sockets to this. */
export interface PlaygroundPort {
  send(frame: Frame): void;
  close(): void;
}

/** Thrown when a relay has no tab to relay to. The message is the whole point. */
export class NoPlaygroundError extends Error {
  constructor() {
    super('no playground is connected — open http://localhost:5173 and check the bridge badge');
    this.name = 'NoPlaygroundError';
  }
}

/**
 * The surface the tools need, whether the hub is in this process or behind
 * loopback HTTP (`--stdio` next to a running daemon). Everything is async so
 * the two implementations are interchangeable; the local one just resolves
 * immediately where it can.
 */
export interface ToolHub {
  callPlayground(method: string, params: unknown): Promise<unknown>;
  nextRequest(timeoutMs: number): Promise<NextResult>;
  answer(id: string, text: string): Promise<boolean>;
  fail(id: string, message: string): Promise<boolean>;
  agentStatus(): Promise<AgentStatus>;
  playgroundConnected(): Promise<boolean>;
}

/** How a sampling-capable MCP client fulfils a job without polling. */
export type SamplingFulfiller = (request: ParkedRequest) => Promise<string>;

/**
 * The local reference generator, as the hub needs it.
 *
 * An interface rather than the class, for the reason everything else here is
 * injected: the hub must be testable without a 1.7 GB checkpoint on the machine, and
 * a fake that answers `status` is all a frame-level test needs. `StableAudio`
 * satisfies it structurally.
 */
export interface ModelPort {
  status(params: { readonly repo?: string }): Promise<ModelStatus>;
  provision(params: ModelProvisionParams, onEvent: (event: ModelEvent) => void): Promise<ModelProvisionResult>;
  render(
    params: ModelRenderParams,
    onEvent: (event: ModelEvent) => void,
  ): Promise<ModelRenderResult & { readonly audio: Buffer }>;
  cancel(): boolean;
}

interface PendingRelay {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  /** Which tab the call went to, so a *different* tab closing does not kill it. */
  target: PlaygroundPort;
}

interface Job {
  readonly request: ParkedRequest;
  /** `sampling` while a fulfiller is trying; only `parked` jobs are handed to pollers. */
  state: 'sampling' | 'parked';
  readonly origin: PlaygroundPort;
  /** Frame id of the playground's `agent.complete` call, to answer the right turn. */
  readonly frameId: string;
}

interface Waiter {
  resolve(result: NextResult): void;
  timer: NodeJS.Timeout;
}

/** Options of {@link Hub}. */
export interface HubOptions {
  readonly version: string;
  readonly native: NativeRenderer;
  readonly log: Log;
  /** The local diffusion model, when this daemon offers one. */
  readonly model?: ModelPort;
}

/** The one place all three participants meet. */
export class Hub {
  private readonly version: string;
  private readonly native: NativeRenderer;
  private readonly log: Log;
  private readonly model: ModelPort | undefined;

  /** Insertion-ordered; relays go to the most recently greeted tab. */
  private readonly playgrounds = new Map<PlaygroundPort, { app: string; helloed: boolean }>();
  private readonly relays = new Map<string, PendingRelay>();
  private relaySequence = 0;

  private job: Job | undefined;
  private jobSequence = 0;
  private readonly waiters: Waiter[] = [];
  /** Open `GET /agent/next` long-polls — evidence an agent is out there. */
  private activePolls = 0;

  private agent: { client: string; sampling: boolean } | undefined;
  private samplingFulfiller: SamplingFulfiller | undefined;

  /** Latest `catalog` event from a tab; kept for `doctor` and curiosity. */
  private names: readonly string[] = [];

  constructor(options: HubOptions) {
    this.version = options.version;
    this.native = options.native;
    this.log = options.log;
    this.model = options.model;
  }

  /* --- playground lifecycle ---------------------------------------------- */

  attach(port: PlaygroundPort): void {
    this.playgrounds.set(port, { app: '', helloed: false });
  }

  detach(port: PlaygroundPort): void {
    if (!this.playgrounds.delete(port)) return;
    /* A job whose asker is gone can never be answered — a late `sfx_answer`
       would write into a closed socket and report success. Drop it now so the
       agent is told "no longer waiting" instead. */
    if (this.job?.origin === port) this.job = undefined;
    /* Relayed calls to that tab will never get a `result` frame. */
    for (const [id, pending] of this.relays) {
      if (pending.target !== port) continue;
      clearTimeout(pending.timer);
      this.relays.delete(id);
      pending.reject(new Error('the playground disconnected before answering'));
    }
  }

  /** Tabs that completed the `hello`/`welcome` exchange. */
  playgroundCount(): number {
    let count = 0;
    for (const meta of this.playgrounds.values()) if (meta.helloed) count++;
    return count;
  }

  /** Recipe names the tab last announced via the `catalog` event. */
  catalog(): readonly string[] {
    return this.names;
  }

  async renderer(): Promise<RendererResolution> {
    return resolveRenderer(this.playgroundCount() > 0, this.native);
  }

  /* --- frames from a playground ------------------------------------------ */

  handleFrame(port: PlaygroundPort, frame: Frame): void {
    switch (frame.t) {
      case 'hello': {
        const meta = this.playgrounds.get(port);
        if (meta !== undefined) {
          meta.app = frame.app;
          meta.helloed = true;
        }
        void this.renderer().then((resolution) => {
          port.send({
            t: 'welcome',
            version: PROTOCOL_VERSION,
            bridge: this.version,
            renderer: resolution.renderer,
            agent: this.agentStatus(),
          });
        });
        return;
      }
      case 'call':
        this.dispatchCall(port, frame.id, frame.method, frame.params);
        return;
      case 'result': {
        const pending = this.relays.get(frame.id);
        if (pending === undefined) return; // a stale answer names no one to blame
        clearTimeout(pending.timer);
        this.relays.delete(frame.id);
        pending.resolve(frame.result);
        return;
      }
      case 'error': {
        const pending = this.relays.get(frame.id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.relays.delete(frame.id);
        pending.reject(new Error(frame.error.message));
        return;
      }
      case 'event':
        if (frame.event === 'catalog') {
          const data = frame.data as { names?: unknown };
          if (Array.isArray(data?.names)) this.names = data.names.filter((n): n is string => typeof n === 'string');
        }
        return;
      case 'ping':
        port.send({ t: 'pong' });
        return;
      case 'pong':
      case 'welcome':
        return;
    }
  }

  /**
   * A method the playground called on us.
   *
   * An unknown method answers `error` with code `unsupported`, never a dropped
   * frame — a bridge that silently ignores a method makes a timeout look like a
   * hang, and the caller cannot tell our gap from its own bug.
   */
  private dispatchCall(port: PlaygroundPort, id: string, method: string, params: unknown): void {
    switch (method) {
      case 'agent.status':
        port.send({ t: 'result', id, result: this.agentStatus() });
        return;
      case 'agent.complete':
        this.complete(port, id, params as CompleteParams);
        return;
      case 'model.status':
      case 'model.provision':
      case 'model.render':
      case 'model.cancel':
        this.modelCall(port, id, method, (params ?? {}) as Record<string, unknown>);
        return;
      default:
        port.send({
          t: 'error',
          id,
          error: { message: `the bridge does not implement ${method}`, code: 'unsupported' },
        });
    }
  }

  /* --- the reference model ------------------------------------------------- */

  /**
   * `model.*` from the playground: what is installed, install it, render with it.
   *
   * The odd one out among the hub's methods, because it is the only work the daemon
   * does *itself* rather than passing between two participants. It lives here anyway
   * for the reason the bridge exists at all: this is code that must run on the human's
   * machine, reached from a page that may be served from anywhere, and the socket that
   * already carries `agent.complete` is the door that is already open.
   *
   * Progress goes to the asking tab alone, never `broadcast`: a second window watching
   * someone else's install scroll past would be noise, and the events are answers to a
   * question only one of them asked.
   *
   * There is no deadline here. The child has its own — ten minutes for a render, two
   * hours for an install — and a second, shorter one in the hub would turn a working
   * download into a mystery abort. The browser's call timeout is the caller's business.
   */
  private modelCall(port: PlaygroundPort, id: string, method: string, params: Record<string, unknown>): void {
    const model = this.model;
    if (model === undefined) {
      port.send({
        t: 'error',
        id,
        error: {
          code: 'unsupported',
          message:
            'this bridge was built without the reference model — upgrade txt2sfx-bridge, or run the playground under `pnpm dev`',
        },
      });
      return;
    }

    const onEvent = (event: ModelEvent): void => {
      port.send({ t: 'event', event: 'model.log', data: event });
    };
    const repo = typeof params['repo'] === 'string' ? params['repo'] : undefined;
    const token = typeof params['token'] === 'string' ? params['token'] : undefined;

    const work = async (): Promise<unknown> => {
      switch (method) {
        case 'model.status':
          return model.status(repo === undefined ? {} : { repo });
        case 'model.provision':
          return model.provision(
            { ...(repo === undefined ? {} : { repo }), ...(token === undefined ? {} : { token }) },
            onEvent,
          );
        case 'model.render': {
          const result = await model.render(params as ModelRenderParams, onEvent);
          /* Base64 in the answer, because the render was never written anywhere to be
             fetched from. The alternative — a temp file and a second request — is a
             file to clean up and a window in which anything on the machine can read
             it, in exchange for saving a third of a few hundred kilobytes. */
          const { audio, ...rest } = result;
          return { ...rest, audio: audio.toString('base64') };
        }
        default:
          return { stopped: model.cancel() };
      }
    };

    void work().then(
      (result) => port.send({ t: 'result', id, result: result ?? null }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`model: ${method} failed — ${message}`);
        port.send({ t: 'error', id, error: { message } });
      },
    );
  }

  /* --- direction A: relay to the tab -------------------------------------- */

  /**
   * Call a method on the connected playground and await its `result` frame.
   *
   * The most recently greeted tab wins when several are open: it is the one
   * the human is most plausibly looking at, and auditioning a sound in a
   * background tab reads as the tool doing nothing.
   */
  callPlayground(method: string, params: unknown, timeoutMs = timeoutForMethod(method)): Promise<unknown> {
    let target: PlaygroundPort | undefined;
    for (const [port, meta] of this.playgrounds) if (meta.helloed) target = port;
    if (target === undefined) return Promise.reject(new NoPlaygroundError());

    const id = `b${++this.relaySequence}`;
    const chosen = target;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.relays.delete(id);
        reject(
          new Error(
            `the playground did not answer ${method} within ${String(Math.round(timeoutMs / 1000))}s — is the tab still open and awake?`,
          ),
        );
      }, timeoutMs);
      this.relays.set(id, { resolve, reject, timer, target: chosen });
      chosen.send({ t: 'call', id, method, params });
    });
  }

  /* --- direction B: park, poll, answer ------------------------------------ */

  /**
   * `agent.complete` from the playground.
   *
   * With a sampling-capable MCP client attached the job is fulfilled directly
   * by a `sampling/createMessage` server→client request — no polling, and the
   * human watches the recipe appear. When that request errors, or there is no
   * such client, the job parks and `sfx_next_request` is the path. The job
   * record is created *before* the sampling attempt so the one-outstanding-job
   * rule holds during the await, not just after it.
   */
  private complete(origin: PlaygroundPort, frameId: string, params: CompleteParams): void {
    if (this.job !== undefined) {
      origin.send({
        t: 'error',
        id: frameId,
        error: { message: 'a request is already waiting for a reply', code: 'busy' },
      });
      return;
    }

    const messages: readonly ChatMessage[] = Array.isArray(params.messages) ? params.messages : [];
    const system = typeof params.system === 'string' ? params.system : '';
    const request: ParkedRequest = {
      id: `job-${++this.jobSequence}`,
      turn: typeof params.turn === 'number' ? params.turn : this.jobSequence,
      messages,
      system,
      systemBytes: system.length,
    };
    const job: Job = { request, state: 'parked', origin, frameId };
    this.job = job;

    const fulfiller = this.samplingFulfiller;
    if (fulfiller !== undefined) {
      job.state = 'sampling';
      fulfiller(request).then(
        (text) => {
          if (this.job !== job) return; // the tab left; nothing to answer
          this.job = undefined;
          /* Event before result, so a tab updating UI from events has done so
             by the time the awaited call settles. */
          this.broadcast('job.answered', { id: request.id, via: 'sampling' });
          origin.send({ t: 'result', id: frameId, result: { text } });
        },
        (error: unknown) => {
          if (this.job !== job) return;
          this.log(
            `sampling/createMessage failed (${error instanceof Error ? error.message : String(error)}); parking job ${request.id} for polling`,
          );
          job.state = 'parked';
          this.park(job);
        },
      );
      return;
    }

    this.park(job);
  }

  private park(job: Job): void {
    this.broadcast('job.parked', { id: job.request.id, turn: job.request.turn });
    /* Wake every long-poller: they all get the same job, and `answer` settles
       who was first. Waking only one would strand the others until timeout for
       no benefit — the job is idempotent to read. */
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve({ request: job.request });
    }
  }

  /**
   * Long-poll for a parked job.
   *
   * A parked-but-already-delivered job is handed out again: like the in-page
   * `Bridge.request()`, reading is idempotent, and an agent that crashed
   * between `next` and `answer` must be able to pick its work back up rather
   * than leave the playground waiting on a reply that will never come.
   */
  nextRequest(timeoutMs: number): Promise<NextResult> {
    if (this.job !== undefined && this.job.state === 'parked') {
      return Promise.resolve({ request: this.job.request });
    }
    this.activePolls++;
    return new Promise<NextResult>((resolve) => {
      const waiter: Waiter = {
        resolve: (result) => {
          this.activePolls--;
          resolve(result);
        },
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          this.activePolls--;
          resolve({ none: true });
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Answer the parked job. False when `id` is stale — never the wrong turn. */
  answer(id: string, text: string): boolean {
    const job = this.job;
    if (job === undefined || job.request.id !== id) return false;
    this.job = undefined;
    /* Event before result — see the sampling path for why. */
    this.broadcast('job.answered', { id, via: 'poll' });
    job.origin.send({ t: 'result', id: job.frameId, result: { text } });
    return true;
  }

  /** Fail the parked job as a provider error. Same staleness rule as `answer`. */
  fail(id: string, message: string): boolean {
    const job = this.job;
    if (job === undefined || job.request.id !== id) return false;
    this.job = undefined;
    this.broadcast('job.answered', { id, via: 'fail' });
    job.origin.send({ t: 'error', id: job.frameId, error: { message } });
    return true;
  }

  /* --- the agent side ------------------------------------------------------ */

  /**
   * An MCP session announced itself (in-process `--stdio` only — a session
   * behind a remote daemon is inferred from its open long-polls instead).
   */
  setAgent(client: string, sampling: boolean, fulfiller?: SamplingFulfiller): void {
    this.agent = { client, sampling };
    this.samplingFulfiller = fulfiller;
    this.broadcast('agent.attached', { client, sampling });
  }

  clearAgent(): void {
    if (this.agent === undefined) return;
    this.agent = undefined;
    this.samplingFulfiller = undefined;
    this.broadcast('agent.detached', {});
  }

  agentStatus(): AgentStatus {
    if (this.agent !== undefined) {
      return { connected: true, client: this.agent.client, sampling: this.agent.sampling };
    }
    /* No initialize handshake reaches a daemon serving a remote MCP process,
       but an open long-poll is an agent by any useful definition — the badge
       exists to answer "will pressing Generate hang?", not to name a binary. */
    return { connected: this.activePolls > 0, client: null, sampling: false };
  }

  /* --- events --------------------------------------------------------------- */

  broadcast(event: string, data: unknown): void {
    for (const [port, meta] of this.playgrounds) {
      if (meta.helloed) port.send({ t: 'event', event, data });
    }
  }
}

/** The {@link ToolHub} over an in-process hub — `--stdio` with no daemon, and tests. */
export function localToolHub(hub: Hub): ToolHub {
  return {
    callPlayground: (method, params) => hub.callPlayground(method, params),
    nextRequest: (timeoutMs) => hub.nextRequest(timeoutMs),
    answer: (id, text) => Promise.resolve(hub.answer(id, text)),
    fail: (id, message) => Promise.resolve(hub.fail(id, message)),
    agentStatus: () => Promise.resolve(hub.agentStatus()),
    playgroundConnected: () => Promise.resolve(hub.playgroundCount() > 0),
  };
}
