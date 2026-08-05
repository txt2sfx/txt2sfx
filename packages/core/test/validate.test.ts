/**
 * Validator tests.
 *
 * Two kinds of case: the reference recipes, which are the standard the rules are
 * calibrated against, and hand-written violations, one per rule. The second kind
 * matters more — a rule that never fires is indistinguishable from a rule that
 * does not exist.
 */

import { describe, expect, it } from 'vitest';
import type { ValidationIssue } from '@txt2sfx/shared';
import { CATEGORY_LIMITS } from '@txt2sfx/shared';
import { formatIssue, formatIssues, hasErrors, parse, validate, validateRender } from '../src/index.js';
import { loadExamples } from './helpers/audio.js';

/** Validate a soundline written inline. */
const check = (source: string): ValidationIssue[] => validate(parse(source));

/** Rule ids reported for a source. */
const rules = (source: string): string[] => check(source).map((issue) => issue.rule);

/** A minimal valid pop, used as the base for single-rule violations. */
const POP = 'sound "pop" 35ms pop\n  body: tone sine 900Hz | gain 0.8 decay 25ms\n';

/** Source text of one reference recipe. */
const source = (examples: readonly { name: string; source: string }[], name: string): string =>
  examples.find((e) => e.name === name)?.source ?? '';

describe('reference recipes', () => {
  const examples = loadExamples();

  /**
   * Eight of the ten are clean; the two that are not are pinned below rather
   * than tolerated silently. `helicopter` is the case the plan predicted the
   * validator would catch, and `sword-clash` turned up with it.
   */
  const KNOWN: Readonly<Record<string, readonly string[]>> = {
    helicopter: ['duration.contract'],
    'sword-clash': ['duration.contract'],
  };

  it.each(examples.map((e) => [e.name, e] as const))('%s reports only known issues', (name, example) => {
    expect(validate(example.ast).map((issue) => issue.rule)).toEqual(KNOWN[name] ?? []);
  });

  /**
   * A 90 ms delay at 0.88 feedback rings for about 4 s behind a header claiming
   * 1.5 — and for a `loop` sound the declared duration *is* the loop period, so
   * looping this recipe gives a 4 s cycle, not the 1.5 s it advertises. The
   * recipe cannot be brought into contract by editing the header either: 4046 ms
   * is past `cycle`'s own 3000 ms ceiling. Only the DSP can fix it, which is a
   * sound-design decision, so the finding is recorded instead of papered over.
   */
  it('calls helicopter an error: 170 % over is not tail-estimate slack', () => {
    const issue = validate(parse(source(examples, 'helicopter'))).find((i) => i.rule === 'duration.contract');
    expect(issue?.severity).toBe('error');
    expect(issue?.got).toContain('4046ms');
    expect(issue?.layer).toBe('chop');
  });

  /** A 220 ms reverb tail on a 600 ms decay under a 700 ms header: 17 % over. */
  it('calls sword-clash a warning: inside the graded band', () => {
    const issue = validate(parse(source(examples, 'sword-clash'))).find((i) => i.rule === 'duration.contract');
    expect(issue?.severity).toBe('warn');
    expect(issue?.layer).toBe('blade');
  });
});

describe('category duration', () => {
  it('rejects a pop longer than the category allows', () => {
    const issues = check('sound "pop" 400ms pop\n  body: tone sine 900Hz | gain 0.8 decay 30ms\n');
    expect(issues.map((i) => i.rule)).toContain('pop.max-duration');
    expect(issues.find((i) => i.rule === 'pop.max-duration')?.got).toBe('400ms');
  });

  it('rejects a ui sound too short to register', () => {
    expect(rules('sound "tick" 12ms ui\n  body: click 1ms | gain 0.8 attack 0ms decay 8ms\n')).toContain(
      'ui.min-duration',
    );
  });

  it('accepts a duration at the exact boundary', () => {
    expect(rules(`sound "pop" ${CATEGORY_LIMITS.pop.maxDurationMs}ms pop\n  body: tone sine 900Hz | gain 0.8 decay 25ms\n`)).toEqual(
      [],
    );
  });
});

describe('duration contract', () => {
  it('catches a sound that outlives its header', () => {
    const issues = check('sound "hit" 200ms impact\n  body: tone sine 200Hz | gain 0.8 decay 900ms\n');
    const contract = issues.find((i) => i.rule === 'duration.contract');
    expect(contract?.severity).toBe('error');
    expect(contract?.layer).toBe('body');
    expect(contract?.hint).toContain('901ms');
  });

  it('counts effect tails, which is what makes them catchable', () => {
    const withoutTail = rules('sound "hit" 700ms impact\n  body: tone sine 200Hz | gain 0.8 decay 600ms\n');
    const withTail = rules(
      'sound "hit" 700ms impact\n  body: tone sine 200Hz >> verb 900ms mix 0.4 | gain 0.8 decay 600ms\n',
    );
    expect(withoutTail).not.toContain('duration.contract');
    expect(withTail).toContain('duration.contract');
  });

  it('tolerates an overrun inside the tail estimate error', () => {
    /* 1 ms of default attack pushing a 500 ms decay past a 500 ms header. */
    expect(rules('sound "hit" 500ms impact\n  body: tone sine 200Hz | gain 0.8 decay 500ms\n')).toEqual([]);
  });
});

describe('anti-pew: frequency ramps', () => {
  /**
   * The plan's mandatory case: a 120 ms downward sweep dressed as a pop. This is
   * the mistake a model makes most often, and the one the category exists for.
   */
  it('catches a laser wearing a pop label', () => {
    const issues = check('sound "pop" 35ms pop\n  body: tone sine 2000Hz -> 200Hz in 120ms | gain 0.8 decay 25ms\n');
    const ramp = issues.find((i) => i.rule === 'pop.max-freq-ramp');
    expect(ramp).toBeDefined();
    expect(ramp?.severity).toBe('error');
    expect(ramp?.got).toContain('120ms');
    expect(ramp?.expected).toBe('<= 20ms');
    expect(ramp?.loc?.line).toBe(2);
  });

  it('counts filter sweeps too — a gliding band-pass sings just as much', () => {
    expect(
      rules('sound "pop" 55ms pop\n  body: noise white >> bp 3000Hz -> 600Hz in 50ms | gain 0.8 decay 25ms\n'),
    ).toContain('pop.max-freq-ramp');
  });

  it('allows the same ramp in a category built for sweeps', () => {
    expect(
      rules('sound "zap" 180ms laser\n  body: chirp saw 2000Hz -> 200Hz in 120ms | gain 0.8 decay 150ms\n'),
    ).not.toContain('laser.max-freq-ramp');
  });

  it('ignores ramps on parameters that are not frequencies', () => {
    expect(
      rules('sound "bell" 400ms pickup\n  body: fm 1200Hz index 6 -> 0.5 in 300ms | gain 0.4 decay 350ms\n'),
    ).toEqual([]);
  });
});

describe('layer decay and layer count', () => {
  it('rejects a layer whose decay outlasts the category', () => {
    const issues = check('sound "pop" 55ms pop\n  body: tone sine 900Hz | gain 0.8 decay 50ms\n');
    expect(issues.map((i) => i.rule)).toContain('pop.max-layer-decay');
  });

  it('rejects more layers than the category budget', () => {
    const layers = Array.from({ length: 5 }, (_, i) => `  l${i}: tone sine ${400 + i * 100}Hz | gain 0.1 decay 20ms`);
    const issues = check(`sound "pop" 35ms pop\n${layers.join('\n')}\n`);
    const count = issues.find((i) => i.rule === 'pop.max-layers');
    expect(count?.got).toBe('5 layers');
    expect(count?.expected).toBe('<= 4 for pop');
  });
});

describe('loop flag', () => {
  it('requires loop on a cycle sound', () => {
    const issues = check('sound "hum" 800ms cycle\n  body: tone sine 120Hz | gain 0.4 decay 800ms\n');
    expect(issues.map((i) => i.rule)).toContain('cycle.requires-loop');
  });

  it('is satisfied when the flag is there', () => {
    expect(
      rules('sound "hum" 800ms cycle loop\n  body: tone sine 120Hz | gain 0.4 decay 790ms\n'),
    ).not.toContain('cycle.requires-loop');
  });
});

describe('envelope against its source', () => {
  /**
   * The most expensive silent failure found so far: the layer renders about
   * -41 dB with nothing in the parser or renderer objecting.
   */
  it('catches an attack longer than the impulse it shapes', () => {
    const issues = check('sound "tick" 40ms ui\n  edge: click 0.3ms | gain 0.9 decay 20ms\n');
    const issue = issues.find((i) => i.rule === 'envelope.attack-longer-than-voice');
    expect(issue?.severity).toBe('error');
    expect(issue?.got).toBe('attack 1ms over a 0.3ms click');
    expect(issue?.hint).toContain('attack 0ms');
  });

  it('warns when the attack eats more than half the impulse', () => {
    const issues = check('sound "tick" 40ms ui\n  edge: click 2ms | gain 0.9 attack 1.5ms decay 20ms\n');
    expect(issues.find((i) => i.rule === 'envelope.attack-longer-than-voice')?.severity).toBe('warn');
  });

  it('says nothing when the click is given no attack ramp', () => {
    expect(rules('sound "tick" 40ms ui\n  edge: click 0.3ms | gain 0.9 attack 0ms decay 20ms\n')).toEqual([]);
  });

  it('does not apply to sources that sustain', () => {
    expect(rules('sound "pad" 400ms misc\n  body: tone sine 400Hz | gain 0.5 attack 200ms decay 200ms\n')).toEqual([]);
  });
});

describe('numeric ranges', () => {
  it('rejects a value past a parameter bound', () => {
    const issues = check('sound "pop" 35ms pop\n  body: tone sine 19000Hz | gain 0.8 decay 25ms\n');
    const range = issues.find((i) => i.rule === 'param.range');
    expect(range?.got).toBe('tone freq 19kHz');
    expect(range?.expected).toBe('<= 18kHz');
  });

  it('checks ramp targets, not only the starting value', () => {
    expect(
      rules('sound "zap" 180ms laser\n  body: sub 90Hz -> 8Hz in 100ms | gain 0.5 decay 150ms\n'),
    ).toContain('param.range');
  });

  it('warns when a slot reaches outside the parameter it annotates', () => {
    const issues = check('sound "zap" 180ms laser\n  body: sub ~90Hz[20..400] | gain 0.5 decay 150ms\n');
    const slot = issues.find((i) => i.rule === 'param.slot-range');
    expect(slot?.severity).toBe('warn');
    expect(slot?.expected).toContain('18Hz');
  });

  it('accepts a slot inside the bounds', () => {
    expect(rules('sound "zap" 180ms laser\n  body: sub ~90Hz[40..180] | gain 0.5 decay 150ms\n')).toEqual([]);
  });
});

describe('exponential ramps to zero', () => {
  it('warns and explains the clamp', () => {
    const issues = check('sound "zap" 180ms laser\n  body: chirp saw 2000Hz -> 0Hz in 100ms | gain 0.5 decay 150ms\n');
    const issue = issues.find((i) => i.rule === 'ramp.exp-to-zero');
    expect(issue?.severity).toBe('warn');
    expect(issue?.hint).toContain('-60 dB');
  });

  it('says nothing about a linear ramp to zero, which is legal', () => {
    expect(
      rules('sound "zap" 180ms laser\n  body: chirp saw 2000Hz -> lin 0Hz in 100ms | gain 0.5 decay 150ms\n'),
    ).toEqual([]);
  });

  /**
   * `-> 0` is a supported way to write "down to nothing" and must not also be
   * reported as a bounds violation — one intent, one message.
   */
  it('does not double-report a zero target as out of range', () => {
    expect(
      rules('sound "zap" 180ms laser\n  body: chirp saw 2000Hz -> 0Hz in 100ms | gain 0.5 decay 150ms\n'),
    ).toEqual(['ramp.exp-to-zero']);
  });
});

describe('rising resonance in a pop', () => {
  /** Minnaert: a collapsing cavity's resonance climbs as it shrinks. */
  it('warns about a falling sweep', () => {
    const issues = check('sound "pop" 35ms pop\n  body: tone sine 480Hz -> 80Hz in 12ms | gain 0.9 decay 25ms\n');
    const issue = issues.find((i) => i.rule === 'pop.rising-resonance');
    expect(issue?.severity).toBe('warn');
    expect(issue?.got).toContain('480Hz -> 80Hz');
  });

  it('is quiet about a rising sweep', () => {
    expect(rules('sound "pop" 35ms pop\n  body: tone sine 700Hz -> 1120Hz in 12ms | gain 0.9 decay 25ms\n')).toEqual(
      [],
    );
  });

  it('only applies to pops', () => {
    expect(
      rules('sound "zap" 180ms laser\n  body: chirp saw 2000Hz -> 200Hz in 120ms | gain 0.5 decay 150ms\n'),
    ).not.toContain('pop.rising-resonance');
  });
});

describe('render-only invariants', () => {
  it('reports clipping with the gain reduction needed', () => {
    const issues = validateRender({ peak: 1.34 });
    const peak = issues.find((i) => i.rule === 'peak.max');
    expect(peak?.severity).toBe('error');
    expect(peak?.hint).toContain('3.0 dB');
  });

  it('reports a render that is effectively silent', () => {
    const issues = validateRender({ peak: 0.004 });
    expect(issues.map((i) => i.rule)).toEqual(['peak.silent']);
  });

  it('is silent on a healthy peak', () => {
    expect(validateRender({ peak: 0.82 })).toEqual([]);
  });
});

describe('reporting', () => {
  it('formats one issue as a single line the model can act on', () => {
    const issues = check('sound "pop" 35ms pop\n  body: tone sine 2000Hz -> 200Hz in 120ms | gain 0.8 decay 25ms\n');
    const line = formatIssue(issues[0] as ValidationIssue);
    expect(line).toMatch(/^line \d+, col \d+: \[error] pop\./);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('joins issues one per line', () => {
    const issues = check('sound "pop" 400ms pop\n  body: tone sine 2000Hz -> 200Hz in 120ms | gain 0.8 decay 90ms\n');
    expect(issues.length).toBeGreaterThan(1);
    expect(formatIssues(issues).split('\n')).toHaveLength(issues.length);
  });

  it('separates blocking from advisory', () => {
    expect(hasErrors(check(POP))).toBe(false);
    expect(hasErrors(check('sound "pop" 400ms pop\n  body: tone sine 900Hz | gain 0.8 decay 30ms\n'))).toBe(true);
    expect(
      hasErrors(check('sound "pop" 35ms pop\n  body: tone sine 480Hz -> 80Hz in 12ms | gain 0.9 decay 25ms\n')),
    ).toBe(false);
  });
});
