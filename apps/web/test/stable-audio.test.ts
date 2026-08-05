/**
 * The Stable Audio bridge, both halves.
 *
 * What is worth testing here is the boundary, not the model: an argv built from an
 * untrusted body (the endpoint spawns a process with it), the line splitter that
 * has to cope with tqdm's carriage returns, and the rule for deciding which file a
 * finished run produced. Everything else is a 1.7 GB download and twenty seconds
 * of CPU, which is not a unit test.
 */

import { describe, expect, it } from 'vitest';
import { pickRender, renderArgs, splitLines, type RenderFile } from '../plugins/stable-audio.js';
import { parseEvent } from '../src/lib/stable-audio.js';

const file = (name: string, modifiedMs: number): RenderFile => ({ file: name, bytes: 1024, modifiedMs });

describe('renderArgs', () => {
  it('passes the prompt as one argument and nothing else by default', () => {
    expect(renderArgs({ prompt: '  glass bottle shattering  ' })).toEqual(['glass bottle shattering']);
  });

  it('forwards the knobs the panel offers', () => {
    expect(renderArgs({ prompt: 'coin pickup', seconds: 2.5, steps: 16, seed: 42 })).toEqual([
      'coin pickup',
      '--seconds',
      '2.5',
      '--steps',
      '16',
      '--seed',
      '42',
    ]);
  });

  /* An empty field in the form is "leave it to run.py", not "zero". */
  it('treats empty and absent values as the preset default', () => {
    expect(renderArgs({ prompt: 'thud', seconds: '', steps: null, seed: undefined })).toEqual(['thud']);
  });

  it('refuses a run it cannot describe', () => {
    expect(() => renderArgs({})).toThrow(/prompt/);
    expect(() => renderArgs({ prompt: '   ' })).toThrow(/prompt/);
    expect(() => renderArgs({ prompt: 'x'.repeat(500) })).toThrow(/longer/);
    expect(() => renderArgs({ prompt: 'a\nb' })).toThrow(/control/);
  });

  /* The ceilings are the point: `--steps 1e9` is a hang somebody has to notice and
     kill, and a hang started from a browser tab is the worst kind. */
  it('bounds every number rather than passing it through', () => {
    expect(() => renderArgs({ prompt: 'x', steps: 1e9 })).toThrow(/steps/);
    expect(() => renderArgs({ prompt: 'x', seconds: 400 })).toThrow(/seconds/);
    expect(() => renderArgs({ prompt: 'x', seconds: 0 })).toThrow(/seconds/);
    expect(() => renderArgs({ prompt: 'x', seed: -1 })).toThrow(/seed/);
    expect(() => renderArgs({ prompt: 'x', seconds: 'soon' })).toThrow(/seconds/);
  });

  it('only accepts the presets run.py knows', () => {
    expect(renderArgs({ prompt: 'x', model: 'sfx3' })).toContain('sfx3');
    expect(() => renderArgs({ prompt: 'x', model: 'huge' })).toThrow(/model/);
  });

  /* The repo is how a machine reaches the checkpoint it actually has cached, and
     it is also the one field that could smuggle a flag or a path into the argv. */
  it('accepts a repo id and nothing shaped like a path or a flag', () => {
    expect(renderArgs({ prompt: 'x', repo: 'joeriben/stable-audio-open-small' })).toEqual([
      'x',
      '--repo',
      'joeriben/stable-audio-open-small',
    ]);
    expect(() => renderArgs({ prompt: 'x', repo: '--cpu' })).toThrow(/repo/);
    expect(() => renderArgs({ prompt: 'x', repo: '../../etc/passwd' })).toThrow(/repo/);
    expect(() => renderArgs({ prompt: 'x', repo: 'no-owner' })).toThrow(/repo/);
  });
});

describe('splitLines', () => {
  it('holds back a partial line for the next chunk', () => {
    const first = splitLines('loaded in 10.1s\nsampl', '');
    expect(first.lines).toEqual(['loaded in 10.1s']);
    expect(splitLines('ed in 8.1s\n', first.carry).lines).toEqual(['sampled in 8.1s']);
  });

  /* tqdm redraws its bar with a carriage return. Treating that as "no line yet"
     means the progress arrives in one lump after the step it was reporting ended. */
  it('treats a carriage return as a line', () => {
    expect(splitLines('12%|#\r50%|#####\r', '').lines).toEqual(['12%|#', '50%|#####']);
    expect(splitLines('a\r\nb\r\n', '').lines).toEqual(['a', 'b']);
  });
});

describe('pickRender', () => {
  it('takes the file the run added', () => {
    const before = new Set(['old.wav']);
    const after = [file('old.wav', 1000), file('new-42.wav', 5000)];
    expect(pickRender(before, after, 4000)).toBe('new-42.wav');
  });

  it('takes the newest when a run adds more than one', () => {
    const after = [file('a-1.wav', 5000), file('a-2.wav', 6000)];
    expect(pickRender(new Set(), after, 4000)).toBe('a-2.wav');
  });

  /* Same prompt and same seed overwrite the same filename, so nothing is "added" —
     but the run did produce audio, and refusing to find it would be a lie. */
  it('falls back to a file the run rewrote in place', () => {
    const before = new Set(['thud-7.wav']);
    expect(pickRender(before, [file('thud-7.wav', 9000)], 8000)).toBe('thud-7.wav');
  });

  it('reports nothing when the run wrote nothing', () => {
    const before = new Set(['thud-7.wav']);
    expect(pickRender(before, [file('thud-7.wav', 1000)], 8000)).toBeNull();
  });
});

describe('parseEvent', () => {
  it('reads the events the endpoint emits', () => {
    expect(parseEvent('{"type":"done","file":"a-1.wav","ms":12000}')).toEqual({
      type: 'done',
      file: 'a-1.wav',
      ms: 12000,
    });
    expect(parseEvent('  ')).toBeNull();
  });

  /* The far end is a Python process. The one time it writes something unexpected
     is exactly the time you want to see it, so it becomes a log line. */
  it('shows unparseable output instead of dropping it', () => {
    expect(parseEvent('Traceback (most recent call last):')).toEqual({
      type: 'log',
      line: 'Traceback (most recent call last):',
    });
  });
});
