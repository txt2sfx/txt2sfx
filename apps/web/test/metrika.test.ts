/**
 * What the counter injection ships, and the two ways it goes wrong silently.
 *
 * Both failures survive every other check in this repository — the page loads, the
 * types pass, the build succeeds — and are noticed weeks later, from the wrong end:
 *
 * 1. **It ships when nobody asked.** The default has to be *no counter*, or a fork's
 *    deployment and every `vite preview` report into this site's statistics.
 * 2. **It sends the fragment.** The stock snippet reports `location.href`, and this
 *    page's fragment carries a single-use OAuth code on the way back from GitHub or
 *    Freesound. The counter runs before React scrubs it, so a copy-paste of the
 *    snippet hands a live code to a third party and nothing anywhere says so.
 */

import { describe, expect, it } from 'vitest';
import { counterTags, metrika } from '../plugins/metrika.js';

/** The tag body of the first `<script>` the plugin would inject. */
function script(id: string): string {
  const tag = counterTags(id).find((candidate) => candidate.tag === 'script');
  return typeof tag?.children === 'string' ? tag.children : '';
}

describe('the Metrika counter', () => {
  it('injects nothing when no id is configured', () => {
    for (const value of [undefined, '', '   ']) {
      expect(metrika(value).transformIndexHtml, JSON.stringify(value)).toBeUndefined();
    }
  });

  /* A development server is somebody working on the playground, not a visitor. */
  it('never runs on the dev server', () => {
    expect(metrika('111424458').apply).toBe('build');
  });

  it('carries the tag id into both the script and the no-script pixel', () => {
    const tags = counterTags('111424458');
    expect(script('111424458')).toContain('tag.js?id=111424458');
    expect(script('111424458')).toContain("ym(111424458, 'init'");
    const noscript = tags.find((tag) => tag.tag === 'noscript');
    expect(noscript?.injectTo).toBe('body');
    expect(String(noscript?.children)).toContain('https://mc.yandex.ru/watch/111424458');
  });

  /* The deviation from the snippet Yandex hands out, pinned so a future paste of the
     original cannot quietly reinstate it. `plugins/metrika.ts` says why. */
  it('reports the address without its fragment', () => {
    const body = script('111424458');
    expect(body).toContain('url: location.origin + location.pathname + location.search');
    expect(body).not.toContain('location.href');
  });

  /* Recording the page would record the box people paste API keys into. */
  it('does not turn on webvisor', () => {
    expect(script('111424458')).not.toContain('webvisor');
  });

  /* The id is spliced into a `<script>` body, so a non-numeric value is a way to
     write JavaScript into the published page from an environment variable. Failing
     the build is the only outcome that cannot be mistaken for a working counter. */
  it('refuses an id that is not a tag id', () => {
    expect(() => metrika('1);alert(1)//')).toThrow(/digits only/);
    expect(() => metrika('id=111424458')).toThrow(/YANDEX_METRIKA_ID/);
  });
});
