/**
 * The master knobs, held to the promise anchoring makes.
 *
 * The transforms themselves are `packages/core`'s and are tested there. What is tested
 * here is the property that replaced the jog: a position is *absolute*. Centre is the
 * recipe as it was anchored, whatever route the knobs took to get where they are, and
 * putting one back in the middle has to give the original numbers back byte for byte —
 * an undo that lands one rounding step away is not an undo.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { parse, serialize } from '@txt2sfx/core';
import {
  MASTER_CENTER,
  MASTER_REST,
  anchorMasters,
  atRest,
  formatRatio,
  moveMaster,
  positionToRatio,
  ratioToPosition,
} from '../src/lib/master.js';

const SOURCE = [
  '# a comment that must survive',
  'sound "bubble pop" 55ms pop',
  '  body: tone tri ~700Hz[500..1400] -> 1120Hz in 14ms >> lp ~2200Hz[900..4000] Q1 | gain 0.8 hold 3ms decay 38ms',
  '  edge: click 1ms >> bp ~2800Hz[1200..6000] Q1 | gain 0.38 attack 0ms decay 6ms',
  '',
].join('\n');

/** Neither layer carries `lp` or `hp`, so brightness has to insert one. */
const NO_FILTER = 'sound "hiss" 200ms foley\n  air: noise white | gain 0.4 attack 20ms decay 180ms\n';

const UP = ratioToPosition(2);
const DOWN = ratioToPosition(0.5);

describe('an anchored master', () => {
  it('starts on the text it was given, with nothing turned', () => {
    const anchor = anchorMasters(SOURCE);
    expect(anchor.base).toBe(SOURCE);
    expect(anchor.source).toBe(SOURCE);
    expect(atRest(anchor.positions)).toBe(true);
  });

  it('gives the recipe back unchanged when a knob returns to the middle', () => {
    const anchor = anchorMasters(SOURCE);
    const down = moveMaster(anchor, 'pitch', DOWN);
    expect(down.source).not.toBe(SOURCE);
    expect(moveMaster(down, 'pitch', MASTER_CENTER).source).toBe(SOURCE);
  });

  /* The jog could not do this: two drags were `round(round(base × a) × b)`, so the way
     back was never quite the way out. */
  it('depends on where the knob is, not on how it got there', () => {
    const anchor = anchorMasters(SOURCE);
    const direct = moveMaster(anchor, 'pitch', UP);
    const wandered = moveMaster(
      moveMaster(moveMaster(anchor, 'pitch', DOWN), 'pitch', 0.31), 'pitch', UP,
    );
    expect(wandered.source).toBe(direct.source);
  });

  it('composes the three in a fixed order, whichever was moved last', () => {
    const anchor = anchorMasters(SOURCE);
    const pitchFirst = moveMaster(moveMaster(anchor, 'pitch', UP), 'length', DOWN);
    const lengthFirst = moveMaster(moveMaster(anchor, 'length', DOWN), 'pitch', UP);
    expect(pitchFirst.source).toBe(lengthFirst.source);
    expect(pitchFirst.positions).toEqual(lengthFirst.positions);
  });

  /* `scaleBrightness(source, 1)` is not the identity — it inserts an `lp` into a layer
     that has none — so a brightness knob sitting in the middle must be skipped rather
     than applied, or moving *any* other master would edit the filter chain. */
  it('leaves a filterless recipe filterless while another master moves', () => {
    const moved = moveMaster(anchorMasters(NO_FILTER), 'length', UP);
    expect(moved.source).not.toContain('lp ');
    expect(moved.source).toContain('400ms');

    const darker = moveMaster(moved, 'brightness', DOWN);
    expect(darker.source).toContain('lp ');
    /* And out again: the insertion is undone by the position, not by an undo stack. */
    expect(moveMaster(darker, 'brightness', MASTER_CENTER).source).toBe(moved.source);
  });

  it('carries the text its positions produce, so a foreign edit is one comparison away', () => {
    const moved = moveMaster(anchorMasters(SOURCE), 'pitch', UP);
    expect(moved.source).toBe(moveMaster(anchorMasters(moved.base), 'pitch', UP).source);
    expect(moved.base).toBe(SOURCE);
  });

  it('keeps the result canonical and still parsing', () => {
    const moved = moveMaster(moveMaster(anchorMasters(SOURCE), 'pitch', UP), 'brightness', DOWN);
    expect(serialize(parse(moved.source))).toBe(moved.source);
    expect(moved.source).toContain('# a comment that must survive');
  });

  /* Text the editor is mid-keystroke on has no transform to apply and no exception to
     throw: the recipe card is already showing the parse error. */
  it('returns the text as written when it does not parse', () => {
    const broken = 'sound "s" 40ms pop\n  a: tone\n';
    expect(moveMaster(anchorMasters(broken), 'pitch', UP).source).toBe(broken);
  });
});

describe('the travel', () => {
  it('is centred on ×1 and symmetric in the ratio', () => {
    expect(positionToRatio(MASTER_CENTER)).toBe(1);
    expect(positionToRatio(0) * positionToRatio(1)).toBeCloseTo(1, 12);
    expect(ratioToPosition(positionToRatio(0.83))).toBeCloseTo(0.83, 12);
  });

  it('reads out as a multiplier, without trailing zeros', () => {
    expect(formatRatio(MASTER_CENTER)).toBe('×1');
    expect(formatRatio(ratioToPosition(2))).toBe('×2');
    expect(formatRatio(ratioToPosition(0.5))).toBe('×0.5');
    expect(formatRatio(0)).toBe('×0.25');
    expect(formatRatio(1)).toBe('×4');
  });

  it('agrees with the rest positions the app starts from', () => {
    expect(atRest(MASTER_REST)).toBe(true);
    expect(atRest({ ...MASTER_REST, pitch: UP })).toBe(false);
  });
});
