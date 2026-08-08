/**
 * The share card, and the two ways it breaks without anyone noticing.
 *
 * A preview is the one part of this application no developer ever looks at: it renders on
 * somebody else's server, into somebody else's timeline, days after the commit. Both
 * failures are silent to every other check in the repository — the page still loads, the
 * types still pass, the tests still pass — and the symptom is a link that unfurls as a
 * bare URL in a chat nobody involved is reading.
 *
 * 1. **`og:image` points at nothing.** It is an absolute URL, so no bundler resolves it
 *    and no build step fails; the path just has to match a file that actually ships from
 *    `public/`. Renaming that file is a one-word change with no visible consequence here.
 * 2. **The declared dimensions stop matching the image.** Scrapers lay out from
 *    `og:image:width`/`height` before the bytes arrive, so a card regenerated at another
 *    size renders letterboxed or cropped. The numbers are read out of the PNG's own IHDR
 *    rather than trusted, which is the same stance the rest of this repository takes
 *    about measured values.
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

const html = readFileSync(r('../index.html'), 'utf8');

/** The `content` of a `<meta>` by `property` or `name`, whichever it uses. */
function meta(key: string): string | undefined {
  const pattern = new RegExp(
    `<meta\\s+(?:property|name)="${key}"\\s+content="([^"]*)"|<meta\\s+(?:property|name)="${key}"\\s*\\n\\s*content="([^"]*)"`,
    'i',
  );
  const match = pattern.exec(html);
  return match?.[1] ?? match?.[2];
}

/** Width and height out of a PNG's IHDR — big-endian uint32 at offsets 16 and 20. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const SITE = 'https://txt2sfx.github.io/';

describe('the share card', () => {
  it('names an image that actually ships', () => {
    const url = meta('og:image');
    expect(url).toBeDefined();
    expect(url?.startsWith(SITE)).toBe(true);
    /* Whatever path the tag names, under `public/`, which Vite copies to the site root. */
    const file = r(`../public/${(url ?? '').slice(SITE.length)}`);
    expect(existsSync(file), `${url ?? ''} → ${file}`).toBe(true);
  });

  it('declares the dimensions the file actually has', () => {
    const url = meta('og:image') ?? '';
    const size = pngSize(r(`../public/${url.slice(SITE.length)}`));
    expect(String(size.width)).toBe(meta('og:image:width'));
    expect(String(size.height)).toBe(meta('og:image:height'));
    /* Twitter crops `summary_large_image` to 1.91:1. Anything outside a hair of that is
       a card losing its top and bottom in every timeline that shows it. */
    expect(size.width / size.height).toBeGreaterThan(1.85);
    expect(size.width / size.height).toBeLessThan(1.95);
  });

  /* An absolute `og:url` that disagrees with `canonical` is how a site ends up with two
     identities: one for scrapers, one for search. */
  it('points at one canonical address', () => {
    expect(meta('og:url')).toBe(SITE);
    expect(/<link rel="canonical" href="([^"]*)"/.exec(html)?.[1]).toBe(SITE);
  });

  it('carries the tags a preview needs at all', () => {
    for (const key of ['description', 'og:title', 'og:description', 'og:type', 'og:site_name']) {
      expect(meta(key)?.trim(), key).toBeTruthy();
    }
    expect(meta('twitter:card')).toBe('summary_large_image');
    /* Alt text on both, because the two are read by different consumers and a card with
       no alt text is an image screen readers announce as nothing. */
    expect(meta('og:image:alt')?.trim()).toBeTruthy();
    expect(meta('twitter:image:alt')?.trim()).toBeTruthy();
  });
});
