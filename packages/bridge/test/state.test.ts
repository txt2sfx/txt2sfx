/**
 * The token file: created tight, kept across restarts, and never silently
 * replaced — a re-minted token strands every paired tab with no visible cause.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureState, loadState, newToken, saveState, stateFilePath } from '../src/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'txt2sfx-state-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the token', () => {
  it('is 32 random bytes of hex, fresh every time', () => {
    const one = newToken();
    const two = newToken();
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(one).not.toBe(two);
  });
});

describe('the state file', () => {
  it('does not exist until someone opens the port', () => {
    expect(loadState(join(scratch, 'never'))).toBeUndefined();
  });

  it('round-trips, and keeps mode 600 where modes mean anything', () => {
    const dir = join(scratch, 'a');
    const state = { token: newToken(), port: 4455 };
    const path = saveState(state, dir);
    expect(path).toBe(stateFilePath(dir));
    expect(loadState(dir)).toEqual(state);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps an existing token across restarts — pairing survives the daemon', () => {
    const dir = join(scratch, 'b');
    const first = ensureState(4455, dir);
    saveState(first, dir);
    const second = ensureState(5000, dir);
    expect(second.token).toBe(first.token);
    expect(second.port).toBe(5000);
  });

  it('throws on a mangled file instead of minting a new token over it', () => {
    const dir = join(scratch, 'c');
    saveState({ token: newToken(), port: 4455 }, dir);
    writeFileSync(stateFilePath(dir), '{"tokn": "typo"}');
    expect(() => loadState(dir)).toThrow('does not look like bridge state');
    /* And the broken file is left in place for the human to inspect. */
    expect(readFileSync(stateFilePath(dir), 'utf8')).toContain('tokn');
  });
});
