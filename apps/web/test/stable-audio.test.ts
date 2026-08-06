/**
 * The Stable Audio bridge, both halves.
 *
 * What is worth testing here is the boundary, not the model: an argv built from an
 * untrusted body (the endpoint spawns a process with it), the line splitter that
 * has to cope with tqdm's carriage returns, and the one line by which the child
 * names the bytes it just streamed. Everything else is a 1.7 GB download and twenty
 * seconds of CPU, which is not a unit test.
 */

import { describe, expect, it } from 'vitest';
import { parseResult, renderArgs, splitLines } from '../plugins/stable-audio.js';
import { parseEvent } from '../src/lib/stable-audio.js';

describe('renderArgs', () => {
  it('passes the prompt as one argument and streams the result', () => {
    expect(renderArgs({ prompt: '  glass bottle shattering  ' })).toEqual([
      'glass bottle shattering',
      '--stdout',
    ]);
  });

  /* `--stdout` is the whole reason a click leaves nothing in out/. Losing it would
     not fail loudly — it would quietly go back to filling a directory. */
  it('always asks for the audio on stdout', () => {
    expect(renderArgs({ prompt: 'thud', seconds: 2 })).toContain('--stdout');
  });

  it('forwards the knobs the panel offers', () => {
    expect(renderArgs({ prompt: 'coin pickup', seconds: 2.5, steps: 16, seed: 42 })).toEqual([
      'coin pickup',
      '--stdout',
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
    expect(renderArgs({ prompt: 'thud', seconds: '', steps: null, seed: undefined })).toEqual([
      'thud',
      '--stdout',
    ]);
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
      '--stdout',
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

describe('parseResult', () => {
  it('reads the name and media type run.py reports for its stdout', () => {
    expect(
      parseResult('txt2sfx-result {"name":"thud-42.mp3","mime":"audio/mpeg","bytes":131072,"seed":42}'),
    ).toEqual({ name: 'thud-42.mp3', mime: 'audio/mpeg', bytes: 131072 });
  });

  it('leaves every other line alone', () => {
    expect(parseResult('loaded in 10.1s on cpu')).toBeNull();
    expect(parseResult('txt2sfx-result not json')).toBeNull();
  });

  /* The name becomes a File name and the mime goes to `decodeAudioData`. Neither is
     attacker-controlled here, but both come off a pipe, and a plausible-looking line
     is exactly what would make a bad one hard to spot. */
  it('refuses a name or a type it would not have written itself', () => {
    expect(parseResult('txt2sfx-result {"name":"../x.mp3","mime":"audio/mpeg"}')).toBeNull();
    expect(parseResult('txt2sfx-result {"name":"x.exe","mime":"audio/mpeg"}')).toBeNull();
    expect(parseResult('txt2sfx-result {"name":"x.mp3","mime":"text/html"}')).toBeNull();
    expect(parseResult('txt2sfx-result {"mime":"audio/mpeg"}')).toBeNull();
  });
});

describe('parseEvent', () => {
  it('reads the events the endpoint emits', () => {
    expect(parseEvent('{"type":"done","name":"a-1.mp3","mime":"audio/mpeg","bytes":9,"ms":12000,"audio":"AAA="}')).toEqual({
      type: 'done',
      name: 'a-1.mp3',
      mime: 'audio/mpeg',
      bytes: 9,
      ms: 12000,
      audio: 'AAA=',
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
