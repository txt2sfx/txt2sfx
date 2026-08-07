/**
 * The prompt bar's glue.
 *
 * The loop itself is covered in `packages/agent`; what is tested here is only what
 * the browser adds — the header that makes Anthropic answer a page at all, the key
 * going nowhere but the request, the mock that answers from the local recipes, and
 * the naming rule that stops a second run from overwriting the first.
 *
 * Nothing here needs an audio stack, which is why `renderSignalFor` and
 * `targetFromBuffer` are not in this file: they are `AudioBuffer` plumbing, and a
 * fake `AudioBuffer` would test the fake.
 */

import { describe, expect, it } from 'vitest';
import { ANTHROPIC_DEFAULT_MODEL, GEMINI_DEFAULT_MODEL, type FetchLike } from '@txt2sfx/agent';
import {
  ALL_PROVIDER_OPTIONS,
  demoProvider,
  describeEvent,
  keyedProvider,
  needsKey,
  providerOptions,
  rankDemoRecipes,
  recipeName,
} from '../src/lib/agent.js';

/** Capture the one request a provider makes, and answer it. */
function capture(body: unknown): { fetch: FetchLike; seen: { url: string; init: RequestInit }[] } {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = (url, init) => {
    seen.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
  return { fetch, seen };
}

const RECIPES = [
  { name: 'coin', soundline: 'sound "coin" 180ms pickup\n  tone square 1319Hz\n' },
  { name: 'laser', soundline: 'sound "laser" 150ms laser\n  chirp saw 2400Hz -> 300Hz\n' },
  { name: 'ui-click', soundline: 'sound "ui-click" 20ms ui\n  click 1ms\n' },
];

describe('provider picker', () => {
  /* Mock first, then the two that need no key, then the two that do. The order is the
     cost of asking, ascending, which is the order someone deciding should meet them in. */
  it('offers the keyless options first, with mock at the head', () => {
    expect(providerOptions(false).map((option) => option.kind)).toEqual(['mock', 'agent', 'gemini', 'anthropic']);
    expect(needsKey('mock')).toBe(false);
    expect(needsKey('gemini')).toBe(true);
    expect(needsKey('anthropic')).toBe(true);
  });

  /* The point of the `agent` provider: the coding agent on the other end of the bridge
     already holds a language model, so there is no credential in that path at all. A
     regression that made it ask for a key would break the claim, not just the UI. */
  it('ships the bridged agent in a static build and never asks it for a key', () => {
    expect(providerOptions(false).map((option) => option.kind)).toContain('agent');
    expect(needsKey('agent')).toBe(false);
    expect(ALL_PROVIDER_OPTIONS.find((option) => option.kind === 'agent')?.devOnly).toBeUndefined();
  });

  /* The bridge answers a live model loop from a debugger. Useful in dev, no business
     in a page someone else opens. */
  it('keeps the devtools bridge out of a static build', () => {
    expect(providerOptions(true).map((option) => option.kind)).toContain('bridge');
    expect(providerOptions(false).map((option) => option.kind)).not.toContain('bridge');
    expect(ALL_PROVIDER_OPTIONS.find((option) => option.kind === 'bridge')?.devOnly).toBe(true);
    expect(needsKey('bridge')).toBe(false);
  });

  it('sends a Gemini key in the header, never in the URL', async () => {
    const { fetch, seen } = capture({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    const provider = keyedProvider('gemini', 'AIza-secret', { fetch });
    await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });

    const call = seen[0];
    expect(call).toBeDefined();
    expect(call?.url).not.toContain('AIza-secret');
    expect((call?.init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-secret');
  });

  /* Without this header `api.anthropic.com` refuses a cross-origin request from a
     page, and the failure arrives as an opaque CORS error with no body. */
  it('opts in to direct browser access for Anthropic', async () => {
    const { fetch, seen } = capture({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
    const provider = keyedProvider('anthropic', 'sk-ant-secret', { fetch });
    await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });

    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(headers['x-api-key']).toBe('sk-ant-secret');
  });

  it('refuses a blank key before spending a round trip on a 401', () => {
    expect(() => keyedProvider('gemini', '   ')).toThrow(/no API key/);
  });

  it('passes a model override through', async () => {
    const { fetch, seen } = capture({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    const provider = keyedProvider('gemini', 'key', { fetch, model: 'gemini-3-pro' });
    expect(provider.model).toBe('gemini-3-pro');
    await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });
    expect(seen[0]?.url).toContain('gemini-3-pro');
  });

  /* An empty box means "the provider's default" — not a request for a model named
     "", which would be a 404 the user cannot explain. */
  it('treats an empty model box as no override', () => {
    expect(keyedProvider('gemini', 'key', { model: '' }).model).toBe(GEMINI_DEFAULT_MODEL);
  });

  /* The placeholder promises what the request will do. Vendors retire model ids —
     `gemini-2.5-flash` began answering 404 for new keys — so the id moves, and a
     second copy of it in the UI would eventually lie about which model was called. */
  it('shows the same default the provider will actually call', () => {
    const shown = new Map(ALL_PROVIDER_OPTIONS.map((option) => [option.kind, option.defaultModel]));
    expect(shown.get('gemini')).toBe(GEMINI_DEFAULT_MODEL);
    expect(shown.get('anthropic')).toBe(ANTHROPIC_DEFAULT_MODEL);
    expect(keyedProvider('gemini', 'key').model).toBe(GEMINI_DEFAULT_MODEL);
    expect(keyedProvider('anthropic', 'key').model).toBe(ANTHROPIC_DEFAULT_MODEL);
  });
});

describe('mock provider', () => {
  it('ranks a name match above a body match', () => {
    const ranked = rankDemoRecipes('a bright laser zap', RECIPES);
    expect(ranked[0]?.name).toBe('laser');
  });

  it('is stable for a prompt that matches nothing', () => {
    const first = rankDemoRecipes('xylophone', RECIPES).map((recipe) => recipe.name);
    const again = rankDemoRecipes('xylophone', RECIPES).map((recipe) => recipe.name);
    expect(first).toEqual(again);
  });

  it('answers with a fenced recipe the loop can extract', async () => {
    const provider = demoProvider({ prompt: 'coin pickup', recipes: RECIPES });
    const reply = await provider.complete({ messages: [{ role: 'user', content: 'coin pickup' }] });
    expect(reply).toContain('```soundline');
    expect(reply).toContain('sound "coin"');
    expect(reply).toContain('No model was called');
  });

  /* The repair path has to see a *different* candidate, or the loop spends its
     iterations rediscovering the same rejection. */
  it('offers the next candidate on each call', async () => {
    const provider = demoProvider({ prompt: 'coin pickup', recipes: RECIPES });
    const request = { messages: [{ role: 'user' as const, content: 'coin pickup' }] };
    const first = await provider.complete(request);
    const second = await provider.complete(request);
    expect(first).not.toBe(second);
    expect(second).toContain('```soundline');
  });

  /* Running dry ends the run: a cycling mock turns a loop bug into a conversation
     that never stops and merely looks slow. The sentence has no fence, which the
     loop reads as a refusal and reports verbatim. */
  it('says so when it runs out, without a fence', async () => {
    const provider = demoProvider({ prompt: 'coin', recipes: RECIPES.slice(0, 1) });
    const request = { messages: [{ role: 'user' as const, content: 'coin' }] };
    await provider.complete(request);
    const exhausted = await provider.complete(request);
    expect(exhausted).not.toContain('```');
    expect(exhausted).toMatch(/out of local candidates/);
  });

  it('says something useful when there are no recipes at all', async () => {
    const provider = demoProvider({ prompt: 'coin', recipes: [] });
    const reply = await provider.complete({ messages: [{ role: 'user', content: 'coin' }] });
    expect(reply).toMatch(/no local recipes/);
  });
});

describe('recipe naming', () => {
  it('slugs a prompt down to a file name', () => {
    expect(recipeName('A heavy metal door slamming shut in a corridor', [])).toBe('a-heavy-metal-door');
    expect(recipeName('Coin pickup!', [])).toBe('coin-pickup');
  });

  it('falls back rather than producing an empty name', () => {
    expect(recipeName('!!! ???', [])).toBe('sound');
  });

  /* Two runs of "laser" are two candidates to compare; overwriting the first would
     throw away the comparison the user was in the middle of making. */
  it('never collides with a name already shown', () => {
    expect(recipeName('laser', ['laser'])).toBe('laser-2');
    expect(recipeName('laser', ['laser', 'laser-2'])).toBe('laser-3');
  });
});

describe('progress lines', () => {
  it('describes every event the loop can emit', () => {
    expect(describeEvent({ type: 'request', iteration: 1 })).toContain('attempt 1');
    expect(describeEvent({ type: 'reply', iteration: 1, text: 'abc' })).toContain('3 chars');
    expect(
      describeEvent({
        type: 'validated',
        iteration: 1,
        soundline: 'sound "x" 40ms pop\n',
        issues: [
          { severity: 'error', layer: null, rule: 'a', got: '', expected: '', hint: '' },
          { severity: 'warn', layer: null, rule: 'b', got: '', expected: '', hint: '' },
        ],
      }),
    ).toContain('1 error(s), 1 warning(s)');
    expect(describeEvent({ type: 'validated', iteration: 1, soundline: '', issues: [] })).toContain('clean');
    expect(describeEvent({ type: 'rendered', iteration: 1, peak: 0.5 })).toContain('0.500');
    /* The distance, not the fitness. The fitness carries penalties the user never
       asked about — a clipping candidate, an anchor holding the search to the recipe
       — and a live number that ends up disagreeing with the verdict is worse than no
       live number at all. */
    expect(
      describeEvent({
        type: 'generation',
        iteration: 1,
        generation: 7,
        bestFitness: 0.482,
        distance: 0.371,
        source: 'sound "x" 40ms pop\n',
        diversity: 0.2,
      }),
    ).toBe('⚙ generation 7 · distance 0.371');
    expect(
      describeEvent({ type: 'optimized', iteration: 1, distance: 0.03, initialDistance: 0.19, stopped: 'target' }),
    ).toBe('⚙ fitted slots: 0.190 → 0.030 (target)');
    /* Only the first line: the full repair message goes to the model, and echoing
       it would bury the shape of the run in the detail of one repair. */
    expect(describeEvent({ type: 'feedback', iteration: 1, message: 'first line\nsecond line' })).toBe(
      '↺ sent back: first line',
    );
    expect(describeEvent({ type: 'done', outcome: 'accepted', accepted: true })).toContain('accepted');
    expect(describeEvent({ type: 'done', outcome: 'refused', accepted: false })).toContain('stopped: refused');
  });
});
