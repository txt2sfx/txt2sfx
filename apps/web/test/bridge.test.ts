/**
 * The devtools bridge.
 *
 * The last test is the one that matters: the whole loop — extraction, validator,
 * repair, acceptance — driven by replies written here, with no network and no
 * browser. That is the same path an agent holding devtools takes, so if this passes
 * and a bridged run in the page misbehaves, the fault is in the page, not the
 * protocol.
 */

import { describe, expect, it } from 'vitest';
import { generateSound } from '@txt2sfx/agent';
import { Bridge, type BridgeRequest } from '../src/lib/bridge.js';

const GOOD = `sound "ui click" 45ms ui
  tick: click 2ms >> hp 1200Hz | gain 0.6 attack 0ms decay 25ms
`;

/** A reply in the shape a model sends one. */
const fenced = (recipe: string): string => `Here you go.\n\n\`\`\`soundline\n${recipe}\`\`\`\n`;

/** Spin until a request shows up, so a test never races the loop's first turn. */
async function waitForRequest(bridge: Bridge): Promise<BridgeRequest> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const request = bridge.request();
    if (request !== null) return request;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('no request arrived');
}

describe('bridge protocol', () => {
  it('parks a request and resolves it with the reply', async () => {
    const bridge = new Bridge();
    const provider = bridge.provider();
    expect(bridge.request()).toBeNull();

    const pending = provider.complete({ system: 'contract', messages: [{ role: 'user', content: 'a click' }] });
    const request = await waitForRequest(bridge);

    expect(request.turn).toBe(1);
    /* The conversation is exposed, the 12 KB contract is not — it is asked for. */
    expect(bridge.request()?.messages).toEqual([{ role: 'user', content: 'a click' }]);
    expect(bridge.request()?.systemBytes).toBe('contract'.length);
    expect(bridge.system()).toBe('contract');

    expect(bridge.reply(request.id, 'answer')).toBe(true);
    await expect(pending).resolves.toBe('answer');
    expect(bridge.request()).toBeNull();
  });

  /* A stale answer has to bounce rather than land on the turn after the one it was
     written for — that would attribute a reply to a request it never saw. */
  it('refuses a reply for anything but the waiting request', async () => {
    const bridge = new Bridge();
    const provider = bridge.provider();
    const pending = provider.complete({ messages: [{ role: 'user', content: 'x' }] });
    const request = await waitForRequest(bridge);

    expect(bridge.reply(request.id + 7, 'wrong turn')).toBe(false);
    expect(bridge.reply(request.id, 'right turn')).toBe(true);
    await expect(pending).resolves.toBe('right turn');
    /* Nothing is waiting now, so even the correct id is stale. */
    expect(bridge.reply(request.id, 'again')).toBe(false);
  });

  it('can fail a request the way a provider fails', async () => {
    const bridge = new Bridge();
    const pending = bridge.provider().complete({ messages: [{ role: 'user', content: 'x' }] });
    const request = await waitForRequest(bridge);
    expect(bridge.fail(request.id, 'rate limited')).toBe(true);
    await expect(pending).rejects.toThrow(/bridge: rate limited/);
  });

  /* Stop has to work even when the "model" is a person who wandered off. */
  it('rejects the waiting request when the run is aborted', async () => {
    const bridge = new Bridge();
    const controller = new AbortController();
    const pending = bridge.provider().complete({
      messages: [{ role: 'user', content: 'x' }],
      signal: controller.signal,
    });
    await waitForRequest(bridge);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(bridge.request()).toBeNull();
  });

  it('rejects a second request rather than answering the wrong one', async () => {
    const bridge = new Bridge();
    const provider = bridge.provider();
    const first = provider.complete({ messages: [{ role: 'user', content: 'x' }] });
    await waitForRequest(bridge);
    await expect(provider.complete({ messages: [{ role: 'user', content: 'y' }] })).rejects.toThrow(
      /already waiting/,
    );
    const request = bridge.request();
    bridge.reply(request?.id ?? 0, 'done');
    await expect(first).resolves.toBe('done');
  });

  it('refuses to start a run before the prompt bar has mounted', () => {
    expect(() => new Bridge().run('a click')).toThrow(/not mounted/);
  });

  it('hands a run request to the prompt bar', () => {
    const bridge = new Bridge();
    const seen: { prompt: string; target?: boolean }[] = [];
    bridge.setRunner((prompt, options) => seen.push({ prompt, ...options }));
    bridge.run('a click', { target: true });
    expect(seen).toEqual([{ prompt: 'a click', target: true }]);
  });
});

describe('driving the whole loop by hand', () => {
  /**
   * Two turns: a reply the validator rejects, then a good one. The point is that the
   * repair message the loop generates is visible to the driver — that text is the
   * thing being debugged when the loop is going wrong.
   */
  it('runs a repair and an acceptance with replies written here', async () => {
    const bridge = new Bridge();
    const events: string[] = [];

    const run = generateSound({
      prompt: 'crisp ui click',
      provider: bridge.provider(),
      maxIterations: 3,
      onEvent: (event) => events.push(event.type),
    });

    /* Turn 1: a `pop` far longer than the category allows. */
    const first = await waitForRequest(bridge);
    bridge.reply(
      first.id,
      fenced('sound "long pop" 400ms pop\n  body: tone sine 480Hz | gain 0.9 decay 380ms\n'),
    );

    /* Turn 2 exists only because the validator said no — and it carries the reason. */
    const second = await waitForRequest(bridge);
    const feedback = second.messages.at(-1)?.content ?? '';
    expect(feedback).toContain('pop');
    expect(feedback.toLowerCase()).toMatch(/duration|shorten/);
    bridge.reply(second.id, fenced(GOOD));

    const result = await run;
    expect(result.accepted).toBe(true);
    expect(result.soundline).toContain('sound "ui click"');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.outcome).toBe('invalid');
    expect(events).toContain('feedback');
  });

  /* A reply with no fenced block is a refusal, from a person exactly as from a
     model — which is what makes "answer it wrong on purpose" a usable experiment. */
  it('treats an unfenced reply as a refusal', async () => {
    const bridge = new Bridge();
    const run = generateSound({ prompt: 'a human voice saying hello', provider: bridge.provider() });
    const request = await waitForRequest(bridge);
    bridge.reply(request.id, 'Procedural synthesis cannot make a believable human voice.');

    const result = await run;
    expect(result.outcome).toBe('refused');
    expect(result.message).toMatch(/cannot make a believable human voice/);
  });
});
