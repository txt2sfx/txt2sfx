/**
 * The loop, driven by a scripted model.
 *
 * Real parser, real validator, real renderer, real optimizer — only the model is
 * fake, and it is fake in the interesting way: each test scripts a specific
 * failure and asserts both that the loop recovered and that what went back to the
 * model was actionable. The second half matters more. A loop that recovers because
 * the next scripted reply happened to be right proves nothing; a loop that hands
 * the model the rule id it broke is the thing being built.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SoundAST } from '@txt2sfx/shared';
import { generateSound, httpBank, mockProvider, staticBank } from '../src/index.js';
import type { AgentEvent } from '../src/index.js';
import { fenced, loadExample, renderSignal, storedRecipe, targetFrom } from './helpers/fixtures.js';

const UI_CLICK = loadExample('ui-click');
const BUBBLE_POP = loadExample('bubble-pop');

/** The same recipe with every slot pushed to the wrong end of its range. */
const BUBBLE_POP_DISPLACED = BUBBLE_POP.replace('~700Hz[500..1400]', '~510Hz[500..1400]')
  .replace('~2200Hz[900..4000]', '~950Hz[900..4000]')
  .replace('~2800Hz[1200..6000]', '~1250Hz[1200..6000]');

/** The last thing said to the model. */
function lastUserMessage(provider: { requests: readonly { messages: readonly { role: string; content: string }[] }[] }): string {
  const messages = provider.requests.at(-1)?.messages ?? [];
  return messages.at(-1)?.content ?? '';
}

describe('generateSound — the happy path', () => {
  it('accepts a valid, audible recipe on the first attempt', async () => {
    const provider = mockProvider({ replies: [fenced(UI_CLICK)] });
    const result = await generateSound({ prompt: 'crisp ui click', provider, render: renderSignal });

    expect(result.accepted).toBe(true);
    expect(result.outcome).toBe('accepted');
    expect(result.soundline).toBe(UI_CLICK);
    expect(result.ast?.name).toBe('ui click');
    expect(result.attempts).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
  });

  it('sends the contract and the retrieved examples in the system prompt', async () => {
    const provider = mockProvider({ replies: [fenced(UI_CLICK)] });
    const bank = staticBank([storedRecipe({ name: 'coin', soundline: loadExample('coin') })]);
    await generateSound({ prompt: 'coin pickup', provider, render: renderSignal, bank });

    const system = provider.requests[0]?.system ?? '';
    expect(system).toContain('soundline for language models');
    expect(system).toContain('**coin** — asked for as');
  });

  /* The review's warning, at the level that matters: the loop must not feed the
     agent an example the same pipeline would refuse. */
  it('never shows the model a bank recipe that fails validation', async () => {
    const provider = mockProvider({ replies: [fenced(UI_CLICK)] });
    const bank = staticBank([
      storedRecipe({ name: 'helicopter', soundline: loadExample('helicopter') }),
      storedRecipe({ name: 'coin', soundline: loadExample('coin') }),
    ]);
    const result = await generateSound({ prompt: 'rotor loop', provider, render: renderSignal, bank });

    expect(result.examples.map((example) => example.recipe.name)).toEqual(['coin']);
    expect(provider.requests[0]?.system).not.toContain('**helicopter**');
  });

  /* Legitimate for a caller with no audio context, and worth pinning because the
     two invariants that need a render are exactly the ones skipped. */
  it('stops at text validation when no renderer is supplied', async () => {
    const provider = mockProvider({ replies: [fenced(UI_CLICK)] });
    const result = await generateSound({ prompt: 'click', provider });
    expect(result.accepted).toBe(true);
  });
});

describe('generateSound — repair', () => {
  it('sends a parse error back with the line and column, then accepts the fix', async () => {
    const broken = 'sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 dcay 25ms\n';
    const provider = mockProvider({ replies: [fenced(broken), fenced(UI_CLICK)] });
    const result = await generateSound({ prompt: 'ui click', provider, render: renderSignal });

    expect(result.accepted).toBe(true);
    expect(result.attempts[0]?.outcome).toBe('parse-error');
    expect(result.attempts[0]?.feedback).toMatch(/line \d+, col \d+/);
    /* The repair message is what the second call actually saw. */
    expect(lastUserMessage(provider)).toContain('does not parse');
  });

  it('sends validator issues back with their rule ids, then accepts the fix', async () => {
    /* The plan's mandatory case: a "pew" wearing a pop's category. */
    const piu = 'sound "pop" 35ms pop\n  body: tone sine 2000Hz -> 200Hz in 120ms | gain 0.9 decay 30ms\n';
    const provider = mockProvider({ replies: [fenced(piu), fenced(UI_CLICK)] });
    const result = await generateSound({ prompt: 'bubble pop', provider, render: renderSignal });

    expect(result.accepted).toBe(true);
    expect(result.attempts[0]?.outcome).toBe('invalid');
    expect(result.attempts[0]?.feedback).toContain('pop.max-freq-ramp');
    expect(result.attempts[0]?.issues.some((issue) => issue.rule === 'pop.max-freq-ramp')).toBe(true);
  });

  /* Clipping is measured, not derived: two layers at 0.9 each are legal on paper
     and 1.8 in the buffer. */
  it('catches a clipping render and reports the peak rule', async () => {
    const loud =
      'sound "loud" 45ms ui\n  a: tone sine 1800Hz | gain 0.9 decay 25ms\n  b: tone sine 1810Hz | gain 0.9 decay 25ms\n';
    const provider = mockProvider({ replies: [fenced(loud), fenced(UI_CLICK)] });
    const result = await generateSound({ prompt: 'ui click', provider, render: renderSignal });

    expect(result.attempts[0]?.outcome).toBe('render');
    expect(result.attempts[0]?.feedback).toContain('peak.max');
    expect(result.accepted).toBe(true);
  });

  it('asks for a block when the reply had a fence but no recipe', async () => {
    const provider = mockProvider({ replies: ['```js\nplay(ctx, 0);\n```', fenced(UI_CLICK)] });
    const result = await generateSound({ prompt: 'ui click', provider, render: renderSignal });

    expect(result.attempts[0]?.outcome).toBe('no-soundline');
    expect(result.accepted).toBe(true);
  });

  it('gives up after the iteration budget and reports what it reached', async () => {
    const broken = 'sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 dcay 25ms\n';
    const provider = mockProvider({ replies: [fenced(broken), fenced(broken)] });
    const result = await generateSound({
      prompt: 'ui click',
      provider,
      render: renderSignal,
      maxIterations: 2,
    });

    expect(result.accepted).toBe(false);
    expect(result.outcome).toBe('parse-error');
    expect(result.attempts).toHaveLength(2);
    expect(provider.requests).toHaveLength(2);
  });

  /* A recipe that only warns is accepted: spending an iteration on a warning the
     agent loop is allowed to ignore buys nothing, and the warning still surfaces. */
  it('accepts a recipe that carries warnings and passes them on', async () => {
    const swordClash = loadExample('sword-clash');
    const provider = mockProvider({ replies: [fenced(swordClash)] });
    const result = await generateSound({ prompt: 'swords', provider, render: renderSignal });

    expect(result.accepted).toBe(true);
    expect(result.issues.some((issue) => issue.severity === 'warn')).toBe(true);
    expect(result.issues.every((issue) => issue.severity !== 'error')).toBe(true);
  });
});

describe('generateSound — a refusal is an answer', () => {
  it('stops at a prose reply instead of demanding a recipe', async () => {
    const refusal =
      'Procedural synthesis is weak at organic sound; a believable human voice is not something this toolchain can make.';
    const provider = mockProvider({ replies: [refusal] });
    const result = await generateSound({ prompt: 'a woman saying hello', provider, render: renderSignal });

    expect(result.outcome).toBe('refused');
    expect(result.accepted).toBe(false);
    expect(result.message).toBe(refusal);
    /* One call: pushing back would produce exactly the disappointing sound the
       contract tells the model to decline. */
    expect(provider.requests).toHaveLength(1);
  });
});

describe('generateSound — with a target', () => {
  it('fits the slots and accepts when the distance comes down', async () => {
    const target = await targetFrom(BUBBLE_POP);
    const provider = mockProvider({ replies: [fenced(BUBBLE_POP_DISPLACED)] });

    const result = await generateSound({
      prompt: 'bubble wrap pop',
      provider,
      render: renderSignal,
      target,
      /* Tighter than the default 0.2 so the assertion means something: the
         displaced recipe already renders at ~0.09, and a threshold above that
         would pass without the optimizer doing anything. */
      targetDistance: 0.05,
      optimizer: { generations: 24, populationSize: 12, seed: 7 },
    });

    expect(result.accepted).toBe(true);
    expect(result.distance).toBeLessThanOrEqual(0.05);
    expect(result.distance ?? 1).toBeLessThan(result.initialDistance ?? 0);
    /* The returned recipe is the fitted one, and it is still a recipe. */
    expect(result.soundline).toContain('sound "bubble pop"');
    expect(provider.requests).toHaveLength(1);
  }, 60_000);

  /**
   * The hard rule from the plan: a structural change is requested only when the
   * numbers cannot help. A recipe with no `~` slots is that case in its purest
   * form — there is nothing to fit, so the distance it renders at is what this
   * structure gives.
   */
  it('asks for a new structure only when the numbers cannot help, and says so', async () => {
    const target = await targetFrom(BUBBLE_POP);
    /* `ui-click` has no slots and is nothing like a bubble pop. */
    const provider = mockProvider({ replies: [fenced(UI_CLICK), fenced(BUBBLE_POP)] });
    const events: AgentEvent[] = [];

    const result = await generateSound({
      prompt: 'bubble wrap pop',
      provider,
      render: renderSignal,
      target,
      maxIterations: 2,
      optimizer: { generations: 12, populationSize: 8, seed: 3 },
      onEvent: (event) => events.push(event),
    });

    const feedback = result.attempts[0]?.feedback ?? '';
    expect(feedback).toMatch(/stopped\s+improving/);
    expect(feedback).toContain('the structure is what has to');
    /* The directives come from the analyzer, not from prose written here. */
    expect(feedback).toMatch(/1\. \w/);
    expect(events.some((event) => event.type === 'optimized')).toBe(true);
    expect(result.attempts).toHaveLength(2);
  }, 60_000);

  /**
   * The other side of the same rule. When the search was still improving and only
   * ran out of generations, the loop reports the distance instead of asking for a
   * rewrite — a new topology would throw away a search that was working.
   */
  it('does not ask for a rewrite when the optimizer was still improving', async () => {
    const target = await targetFrom(BUBBLE_POP);
    const provider = mockProvider({ replies: [fenced(BUBBLE_POP_DISPLACED)] });

    const result = await generateSound({
      prompt: 'bubble wrap pop',
      provider,
      render: renderSignal,
      target,
      /* A budget too small to reach the target, and a stall threshold it cannot
         hit inside that budget. */
      targetDistance: 0.0001,
      optimizer: { generations: 3, populationSize: 6, seed: 5, stallGenerations: 50 },
    });

    expect(result.accepted).toBe(false);
    expect(result.outcome).toBe('distance');
    expect(result.distance).toBeGreaterThan(0.0001);
    /* One model call: the model was never asked to fix a search problem. */
    expect(provider.requests).toHaveLength(1);
  }, 60_000);

  /**
   * Cancelling a run has to reach the search, and has to keep what it found.
   *
   * The signal used to be handed to the provider and nowhere else, so a cancelled
   * run went quiet while the optimizer carried on rendering a population per
   * generation — and the recipe it had reached was thrown away on the way out. Both
   * halves are the same bug from the user's side: pressing Stop cost them the machine
   * *and* the wait they had just decided to cut short.
   */
  it('stops the fit when the caller aborts, and keeps the best recipe it reached', async () => {
    /* A click as the target for a bubble pop: no slot value makes this recipe that
       sound, so the search cannot finish early and the abort is what ends the run. */
    const target = await targetFrom(UI_CLICK);
    const provider = mockProvider({ replies: [fenced(BUBBLE_POP_DISPLACED), fenced(BUBBLE_POP)] });
    const controller = new AbortController();

    const result = await generateSound({
      prompt: 'bubble wrap pop',
      provider,
      render: renderSignal,
      target,
      maxIterations: 2,
      targetDistance: 0.0001,
      /* 500 generations authorised, one spent. The stall window is left wide so the
         only thing that can stop this run is the signal. */
      optimizer: { generations: 500, populationSize: 8, seed: 5, stallGenerations: 200 },
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'generation' && event.generation === 1) controller.abort();
      },
    });

    expect(result.outcome).toBe('distance');
    /* The recipe survives the cancellation, fitted as far as the search got. */
    expect(result.soundline).toContain('sound "bubble pop"');
    expect(result.distance).toBeDefined();
    /* And the model is not asked for a redesign on the strength of a search nobody
       finished measuring — spending the user's next turn on work they just cancelled
       is the other half of what Stop is for. */
    expect(provider.requests).toHaveLength(1);
  }, 60_000);

  it('reports the leader of each generation as a playable recipe', async () => {
    const target = await targetFrom(BUBBLE_POP);
    const provider = mockProvider({ replies: [fenced(BUBBLE_POP_DISPLACED)] });
    const generations: { source: string; distance: number }[] = [];

    await generateSound({
      prompt: 'bubble wrap pop',
      provider,
      render: renderSignal,
      target,
      targetDistance: 0.0001,
      optimizer: { generations: 3, populationSize: 6, seed: 5, stallGenerations: 50, anchor: 0.25 },
      onEvent: (event) => {
        if (event.type === 'generation') generations.push({ source: event.source, distance: event.distance });
      },
    });

    expect(generations).toHaveLength(3);
    /* A UI watching a fit needs something to render and play, not a number: the
       failure worth catching mid-search is a candidate that scores better and sounds
       like a different sound, and that is invisible in the number. */
    for (const generation of generations) {
      expect(generation.source).toContain('sound "bubble pop"');
      expect(generation.distance).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe('generateSound — plumbing', () => {
  it('reports progress in order, for a UI that shows the loop working', async () => {
    const events: AgentEvent[] = [];
    const provider = mockProvider({ replies: [fenced(UI_CLICK)] });
    await generateSound({
      prompt: 'click',
      provider,
      render: renderSignal,
      onEvent: (event) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual([
      'request',
      'reply',
      'rendered',
      'validated',
      'done',
    ]);
  });

  /* Examples are an improvement to the prompt, not a premise for it: the contract
     document is generated locally and the loop can run with no bank at all. */
  it('runs without examples when the bank is unreachable', async () => {
    const bank = httpBank('http://127.0.0.1:1', { fetch: () => Promise.reject(new TypeError('fetch failed')) });
    await expect(bank.retrieve('click', 3)).resolves.toEqual({ recipes: [], fallback: false });

    const provider = mockProvider({ replies: [fenced(UI_CLICK)] });
    const result = await generateSound({ prompt: 'click', provider, render: renderSignal, bank });
    expect(result.accepted).toBe(true);
    expect(result.examples).toEqual([]);
  });

  it('reads a bank response and passes the fallback flag through', async () => {
    const coin = storedRecipe({ name: 'coin', soundline: loadExample('coin') });
    const bank = httpBank('http://bank.test/', {
      fetch: (url) => {
        expect(url).toBe('http://bank.test/api/retrieve?prompt=coin%20pickup&k=2');
        return Promise.resolve(
          new Response(JSON.stringify({ recipes: [coin, { junk: true }], fallback: true })),
        );
      },
    });
    const result = await bank.retrieve('coin pickup', 2);
    /* A malformed entry is dropped rather than handed to a prompt. */
    expect(result.recipes.map((recipe) => recipe.name)).toEqual(['coin']);
    expect(result.fallback).toBe(true);
  });

  it('passes the injected renderer through and calls it once per candidate', async () => {
    const render = vi.fn(async (ast: SoundAST) => renderSignal(ast));
    const provider = mockProvider({ replies: [fenced(UI_CLICK)] });
    await generateSound({ prompt: 'click', provider, render });
    expect(render).toHaveBeenCalledTimes(1);
  });
});
