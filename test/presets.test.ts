/**
 * The contract of `presets/`, as far as it can be settled from the text.
 *
 * Everything here is derivable without an audio stack: canonical form, validation,
 * the metadata markers, the category, and the manifest. What is left — peak,
 * clipping, near-silence — is measured by the seeder, which renders every preset
 * and refuses a clipping one under `--strict`. Splitting it that way keeps this
 * file fast enough to run on every change; `presets/README.md` states both halves.
 *
 * The manifest is written out rather than counted. A count catches a preset that
 * disappeared; a list also catches one that was renamed, which is the failure that
 * breaks a link somebody has already shared.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SOUND_CATEGORIES, CATEGORY_LIMITS } from '@txt2sfx/shared';
import { parse, recipeMeta, serialize, validate } from '@txt2sfx/core';

const PRESETS_DIR = fileURLToPath(new URL('../presets', import.meta.url));

/** Every preset the repository ships, in the order the plan listed them. */
const MANIFEST: readonly string[] = [
  'ui-hover',
  'ui-confirm',
  'ui-error',
  'ui-toggle-on',
  'ui-toggle-off',
  'ui-typewriter-key',
  'pickup-gem',
  'pickup-heart',
  'pickup-key',
  'pickup-ammo',
  'levelup-fanfare',
  'laser-pistol',
  'laser-rifle',
  'laser-charge',
  'plasma-bolt',
  'beam-burst',
  'zap-electric',
  'impact-metal-clang',
  'impact-wood-thud',
  'impact-stone-crack',
  'punch-body',
  'explosion-small',
  'explosion-distant',
  'explosion-firework',
  'footstep-wood',
  'footstep-snow',
  'footstep-water',
  'cloth-rustle',
  'paper-flip',
  'chest-open',
  'lock-click',
  'whoosh-fast',
  'whoosh-deep',
  'whoosh-transition',
  'dash-whoosh',
  'arrow-flyby',
  'jump-8bit',
  'jump-soft',
  'trampoline-boing',
  'land-thump',
  'land-heavy',
  'notify-ping',
  'notify-double',
  'alarm-beep',
  'alarm-klaxon',
  'engine-idle',
  'wind-loop',
  'rain-loop',
  'machine-hum',
  'campfire-loop',
];

interface Preset {
  readonly name: string;
  readonly source: string;
}

const presets: readonly Preset[] = readdirSync(PRESETS_DIR)
  .filter((file) => file.endsWith('.soundline'))
  .sort()
  .map((file) => ({
    name: file.replace(/\.soundline$/, ''),
    /* Read as bytes-on-disk with CRLF folded away, the same way the seeder and the
       playground's glob see it. `.gitattributes` forces LF for exactly this reason;
       folding here means a checkout that got it wrong fails somewhere useful. */
    source: readFileSync(join(PRESETS_DIR, file), 'utf8').replace(/\r\n/g, '\n'),
  }));

describe('the preset catalog', () => {
  it('contains exactly the recipes the manifest names', () => {
    expect(presets.map((preset) => preset.name)).toEqual([...MANIFEST].sort());
  });

  it('does not shadow a name in examples/', () => {
    const examples = readdirSync(fileURLToPath(new URL('../examples', import.meta.url)))
      .filter((file) => file.endsWith('.soundline'))
      .map((file) => file.replace(/\.soundline$/, ''));
    /* Two entries with one name select the same editor buffer and differ only in a
       badge, and the catalog resolves the collision by dropping one silently. */
    for (const preset of presets) expect(examples, preset.name).not.toContain(preset.name);
  });
});

describe.each(presets)('$name', ({ name, source }) => {
  const ast = parse(source);

  it('is written in canonical form', () => {
    expect(serialize(ast)).toBe(source);
  });

  it('validates without a single issue', () => {
    /* Stricter than `examples/`, where `helicopter` carries a documented error: a
       preset is the first sound a new user hears, and a catalog that ships with a
       warning attached teaches the wrong thing about what the validator is for. */
    expect(validate(ast).map((issue) => `${issue.severity} ${issue.rule}`), name).toEqual([]);
  });

  it('declares a prompt and at least two tags', () => {
    const meta = recipeMeta(ast);
    expect(meta.prompt).not.toBeNull();
    expect((meta.prompt ?? '').trim().length).toBeGreaterThan(0);
    expect(meta.tags.length).toBeGreaterThanOrEqual(2);
  });

  it('claims a category the validator knows, and carries `loop` when it needs one', () => {
    expect(SOUND_CATEGORIES).toContain(ast.category);
    /* `validate` reports a missing flag too, so this is redundant by design: the
       loop flag is the one header field whose absence changes what the sound *is*
       rather than how loud it is, and a redundant assertion names it in the failure
       output instead of leaving it inside a list of rule ids. */
    if (CATEGORY_LIMITS[ast.category].requiresLoop) expect(ast.loop).toBe(true);
  });

  it('leaves at least two numbers for the optimizer to search', () => {
    /* A preset with no slots gives the studio's sliders and its Fit button nothing
       to do, which is most of what the playground is for without a key. */
    const slots = [...source.matchAll(/~[\d.]+/g)].length;
    expect(slots).toBeGreaterThanOrEqual(2);
  });
});
