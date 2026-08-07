/**
 * All logging goes through here, and here writes to stderr.
 *
 * In `--stdio` mode stdout **is** the protocol: an MCP client reads it as
 * newline-delimited JSON-RPC, and one stray "listening…" printed to stdout
 * corrupts the stream — the client dies with a parse error pointing at our
 * greeting. That failure is invisible in every test that does not run the real
 * binary against a real client, so the guard is structural rather than
 * disciplinary: this module is the only sanctioned way to say anything, it
 * cannot write to stdout, and a test greps the package for bare `console.log`
 * calls.
 *
 * @packageDocumentation
 */

/** The shape every module takes as its logger. */
export type Log = (line: string) => void;

/** Write one line to stderr. Never stdout — see the module note. */
export function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** A logger that says nothing — for tests that assert on behaviour, not chatter. */
export const silentLog: Log = () => {};
