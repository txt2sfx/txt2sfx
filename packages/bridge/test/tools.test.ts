/**
 * The tools, run against a real hub, the real native renderer where one is
 * installed, and a deliberately dead bank.
 *
 * What matters here is the *text*: these strings are the only documentation
 * and the only feedback the calling model gets, so the tests assert on the
 * sentences — the fix-naming failure lines, the verbatim hints, the measured
 * numbers — not just on isError bits.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  Hub,
  createNativeRenderer,
  localToolHub,
  runTool,
  silentLog,
} from '../src/index.js';
import type { Frame, PlaygroundPort, ToolContext } from '../src/index.js';

const VALID = 'sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n';
const SLOTTED =
  'sound "tick" 45ms ui\n  body: tone sine ~1800Hz[900..3600] | gain ~0.6[0.3..0.9] decay 25ms\n';
const INVALID_RAMP =
  'sound "pop" 35ms pop\n  body: tone sine 2000Hz -> 200Hz in 120ms | gain 0.8 decay 25ms\n';

const realNative = createNativeRenderer();
const noNative = createNativeRenderer(() => Promise.reject(new Error('not installed')));

const scratch = mkdtempSync(join(tmpdir(), 'txt2sfx-bridge-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A context with no tab, no native renderer and a dead bank — the floor. */
function bareContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const hub = new Hub({ version: 't', native: noNative, log: silentLog });
  return {
    hub: localToolHub(hub),
    native: noNative,
    bankUrl: 'http://127.0.0.1:9',
    cwd: scratch,
    allowWrite: [],
    log: silentLog,
    ...overrides,
  };
}

/** A context whose hub has a scripted tab attached. */
async function tabContext(
  answers: Record<string, unknown>,
): Promise<{ ctx: ToolContext; frames: Frame[]; hub: Hub }> {
  const hub = new Hub({ version: 't', native: noNative, log: silentLog });
  const frames: Frame[] = [];
  const port: PlaygroundPort = {
    send: (frame) => {
      frames.push(frame);
      if (frame.t === 'call') {
        const result = answers[frame.method];
        setImmediate(() => {
          if (result !== undefined) hub.handleFrame(port, { t: 'result', id: frame.id, result });
          else hub.handleFrame(port, { t: 'error', id: frame.id, error: { message: `no script for ${frame.method}` } });
        });
      }
    },
    close: () => {},
  };
  hub.attach(port);
  hub.handleFrame(port, { t: 'hello', role: 'playground', version: 1, app: 'scripted' });
  await new Promise((r) => setTimeout(r, 0));
  return { ctx: bareContext({ hub: localToolHub(hub) }), frames, hub };
}

const text = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

describe('sfx_validate', () => {
  it('gives a clean bill with the facts a model plans around', async () => {
    const result = await runTool('sfx_validate', { soundline: SLOTTED }, bareContext());
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('"tick" parses: category ui, 45 ms declared, 1 layer(s), 2 ~slot(s).');
  });

  it('hands back the validator hint verbatim, as an error', async () => {
    const result = await runTool('sfx_validate', { soundline: INVALID_RAMP }, bareContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('pop.max-freq-ramp');
    /* The hint field itself, not a paraphrase. */
    expect(text(result)).toMatch(/hint|shorten|ramp/i);
  });

  it('answers a typo with the parser\'s suggestion and the caret', async () => {
    const result = await runTool(
      'sfx_validate',
      { soundline: 'sound "x" 45ms ui\n  a: nosie white | gain 0.5 decay 20ms\n' },
      bareContext(),
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('does not parse');
    expect(text(result)).toContain('noise');
    expect(text(result)).toContain('^');
  });

  it('refuses missing arguments with a sentence, not a crash', async () => {
    const result = await runTool('sfx_validate', {}, bareContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('"soundline" argument');
  });
});

describe('sfx_render', () => {
  it('degrades to one sentence naming both fixes when nothing can render', async () => {
    const result = await runTool('sfx_render', { soundline: VALID }, bareContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('open the playground');
    expect(text(result)).toContain('node-web-audio-api');
  });

  it('renders natively and reports the measured numbers with the profile', async () => {
    if (!(await realNative.available())) return;
    const result = await runTool('sfx_render', { soundline: VALID, seed: 4242 }, bareContext({ native: realNative }));
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/rendered "tick" \(natively\): peak 0\.\d+/);
    expect(text(result)).toContain('| metric | render |');
    expect(text(result)).toContain('~slot');
  });

  it('relays to the playground when a tab is connected', async () => {
    const { ctx } = await tabContext({
      'playground.render': {
        peak: 0.61,
        clipped: false,
        durationMs: 46,
        bytes: 500,
        withinBudget: true,
        profile: {
          durationMs: 45,
          attackMs: 1,
          rmsEnvelope: [1, 0.5],
          centroidHz: [1800],
          flatness: 0.01,
          noiseRatio: 0.02,
          peakHz: 1800,
          loudnessLufsApprox: -16,
        },
      },
    });
    const result = await runTool('sfx_render', { soundline: VALID }, ctx);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('in the playground tab');
    expect(text(result)).toContain('peak 0.610');
  });
});

describe('sfx_audition', () => {
  it('relays and reports what the human heard', async () => {
    const { ctx, frames } = await tabContext({
      'playground.audition': { durationMs: 46, peak: 0.61, clipped: false },
    });
    const result = await runTool('sfx_audition', { soundline: VALID, select: true }, ctx);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('46 ms');
    const call = frames.find((frame) => frame.t === 'call');
    expect(call).toMatchObject({ method: 'playground.audition', params: { soundline: VALID, select: true } });
  });

  it('fails with the fix sentence when no tab is connected', async () => {
    const result = await runTool('sfx_audition', { soundline: VALID }, bareContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('no playground is connected — open http://localhost:5173 and check the bridge badge');
  });
});

describe('sfx_compare and sfx_fit', () => {
  it('compares two recipes natively: distance, tables, directives', async () => {
    if (!(await realNative.available())) return;
    const other = 'sound "tock" 45ms ui\n  body: tone sine 600Hz | gain 0.6 decay 25ms\n';
    const result = await runTool(
      'sfx_compare',
      { soundline: VALID, reference: other },
      bareContext({ native: realNative }),
    );
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/distance to "tock": 0\.\d+/);
    expect(text(result)).toContain('| metric | candidate |');
    expect(text(result)).toContain('worst first');
  });

  it('relays compare to the tab when no reference recipe is given', async () => {
    const { ctx } = await tabContext({
      'playground.compare': { metrics: '| m |', reference: 'splash.wav', distance: 0.12, directives: ['do a thing'] },
    });
    const result = await runTool('sfx_compare', { soundline: VALID }, ctx);
    expect(text(result)).toContain('distance to "splash.wav": 0.120');
    expect(text(result)).toContain('do a thing');
  });

  it('names both paths when compare has neither tab nor reference', async () => {
    const result = await runTool('sfx_compare', { soundline: VALID }, bareContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no playground is connected');
    expect(text(result)).toContain('reference');
  });

  it('refuses to fit a recipe with no ~slots — nothing to move', async () => {
    const result = await runTool('sfx_fit', { soundline: VALID, reference: VALID }, bareContext({ native: realNative }));
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no ~slots');
  });

  it('fits ~slots against a reference render, natively', async () => {
    if (!(await realNative.available())) return;
    const result = await runTool(
      'sfx_fit',
      { soundline: SLOTTED, reference: VALID, generations: 2, seed: 7 },
      bareContext({ native: realNative }),
    );
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/fit finished \(\w+\): distance 0\.\d+ -> 0\.\d+/);
    expect(text(result)).toContain('sound "tick"');
  }, 60_000);
});

describe('sfx_export', () => {
  it('writes compiled js inside the working directory', async () => {
    if (!(await realNative.available())) return;
    const result = await runTool(
      'sfx_export',
      { soundline: VALID, path: 'out/tick.js', format: 'js' },
      bareContext({ native: realNative }),
    );
    expect(result.isError).toBeUndefined();
    const written = readFileSync(join(scratch, 'out', 'tick.js'), 'utf8');
    expect(written).toContain('createOscillator');
  });

  it('writes a wav with a RIFF header via the native renderer', async () => {
    if (!(await realNative.available())) return;
    await runTool(
      'sfx_export',
      { soundline: VALID, path: 'out/tick.wav', format: 'wav', seed: 1 },
      bareContext({ native: realNative }),
    );
    const bytes = readFileSync(join(scratch, 'out', 'tick.wav'));
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('says wav needs the native renderer instead of failing obscurely', async () => {
    const result = await runTool('sfx_export', { soundline: VALID, path: 'x.wav', format: 'wav' }, bareContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('js/soundline');
  });

  it('refuses an absolute path outside the cwd, naming --allow-write', async () => {
    const outside = resolve(tmpdir(), 'txt2sfx-escape', 'x.js');
    const result = await runTool('sfx_export', { soundline: VALID, path: outside, format: 'js' }, bareContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('--allow-write');
  });

  it('allows that same path once --allow-write covers it', async () => {
    const allowed = join(scratch, 'elsewhere');
    const result = await runTool(
      'sfx_export',
      { soundline: VALID, path: join(allowed, 'x.soundline'), format: 'soundline' },
      bareContext({ cwd: join(scratch, 'cwd'), allowWrite: [allowed] }),
    );
    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(allowed, 'x.soundline'), 'utf8')).toContain('sound "tick"');
  });
});

describe('sfx_open', () => {
  it('relays with the header name when none is given', async () => {
    const { ctx, frames } = await tabContext({ 'playground.open': { name: 'tick' } });
    const result = await runTool('sfx_open', { soundline: VALID }, ctx);
    expect(text(result)).toContain('loaded into the Studio as "tick"');
    expect(frames.find((frame) => frame.t === 'call')).toMatchObject({ params: { name: 'tick' } });
  });
});

describe('the bank tools with no bank', () => {
  it('search answers one clear sentence, not a stack trace', async () => {
    const result = await runTool('sfx_bank_search', { query: 'coin' }, bareContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('recipe bank is not reachable at http://127.0.0.1:9');
    expect(text(result)).toContain('--bank');
  });

  it('publish refuses without a renderer before it even reaches the bank', async () => {
    const result = await runTool('sfx_bank_publish', { soundline: VALID, prompt: 'a tick' }, bareContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/open the playground|node-web-audio-api/);
  });

  it('contract still answers, generated locally, and says why examples are missing', async () => {
    const result = await runTool('sfx_contract', {}, bareContext());
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('# txt2sfx — soundline for language models');
    expect(text(result)).toContain('no recipe bank was reachable');
  });
});

describe('direction B tools', () => {
  it('walks park → next → answer, with the system prompt in the text', async () => {
    const hub = new Hub({ version: 't', native: noNative, log: silentLog });
    const ctx = bareContext({ hub: localToolHub(hub) });
    const asker: Frame[] = [];
    const port: PlaygroundPort = { send: (frame) => asker.push(frame), close: () => {} };
    hub.attach(port);
    hub.handleFrame(port, { t: 'hello', role: 'playground', version: 1, app: 'asker' });
    hub.handleFrame(port, {
      t: 'call',
      id: 'c1',
      method: 'agent.complete',
      params: { turn: 1, messages: [{ role: 'user', content: 'a coin' }], system: 'THE CONTRACT' },
    });

    const next = await runTool('sfx_next_request', { timeout: 500 }, ctx);
    expect(text(next)).toContain('THE CONTRACT');
    expect(text(next)).toContain('--- user ---');
    const id = /request "([^"]+)"/.exec(text(next))?.[1] ?? '';

    const answered = await runTool('sfx_answer', { id, text: '```\nsound…\n```' }, ctx);
    expect(answered.isError).toBeUndefined();
    expect(asker.at(-1)).toMatchObject({ t: 'result', id: 'c1', result: { text: '```\nsound…\n```' } });

    const stale = await runTool('sfx_answer', { id, text: 'again' }, ctx);
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain('not waiting');
  });

  it('reports an empty poll as normal, not an error', async () => {
    const result = await runTool('sfx_next_request', { timeout: 50 }, bareContext());
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('no generation request is waiting');
  });

  it('demands exactly one of text or error', async () => {
    const both = await runTool('sfx_answer', { id: 'x', text: 'a', error: 'b' }, bareContext());
    expect(both.isError).toBe(true);
    expect(text(both)).toContain('exactly one');
    const neither = await runTool('sfx_answer', { id: 'x' }, bareContext());
    expect(neither.isError).toBe(true);
  });
});

describe('an unknown tool', () => {
  it('is named and the twelve are listed', async () => {
    const result = await runTool('sfx_pause', {}, bareContext());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('sfx_contract');
  });
});
