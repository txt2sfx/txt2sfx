/**
 * What the model is told.
 *
 * The prompt is generated, so these tests are about the two properties generation
 * is supposed to buy: it cannot drift from the tables the parser uses, and the
 * toolchain's own error text reaches the model unaltered. Plus the one editorial
 * decision worth pinning — the message that asks for a structural change says why
 * the numbers are not the problem.
 */

import { describe, expect, it } from 'vitest';
import { EFFECT_NAMES, PRIMITIVE_NAMES, parse, validate } from '@txt2sfx/core';
import { initialMessage, repairMessage, selectFewShot, systemPrompt } from '../src/index.js';
import { PLACEHOLDER_PROFILE, loadExample, storedRecipe } from './helpers/fixtures.js';

const COIN = storedRecipe({ name: 'coin', soundline: loadExample('coin'), prompt: 'coin pickup, arcade' });
const HELICOPTER = storedRecipe({ name: 'helicopter', soundline: loadExample('helicopter') });

describe('systemPrompt', () => {
  it('carries the whole grammar, generated from the signature tables', () => {
    const prompt = systemPrompt();
    for (const name of PRIMITIVE_NAMES) expect(prompt).toContain(`\`${name}.`);
    for (const name of EFFECT_NAMES) expect(prompt).toContain(`\`${name}.`);
    expect(prompt).toContain('Signal order is');
  });

  it('embeds the examples it is given, with the prompt each one answers', () => {
    const prompt = systemPrompt({ examples: selectFewShot([COIN]).examples });
    expect(prompt).toContain('**coin** — asked for as *"coin pickup, arcade"*');
    expect(prompt).toContain(COIN.soundline.trimEnd());
  });

  /* The degraded path: nothing clean to show, so the flaw is named rather than
     handed over silently. */
  it('warns about a flawed example and names the rule it breaks', () => {
    const prompt = systemPrompt({ examples: selectFewShot([HELICOPTER]).examples });
    expect(prompt).toContain('Careful with the examples above');
    expect(prompt).toContain('**helicopter** breaks duration.contract');
  });

  it('says nothing about flaws when every example is clean', () => {
    expect(systemPrompt({ examples: selectFewShot([COIN]).examples })).not.toContain(
      'Careful with the examples',
    );
  });

  it('always states the reply format, since extraction depends on it', () => {
    expect(systemPrompt()).toContain('exactly one fenced code block');
  });

  it('accepts a contract fetched from a bank instead of the generated one', () => {
    const prompt = systemPrompt({ contract: '# borrowed contract' });
    expect(prompt).toContain('# borrowed contract');
    expect(prompt).not.toContain('## Sources');
    /* The reply rules are ours either way — they describe this loop, not the bank. */
    expect(prompt).toContain('exactly one fenced code block');
  });
});

describe('initialMessage', () => {
  it('quotes the request and nothing else when there is no reference sound', () => {
    const message = initialMessage('  coin pickup sound  ');
    expect(message).toContain('<request>\ncoin pickup sound\n</request>');
    expect(message).not.toContain('measured');
  });

  it('hands over the target measurements when there is a reference', () => {
    const message = initialMessage('bubble pop', { target: PLACEHOLDER_PROFILE });
    expect(message).toContain('has been measured');
    expect(message).toContain('dominant partial, Hz | 836');
  });
});

describe('repairMessage', () => {
  it('passes the parser\'s own line and column through', () => {
    const message = repairMessage({ kind: 'parse-error', detail: 'line 2, col 9: unknown primitive' });
    expect(message).toContain('line 2, col 9: unknown primitive');
    expect(message).toContain('one fenced block');
  });

  it('passes the validator\'s rule ids and hints through verbatim', () => {
    const issues = validate(
      parse('sound "pop" 35ms pop\n  body: tone sine 2000Hz -> 200Hz in 120ms | gain 0.9 decay 30ms\n'),
    );
    const message = repairMessage({ kind: 'invalid', issues });
    expect(message).toContain('pop.max-freq-ramp');
    expect(message).toContain(issues[0]?.hint ?? '???');
    /* The category is the contract the model chose; changing it is not a fix. */
    expect(message).toContain('not the category');
  });

  it('explains that render facts are measured, not derived', () => {
    const message = repairMessage({
      kind: 'render',
      issues: [
        {
          severity: 'error',
          layer: null,
          rule: 'peak.max',
          got: 'peak 1.100',
          expected: '<= 0.95',
          hint: 'Lower the loudest layer.',
        },
      ],
    });
    expect(message).toContain('peak.max');
    expect(message).toContain('measured');
  });

  /* The hard rule, in the one message that invokes it. */
  it('asks for a structural change only in the stalled message, and says why', () => {
    const message = repairMessage({
      kind: 'stalled',
      distance: 0.42,
      targetDistance: 0.2,
      directives: ['dominant partial 300Hz vs 1.8kHz — raise the source frequency'],
    });
    expect(message).toContain('0.420');
    expect(message).toContain('0.200');
    expect(message).toContain('the structure is what has to');
    expect(message).toContain('1. dominant partial 300Hz vs 1.8kHz');
  });

  it('tells a model that sent no block what a block looks like', () => {
    expect(repairMessage({ kind: 'no-soundline' })).toContain('sound "<name>"');
  });
});
