/**
 * The prompt row's glue.
 *
 * The loop itself is covered in `packages/agent`; what is tested here is only what
 * the browser adds — the rule that decides who answers now that nobody picks, the key
 * going nowhere but the request, and the naming rule that stops a second run from
 * overwriting the first.
 *
 * Nothing here needs an audio stack, which is why `renderSignalFor` and
 * `targetFromBuffer` are not in this file: they are `AudioBuffer` plumbing, and a
 * fake `AudioBuffer` would test the fake.
 */

import { describe, expect, it } from 'vitest';
import { GEMINI_DEFAULT_MODEL, type FetchLike } from '@txt2sfx/agent';
import {
  captionProviderFor,
  chooseProvider,
  describeEvent,
  keyedProvider,
  providerFor,
  recipeName,
  type ProviderChoice,
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

/**
 * Who answers, now that the user is not asked.
 *
 * The whole reason this is one pure function is that five places read it — the button's
 * disabled state, the label beside it, the dialog's headline, the captioning step and
 * NeurosLoop's composer — and the day two of them disagree the interface is lying about
 * which model is about to be spent.
 */
describe('choosing a provider', () => {
  const choice = (apiKey = '', model = ''): ProviderChoice => ({ apiKey, model });

  /* The attached agent wins even with a key present, and it is not a close call: it is
     free, it is the strongest model in the room, and the user attached it on purpose. */
  it('prefers an attached agent over a pasted key', () => {
    expect(chooseProvider(choice('AIza-secret'), true)).toBe('agent');
    expect(providerFor(choice('AIza-secret'), true)?.name).toBe('agent');
  });

  it('falls back to Gemini when no agent is attached', () => {
    expect(chooseProvider(choice('AIza-secret'), false)).toBe('gemini');
    expect(providerFor(choice('AIza-secret'), false)?.name).toBe('gemini');
  });

  /* "Nobody can answer" is a state the interface reports before the button is pressed.
     Building a provider anyway would turn it into a failed run instead. */
  it('answers null with neither, rather than throwing on a blank key', () => {
    expect(chooseProvider(choice(), false)).toBeNull();
    expect(chooseProvider(choice('   '), false)).toBeNull();
    expect(providerFor(choice(), false)).toBeNull();
    expect(captionProviderFor(choice(), false)).toBeNull();
  });

  /* An agent attached to the *daemon*, not merely a daemon running: a request parked on
     a bridge nobody is holding waits for its timeout. */
  it('needs the agent actually attached', () => {
    expect(captionProviderFor(choice(), true)?.name).toBe('agent');
    expect(captionProviderFor(choice(), false)).toBeNull();
  });

  it('honours the model override the dialog carries', () => {
    expect(providerFor(choice('AIza-secret', 'gemini-3-flash'), false)?.model).toBe('gemini-3-flash');
  });
});

describe('the keyed provider', () => {
  it('sends a Gemini key in the header, never in the URL', async () => {
    const { fetch, seen } = capture({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    const provider = keyedProvider('AIza-secret', { fetch });
    await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });

    const call = seen[0];
    expect(call).toBeDefined();
    expect(call?.url).not.toContain('AIza-secret');
    expect((call?.init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-secret');
  });

  it('refuses a blank key before spending a round trip on a 401', () => {
    expect(() => keyedProvider('   ')).toThrow(/no API key/);
  });

  it('passes a model override through', async () => {
    const { fetch, seen } = capture({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    const provider = keyedProvider('key', { fetch, model: 'gemini-3-pro' });
    expect(provider.model).toBe('gemini-3-pro');
    await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });
    expect(seen[0]?.url).toContain('gemini-3-pro');
  });

  /* An empty box means "the provider's default" — not a request for a model named
     "", which would be a 404 the user cannot explain. And the placeholder promises what
     the request will do: vendors retire model ids — `gemini-2.5-flash` began answering
     404 for new keys — so a second copy of the id in the UI would eventually lie. */
  it('treats an empty model box as no override', () => {
    expect(keyedProvider('key', { model: '' }).model).toBe(GEMINI_DEFAULT_MODEL);
    expect(keyedProvider('key').model).toBe(GEMINI_DEFAULT_MODEL);
  });
});

describe('recipe naming', () => {
  const splash = 'sound "stone splash" 700ms impact\n  body: noise white | gain 0.6 decay 400ms\n';

  /* The model named the sound it built and chose the category it is judged against; both
     travel in the header. Filing it under a slug of the request threw that away. */
  it('takes the name out of the recipe the model wrote', () => {
    expect(recipeName(splash, 'большой камень плюхнулся в озеро', [])).toBe('stone-splash');
  });

  /**
   * The bug this fixes, stated as a test.
   *
   * `slug` keeps ASCII, so before the header was consulted every request written in a
   * non-Latin script produced the same name — a rail of `sound`, `sound-2`, `sound-3`
   * with nothing to tell them apart.
   */
  it('does not fall back to the prompt when the prompt has no Latin letters', () => {
    expect(recipeName(splash, 'лязг ржавой калитки', [])).not.toBe('sound');
  });

  it('slugs a prompt down to a file name when there is no recipe to read', () => {
    expect(recipeName('', 'A heavy metal door slamming shut in a corridor', [])).toBe('a-heavy-metal-door');
    expect(recipeName('', 'Coin pickup!', [])).toBe('coin-pickup');
  });

  /* A reply the parser rejects is never filed under a name anyway, so this only has to
     avoid throwing on the way to the fallback. */
  it('falls back to the prompt when the reply does not parse', () => {
    expect(recipeName('not a soundline at all', 'Coin pickup!', [])).toBe('coin-pickup');
  });

  it('falls back rather than producing an empty name', () => {
    expect(recipeName('', '!!! ???', [])).toBe('sound');
  });

  /* Two runs of "laser" are two candidates to compare; overwriting the first would
     throw away the comparison the user was in the middle of making. */
  it('never collides with a name already shown', () => {
    expect(recipeName('', 'laser', ['laser'])).toBe('laser-2');
    expect(recipeName('', 'laser', ['laser', 'laser-2'])).toBe('laser-3');
    expect(recipeName(splash, '', ['stone-splash'])).toBe('stone-splash-2');
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
