/**
 * The Yandex.Metrika counter, injected at build time and only when an id is given.
 *
 * ## Why an injection rather than four lines in `index.html`
 *
 * `index.html` is what a contributor runs, what a fork publishes and what
 * `test/head.test.ts` reads. A counter written there would report every `pnpm dev`
 * session, every fork's deployment and every offline demo into *this* site's
 * statistics, and the only way out would be editing the file. Read from the
 * environment instead, the default is no counter at all and the id exists in exactly
 * one place — the publish step, which passes `YANDEX_METRIKA_ID` to `pnpm build:web`.
 *
 * `apply: 'build'` for the same reason: a development server is somebody working on
 * the playground, not a visitor, and the statistics should not have to be read around
 * that. To see the counter locally, build with the variable set and `vite preview`.
 *
 * ## The one deviation from the snippet Metrika hands out
 *
 * `url` is `location.origin + location.pathname + location.search` — the address
 * *without* its fragment, where the stock snippet sends `location.href`.
 *
 * This page's fragment is not decoration. It carries a single-use OAuth code on the
 * way back from GitHub or Freesound, which `lib/account.ts` and `lib/freesound-auth.ts`
 * both scrub out of the address bar before doing anything else with it, and a whole
 * shared recipe otherwise. The counter runs from `<head>`, before React mounts and
 * therefore before that scrub, so `location.href` would hand a live code to a third
 * party in the one window where it is still worth something. Nothing is lost by
 * dropping it: the playground is a single page whose screens never touch the address
 * bar, so every hit would report the same path either way.
 *
 * Webvisor is deliberately not enabled — it records the page, including what a visitor
 * types, and this page has a text box people paste API keys into.
 *
 * @packageDocumentation
 */

import type { HtmlTagDescriptor, Plugin } from 'vite';

/**
 * A Metrika tag id as Metrika issues them: digits, nothing else.
 *
 * The check is about the character set rather than the length — ids are sequential and
 * have grown from four digits to nine over the years, so a bound would reject somebody
 * else's valid counter. The value is spliced into the body of a `<script>`, and every
 * non-digit is a way to write JavaScript into the published page from an environment
 * variable.
 */
const ID_RE = /^[0-9]+$/;

/**
 * The counter, as the two tags it is made of.
 *
 * Exported so a test can read what would ship without running a build.
 *
 * @param id Numeric tag id, already validated.
 */
export function counterTags(id: string): HtmlTagDescriptor[] {
  return [
    {
      tag: 'script',
      injectTo: 'head',
      children: `(function(m,e,t,r,i,k,a){
    m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
    m[i].l=1*new Date();
    for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
    k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)
})(window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=${id}', 'ym');

ym(${id}, 'init', {ssr:true, clickmap:true, ecommerce:"dataLayer", referrer: document.referrer, url: location.origin + location.pathname + location.search, accurateTrackBounce:true, trackLinks:true});`,
    },
    {
      tag: 'noscript',
      injectTo: 'body',
      children: `<div><img src="https://mc.yandex.ru/watch/${id}" style="position:absolute; left:-9999px;" alt="" /></div>`,
    },
  ];
}

/**
 * Add the counter to the built `index.html` when an id is configured.
 *
 * @param id Value of `YANDEX_METRIKA_ID`; absent or empty means no counter ships.
 * @throws If the id is set to something that is not a tag id — a build that quietly
 *   published a broken counter would look exactly like a build that worked.
 */
export function metrika(id: string | undefined): Plugin {
  const tag = id?.trim() ?? '';
  if (tag !== '' && !ID_RE.test(tag)) {
    throw new Error(
      `YANDEX_METRIKA_ID must be a counter's numeric tag id (digits only), got '${tag}'. ` +
        'It is the number in https://metrika.yandex.ru/dashboard?id=NNNNNNNN — unset the ' +
        'variable to publish without a counter.',
    );
  }
  return {
    name: 'txt2sfx:metrika',
    apply: 'build',
    ...(tag === '' ? {} : { transformIndexHtml: (): HtmlTagDescriptor[] => counterTags(tag) }),
  };
}
