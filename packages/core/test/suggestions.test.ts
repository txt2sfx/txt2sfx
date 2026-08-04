import { describe, expect, it } from 'vitest';
import { EFFECT_NAMES, PRIMITIVE_NAMES, didYouMean, parseWithDiagnostics } from '../src/index.js';

/**
 * Suggestions are not cosmetic: each one that lands saves the agent loop an
 * iteration, so the predictable wrong names get their own test.
 */
describe('did-you-mean', () => {
  it('maps common wrong effect names onto soundline spelling', () => {
    expect(didYouMean('lowpass', EFFECT_NAMES)).toBe('lp');
    expect(didYouMean('highpass', EFFECT_NAMES)).toBe('hp');
    expect(didYouMean('reverb', EFFECT_NAMES)).toBe('verb');
    expect(didYouMean('distortion', EFFECT_NAMES)).toBe('dist');
    expect(didYouMean('echo', EFFECT_NAMES)).toBe('delay');
  });

  it('maps common wrong primitive names', () => {
    expect(didYouMean('oscillator', PRIMITIVE_NAMES)).toBe('tone');
    expect(didYouMean('sweep', PRIMITIVE_NAMES)).toBe('chirp');
    expect(didYouMean('karplus', PRIMITIVE_NAMES)).toBe('pluck');
    expect(didYouMean('impulse', PRIMITIVE_NAMES)).toBe('click');
  });

  it('still falls back to edit distance for typos', () => {
    expect(didYouMean('nosie', PRIMITIVE_NAMES)).toBe('noise');
    expect(didYouMean('decy', ['gain', 'attack', 'decay'])).toBe('decay');
  });

  it('offers nothing when nothing is close', () => {
    expect(didYouMean('helicopter', PRIMITIVE_NAMES)).toBeUndefined();
  });

  it('does not suggest a word that is not a candidate here', () => {
    // `drive` maps to `dist`, but `dist` is not a parameter of `delay`.
    expect(didYouMean('drive', ['feedback', 'mix'])).toBeUndefined();
  });

  it('reaches the parser diagnostics', () => {
    const { errors } = parseWithDiagnostics(
      'sound "s" 100ms ui\n  a: noise white >> reverb 200ms | volume 0.5 decay 20ms\n',
    );
    expect(errors[0]?.hint).toMatch(/did you mean 'verb'/);
  });
});
