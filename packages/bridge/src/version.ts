/**
 * The bridge's own version, as a constant.
 *
 * The bundle is one file with no `package.json` beside it — `npx` puts it
 * wherever it pleases — so reading the version from disk at runtime would work
 * in the repository and fail exactly where users run it. A constant cannot
 * drift silently either: a test compares it against `package.json`.
 *
 * @packageDocumentation
 */

/** Must match `package.json`. Checked by `test/hygiene.test.ts`. */
export const VERSION = '0.4.0';
