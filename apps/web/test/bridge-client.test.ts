/**
 * The browser half of the bridge, and the failures it has to name properly.
 *
 * The daemon and this client were written independently against `docs/BRIDGE.md`, so the
 * frame shapes are checked here against the document rather than against the other
 * implementation — a test that asserted "whatever the daemon happens to send" would pass
 * even if both halves drifted together.
 *
 * The other half of this file is about error messages, which sounds like polish and is
 * not. There are three ways the `agent` provider can be unusable — no daemon, a daemon
 * with no agent attached, and an agent that answered with nothing — and they have three
 * different fixes. A single "bridge error" would send the user to the wrong one.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { ProviderError } from '@txt2sfx/agent';
import { BridgeClient, DEFAULT_BRIDGE_URL, PROTOCOL, agentProvider } from '../src/lib/bridge-client.js';

/** A client stuck in a chosen state, with `call` recorded rather than sent. */
function stub(state: 'offline' | 'live', agentConnected: boolean, answer?: unknown): BridgeClient & {
  calls: { method: string; params: Record<string, unknown> }[];
} {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    calls,
    current: () => ({
      state,
      url: DEFAULT_BRIDGE_URL,
      error: null,
      health: {
        ok: true,
        version: 'test',
        protocol: PROTOCOL,
        renderer: 'playground' as const,
        tools: [],
        playgrounds: 1,
        agent: { connected: agentConnected, sampling: false },
      },
    }),
    call: (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return Promise.resolve(answer);
    },
  };
  return client as unknown as BridgeClient & { calls: typeof calls };
}

describe('the agent provider', () => {
  it('names the daemon, not the agent, when nothing is listening', async () => {
    const provider = agentProvider(stub('offline', false));
    await expect(provider.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /npx txt2sfx-bridge/,
    );
  });

  /* The half-configured state, and the most common one: the user ran npx and stopped. */
  it('names the MCP registration when the daemon is up but no agent is attached', async () => {
    const provider = agentProvider(stub('live', false));
    await expect(provider.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /MCP server|sfx_next_request/,
    );
  });

  it('does not retry either of those — neither is a transient fault', async () => {
    for (const client of [stub('offline', false), stub('live', false)]) {
      await agentProvider(client)
        .complete({ messages: [{ role: 'user', content: 'hi' }] })
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(ProviderError);
          expect((error as ProviderError & { retryable?: boolean }).retryable).toBe(false);
        });
    }
  });

  it('sends the full conversation and the system prompt, and returns the answer', async () => {
    const client = stub('live', true, { text: '```soundline\nsound "x" 40ms pop\n```' });
    const provider = agentProvider(client);
    const text = await provider.complete({
      messages: [{ role: 'user', content: 'a bubble pop' }],
      system: 'THE WHOLE CONTRACT',
    });

    expect(text).toContain('soundline');
    expect(client.calls[0]?.method).toBe('agent.complete');
    expect(client.calls[0]?.params['system']).toBe('THE WHOLE CONTRACT');
    expect(client.calls[0]?.params['messages']).toEqual([{ role: 'user', content: 'a bubble pop' }]);
    /* 1-based, and it counts calls in this run — the daemon parks one job at a time and
       uses the turn to tell a stale answer from a live one. */
    expect(client.calls[0]?.params['turn']).toBe(1);
  });

  it('counts turns across a repair loop', async () => {
    const client = stub('live', true, { text: 'ok' });
    const provider = agentProvider(client);
    await provider.complete({ messages: [] });
    await provider.complete({ messages: [] });
    expect(client.calls.map((call) => call.params['turn'])).toEqual([1, 2]);
  });

  it('treats an answer with no text as a provider fault rather than an empty recipe', async () => {
    const provider = agentProvider(stub('live', true, { notText: 1 }));
    await expect(provider.complete({ messages: [] })).rejects.toBeInstanceOf(ProviderError);
  });

  /* Abort has to reach the *parked job*, not just this promise: the agent is holding a
     request the user has decided to stop waiting for, and leaving it parked would make
     the next Generate fail with "already waiting". */
  it('cancels the parked job when the run is aborted', async () => {
    const client = stub('live', true);
    const never = { ...client, call: (method: string, params: Record<string, unknown>) => {
      client.calls.push({ method, params });
      return method === 'agent.complete' ? new Promise<never>(() => {}) : Promise.resolve({});
    } } as unknown as BridgeClient & { calls: typeof client.calls };

    const controller = new AbortController();
    const pending = agentProvider(never).complete({ messages: [], signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    await Promise.resolve();
    expect(client.calls.map((call) => call.method)).toContain('agent.cancel');
  });
});

describe('what the client advertises', () => {
  it('starts offline, at the port the dialog and the daemon both name', () => {
    const client = new BridgeClient();
    expect(client.current()).toEqual({ state: 'offline', url: DEFAULT_BRIDGE_URL, health: null, error: null });
    expect(DEFAULT_BRIDGE_URL).toBe('http://127.0.0.1:4455');
  });

  it('replays the current status to a new subscriber immediately', () => {
    const client = new BridgeClient();
    const seen: string[] = [];
    const off = client.onStatus((status) => seen.push(status.state));
    expect(seen).toEqual(['offline']);
    off();
  });

  it('refuses to call anything while disconnected rather than queueing it silently', async () => {
    await expect(new BridgeClient().call('playground.state')).rejects.toThrow(/not connected/);
  });

  it('drops an announce on the floor when there is no socket, instead of throwing', () => {
    expect(() => new BridgeClient().announce(['coin'], 'coin')).not.toThrow();
  });
});
