/**
 * `~/.txt2sfx/bridge.json` — the token and the port, written by whichever
 * process opened the port.
 *
 * The file exists because the two local participants have no other rendezvous:
 * the MCP process and the daemon may be different invocations hours apart, and
 * the token that guards the socket has to reach both without ever crossing the
 * network. A file under the home directory is the same trust boundary as SSH
 * keys and the npm token — any process running as the user can read it, and
 * pretending otherwise would be theatre (see the threat-model section of
 * `docs/BRIDGE.md`).
 *
 * Mode 600 anyway: on POSIX it keeps other *users* out, which is real; on
 * Windows `chmod` narrows nothing (ACLs govern) and the call is a harmless
 * no-op, so there is no platform branch to get wrong.
 *
 * @packageDocumentation
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** What the file holds. Nothing else goes in — it is read by other tools. */
export interface BridgeState {
  readonly token: string;
  readonly port: number;
}

/** Where the state lives. Overridable for tests, never for users. */
export function stateDir(dir?: string): string {
  return dir ?? join(homedir(), '.txt2sfx');
}

/** Full path of the state file. */
export function stateFilePath(dir?: string): string {
  return join(stateDir(dir), 'bridge.json');
}

/** A fresh token: 32 random bytes, hex. Never derived, never reused across files. */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Read the state, or `undefined` when there is none.
 *
 * A malformed file *throws* rather than being treated as absent: silently
 * minting a new token over a file the user may have hand-edited would strand
 * every already-paired playground with a token that no longer opens anything,
 * and the symptom (tabs failing to connect) points nowhere near the cause.
 */
export function loadState(dir?: string): BridgeState | undefined {
  const path = stateFilePath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed['token'] !== 'string' || typeof parsed['port'] !== 'number') {
    throw new Error(`${path} does not look like bridge state — delete it and restart the bridge`);
  }
  return { token: parsed['token'], port: parsed['port'] };
}

/** Write the state, creating the directory, and tighten the mode either way. */
export function saveState(state: BridgeState, dir?: string): string {
  const directory = stateDir(dir);
  mkdirSync(directory, { recursive: true });
  const path = stateFilePath(dir);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  /* `writeFileSync`'s mode only applies on creation; a file that existed with a
     looser mode keeps it. Tightening explicitly costs one call and removes the
     one order-of-operations way to end up world-readable. */
  chmodSync(path, 0o600);
  return path;
}

/**
 * The token to serve, keeping an existing one.
 *
 * Restarting the daemon must not invalidate every paired tab: the token is a
 * pairing secret, not a session, so it survives restarts and changes only when
 * the user deletes the file.
 */
export function ensureState(port: number, dir?: string): BridgeState {
  const existing = loadState(dir);
  return { token: existing?.token ?? newToken(), port };
}

/** File mode as `600`-style text, or a note on Windows where ACLs govern. */
export function describeMode(path: string): string {
  const mode = (statSync(path).mode & 0o777).toString(8);
  return process.platform === 'win32' ? `mode ${mode} (advisory on Windows — ACLs govern)` : `mode ${mode}`;
}
