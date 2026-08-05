/**
 * A provider whose model is whoever is holding the debugger.
 *
 * ## Why this exists
 *
 * Tuning the loop against a hosted model is a slow, noisy experiment: every change
 * to the prompt, the contract or the repair messages costs a round trip, money, and
 * a different sample from a temperature-1 distribution, so two runs never disagree
 * for one reason. The bridge removes the network and the sampling: the request is
 * published into the page, an agent (or a human) writes the reply by hand, and
 * everything downstream — extraction, validator, render, optimizer, feedback — runs
 * exactly as it does for Gemini. What is being tested is *our* half.
 *
 * It is also the fastest way to answer "is this failure the model's fault or ours?".
 * Answer the request with a recipe you know is right; if the run still ends badly,
 * the fault was never upstream.
 *
 * ## Not in a production build
 *
 * The channel is installed on `window` only under `vite dev` (see `App.tsx`), and
 * the picker offers this provider only there. A global that injects model replies
 * into a live loop is a debugging instrument, and shipping one in a static bundle
 * would be sloppy rather than dangerous — but sloppy is enough of a reason.
 *
 * ## The protocol
 *
 * One request is outstanding at a time, which is all `generateSound` ever issues.
 * `complete()` parks a promise; `reply(id, text)` resolves it, `fail(id, message)`
 * rejects it as a provider error, and an aborted run rejects it too — the Stop
 * button has to work even when the "model" is a person who wandered off.
 *
 * @packageDocumentation
 */

import { ProviderError, type CompletionRequest, type LLMProvider, type Message } from '@txt2sfx/agent';

/** A request waiting for an answer. */
export interface BridgeRequest {
  /** Monotonic id; `reply` refuses a stale one rather than answering the wrong turn. */
  readonly id: number;
  /** 1-based, counting calls in this run. */
  readonly turn: number;
  /**
   * The conversation so far. The system prompt is *not* here — it is 12 KB of
   * generated contract, and a reader that wants it can ask {@link Bridge.system}.
   */
  readonly messages: readonly Message[];
  readonly systemBytes: number;
}

/** What a caller sees while nothing is pending. */
type Resolver = { resolve: (text: string) => void; reject: (error: unknown) => void };

/** The dev-only channel between the loop and whoever is answering it. */
export class Bridge {
  private sequence = 0;
  private current: { request: BridgeRequest; resolver: Resolver; system: string } | undefined;
  private runner: ((prompt: string, options: { target?: boolean }) => void) | undefined;

  /** A provider that asks this channel instead of a network. */
  provider(): LLMProvider {
    return {
      name: 'bridge',
      model: 'devtools',
      complete: (request: CompletionRequest) => this.enqueue(request),
    };
  }

  private enqueue(request: CompletionRequest): Promise<string> {
    if (this.current !== undefined) {
      /* Two outstanding requests would make `reply` ambiguous, and the loop never
         issues them. Failing loudly beats answering the wrong turn. */
      return Promise.reject(
        new ProviderError({ provider: 'bridge', message: 'a request is already waiting for a reply' }),
      );
    }
    const system = request.system ?? '';
    const id = ++this.sequence;
    const parked: BridgeRequest = {
      id,
      turn: id,
      messages: [...request.messages],
      systemBytes: system.length,
    };

    return new Promise<string>((resolve, reject) => {
      this.current = { request: parked, resolver: { resolve, reject }, system };

      const signal = request.signal;
      if (signal === undefined) return;
      if (signal.aborted) {
        this.settle(id, () =>
          reject(new ProviderError({ provider: 'bridge', message: 'the request was aborted' })),
        );
        return;
      }
      signal.addEventListener(
        'abort',
        () =>
          this.settle(id, () =>
            reject(new ProviderError({ provider: 'bridge', message: 'the request was aborted' })),
          ),
        { once: true },
      );
    });
  }

  /** Clear the slot and run `finish`, but only if `id` is still the live request. */
  private settle(id: number, finish: () => void): boolean {
    if (this.current?.request.id !== id) return false;
    this.current = undefined;
    finish();
    return true;
  }

  /** The request waiting for an answer, or `null`. */
  request(): BridgeRequest | null {
    return this.current?.request ?? null;
  }

  /** The system prompt of the waiting request — the generated contract document. */
  system(): string | null {
    return this.current?.system ?? null;
  }

  /**
   * Answer the waiting request.
   *
   * The text goes through the same extraction the vendors' text does, so a fenced
   * `soundline` block is what to send — and a reply with no fence is read as a
   * refusal, exactly as it would be from a model.
   *
   * @returns False when `id` is not the waiting request, which is how a stale
   *   answer announces itself instead of landing on the wrong turn.
   */
  reply(id: number, text: string): boolean {
    const resolver = this.current?.resolver;
    return this.settle(id, () => resolver?.resolve(text));
  }

  /** Fail the waiting request as a provider error — for testing the error path. */
  fail(id: number, message: string): boolean {
    const resolver = this.current?.resolver;
    return this.settle(id, () =>
      resolver?.reject(new ProviderError({ provider: 'bridge', message, retryable: false })),
    );
  }

  /** Registered by the prompt bar so a run can be started without the keyboard. */
  setRunner(runner: (prompt: string, options: { target?: boolean }) => void): void {
    this.runner = runner;
  }

  /** Start a run. Throws when the prompt bar has not mounted yet. */
  run(prompt: string, options: { target?: boolean } = {}): void {
    if (this.runner === undefined) throw new Error('the prompt bar is not mounted');
    this.runner(prompt, options);
  }
}

/** The one channel. A second would make `request()` ambiguous. */
export const bridge = new Bridge();
