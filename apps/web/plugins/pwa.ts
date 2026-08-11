/**
 * The playground as an installable, offline-capable application.
 *
 * ## Why this is worth having here in particular
 *
 * Most sites become a PWA to feel like an app. This one becomes a PWA because it
 * already *is* one and the network was the only thing pretending otherwise: the parser,
 * the validator, the compiler, the renderer and the differential-evolution search all
 * run in the tab, on an `OfflineAudioContext`, with no server in the loop. Nothing was
 * being proxied before this file existed — that is the claim the project makes about
 * itself — so caching the shell does not hide a round trip, it removes the last one.
 *
 * What still needs a network, and degrades on its own without any help from here:
 * the model (a key the visitor pasted, sent to their vendor), the recipe bank, the
 * Freesound library, and the webfonts. Every one of those already has a no-answer path,
 * because every one of them could always fail — `lib/examples.ts` falls back to the
 * bundled snapshot, `App.tsx` clears the bank's half of the catalog when health does not
 * answer, and `index.html` says in as many words that the type stacks fall back to system
 * faces. Offline is therefore not a new state for this application to be in. It is the
 * state it was already written for.
 *
 * ## What is precached, and what deliberately is not
 *
 * The **shell**: the entry chunk, everything it imports statically, the stylesheet, the
 * manifest, the icons, and the document itself. About 930 KB at the time of writing.
 *
 * Not the **lazy chunks**. `mediabunny`'s AAC encoder alone is 991 KB — larger than the
 * whole rest of the application — and it is loaded only if somebody exports M4A. Making
 * every first visit pay a megabyte for an encoder most visitors never reach would be an
 * odd thing for a project whose pitch is that sounds weigh bytes. They are cached the
 * first time they are actually used instead, which is the honest trade: an encoder you
 * have used once works offline, and one you have never used costs nothing.
 *
 * Not `og.png` (46 KB, fetched by scrapers and never by this page) and not `chat.txt`
 * (fetched by somebody else's chat, from somebody else's network).
 *
 * ## Why the update is a prompt and never automatic
 *
 * A new worker installs, then waits. Nothing swaps under a running tab until the person
 * looking at it presses a button, and the reason is what this tab holds that exists
 * nowhere else: unsaved generated recipes, a decoded reference, an open microphone, and
 * a fit that is a few thousand renders into a search. `self.skipWaiting()` on install
 * would throw a reload into the middle of any of that to deliver a CSS change.
 *
 * ## Why the worker is a string in here rather than a module in `src/`
 *
 * A service worker is not part of the application bundle — it has its own global scope,
 * its own registration lifetime, and it must be served from the site root under a stable
 * name, which is the one file in a Vite build that cannot be content-hashed. Compiling it
 * would mean a second build with a `WebWorker` lib, a second tsconfig and an entry that
 * must be kept unhashed by hand. Written out here, {@link serviceWorkerSource} is a pure
 * function of the build's file names, so a test reads exactly what would ship without
 * running a build — the same stance `plugins/metrika.ts` takes about its snippet.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HtmlTagDescriptor, Plugin } from 'vite';

/** Where the worker is served from, relative to the site root. */
export const SW_PATH = 'sw.js';

/** Where the manifest is served from, relative to the site root. */
export const MANIFEST_PATH = 'manifest.webmanifest';

/**
 * The plate colour, as `#070810`.
 *
 * `--bg` from `styles.css` converted once, and the same value `assets/og-card.py` and the
 * inline favicon already carry. It is both the theme colour — the tint a mobile browser
 * paints its own chrome with — and the background of the splash screen Android draws from
 * the manifest before the first frame renders, so a different value here would show as a
 * flash of the wrong colour on every cold start.
 */
export const PLATE = '#070810';

/** The icons `assets/app-icon.py` draws, as the manifest lists them. */
export const ICONS = [
  { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  /* Android crops this one to the launcher's shape. `app-icon.py` explains the inset. */
  { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
] as const;

/** The two origins the typefaces come from, and the only cross-origin ones cached. */
export const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] as const;

/**
 * The manifest, as the object it is serialized from.
 *
 * @param base The site's base path, with a trailing slash — `vite.config.ts` normalizes it.
 */
export function appManifest(base: string): Record<string, unknown> {
  return {
    /* Pinned explicitly rather than left to default from `start_url`. This is the string
       that decides whether an update is the *same* application to the browser: derived, it
       would change the day the site moved to a subdirectory and every installed copy would
       become an orphan alongside a stranger with the same name. */
    id: base,
    name: 'txt2sfx — soundline playground',
    /* What fits under a home-screen icon. Anything longer is elided by the launcher. */
    short_name: 'txt2sfx',
    description:
      'Describe a sound effect in words and get back compact procedural Web Audio code — ' +
      'typically 300–1000 bytes, zero dependencies — instead of an audio file.',
    start_url: base,
    scope: base,
    display: 'standalone',
    background_color: PLATE,
    theme_color: PLATE,
    /* The playground is a three-column studio on a desktop and a stack on a phone; it has
       no orientation it refuses to be in, and locking one would only break tablets. */
    orientation: 'any',
    lang: 'en',
    dir: 'ltr',
    categories: ['developer', 'music', 'utilities'],
    icons: ICONS.map((icon) => ({ ...icon, src: `${base}${icon.src}` })),
  };
}

/**
 * The head tags that make the document installable.
 *
 * Exported so a test can read them without running a build.
 *
 * @param base The site's base path, with a trailing slash.
 */
export function manifestTags(base: string): HtmlTagDescriptor[] {
  return [
    { tag: 'link', injectTo: 'head', attrs: { rel: 'manifest', href: `${base}${MANIFEST_PATH}` } },
    { tag: 'meta', injectTo: 'head', attrs: { name: 'theme-color', content: PLATE } },
    /* iOS reads none of the manifest. These three are the whole of what it does read:
       the icon by `<link>`, the standalone hint, and the status bar's colour. The
       unprefixed `mobile-web-app-capable` is the standard's replacement for the second
       and is what every other browser wants, so both ship — one of them is dead weight
       on every platform and there is no platform on which the same one is dead. */
    {
      tag: 'link',
      injectTo: 'head',
      attrs: { rel: 'apple-touch-icon', href: `${base}icons/apple-touch-icon-180.png` },
    },
    { tag: 'meta', injectTo: 'head', attrs: { name: 'mobile-web-app-capable', content: 'yes' } },
    { tag: 'meta', injectTo: 'head', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' } },
    /* `black`, not `black-translucent`: the translucent one puts the document under the
       status bar, which needs safe-area padding this stylesheet does not have. */
    {
      tag: 'meta',
      injectTo: 'head',
      attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'black' },
    },
  ];
}

/** What {@link serviceWorkerSource} needs to know about one build. */
export interface WorkerConfig {
  /** The site's base path, with a trailing slash. */
  readonly base: string;
  /** Changes exactly when the shell's bytes change; names the caches. */
  readonly version: string;
  /** Absolute URLs fetched at install time. The first must be {@link WorkerConfig.base}. */
  readonly shell: readonly string[];
  /** Prefix under which the build's own hashed output lives — `/assets/`. */
  readonly assets: string;
}

/**
 * The service worker, as text.
 *
 * Written as a string rather than compiled — see this file's header for why — and kept
 * free of template literals inside the body so the one place `${` appears is an injected
 * constant. Everything it does is decided by four rules, in this order:
 *
 * 1. **Anything that is not a plain `GET` is not ours.** A model call is a `POST` to a
 *    vendor with a key in its headers; publishing to the bank is a `POST` with a bearer
 *    token. Neither should ever meet a cache, and the cheapest way to guarantee that is
 *    to decline before looking at anything else.
 * 2. **A navigation is answered with the cached document.** There is no router here —
 *    the screens are a `useState` — so every navigation is the same document, and the
 *    query and fragment that carry an OAuth code or a shared recipe survive untouched
 *    because they never reach the cache key.
 * 3. **Same-origin build output is cache-first**, from the precache when it is part of
 *    the shell and from a runtime cache when it is a lazy chunk. Both are safe to serve
 *    without revalidating because both are content-hashed: the name *is* the version.
 * 4. **Everything else goes to the network untouched**, including the bank, Freesound,
 *    the model, `chat.txt` and `og.png` — with the two font origins as the single
 *    exception, because a design that reflows to system faces the moment the network
 *    drops is a worse answer than caching two files.
 */
export function serviceWorkerSource(config: WorkerConfig): string {
  const { base, version, shell, assets } = config;
  return `/*
 * Generated by apps/web/plugins/pwa.ts — do not edit, and do not check in.
 * Every decision this file makes is explained there.
 */
'use strict';

const VERSION = ${JSON.stringify(version)};
const BASE = ${JSON.stringify(base)};
const ASSETS = ${JSON.stringify(assets)};
const SHELL = ${JSON.stringify(shell, null, 2)};
const FONT_ORIGINS = ${JSON.stringify([...FONT_ORIGINS])};

/* Versioned, so activating a new worker cannot read a byte written by the old one. */
const PRECACHE = 'txt2sfx-shell-' + VERSION;
const RUNTIME = 'txt2sfx-lazy-' + VERSION;
/* Not versioned: a webfont is somebody else's immutable, content-addressed file and has
   nothing to do with which build of this application is installed. */
const FONTS = 'txt2sfx-fonts';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE).then((cache) =>
      /* 'reload' bypasses the HTTP cache for the install fetch. Without it, a worker
         installing minutes after a deploy can precache the *previous* index.html — the
         document is served with a short max-age, and a shell whose HTML and hashed
         assets come from two different builds is a blank page nobody can explain. */
      cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))),
    ),
  );
  /* Nothing is taken over here, on purpose. The tab holds unsaved recipes, a decoded
     reference and possibly a running search, so the message handler below is the only
     place this worker ever stops waiting — and the page decides when that is. */
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== PRECACHE && name !== RUNTIME && name !== FONTS)
          .map((name) => caches.delete(name)),
      );
      /* Take over tabs that were opened before any worker existed, so the first visit is
         also the one that becomes usable offline. Safe here and not on install: by this
         point the shell is fully precached. */
      await self.clients.claim();
    })(),
  );
});

/* The other half of the update prompt in lib/updates.ts: the page decides when. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

/* 'Vary: Accept-Encoding' is on everything a static host serves, and the Cache API honours
   it by comparing the stored request's headers with the new one's. A shell precached by a
   plain fetch would then miss when the same file is asked for as a script or a stylesheet,
   and the symptom is an application that is mysteriously online-only. The URL is the whole
   identity of a content-hashed file, so there is nothing here for Vary to be right about. */
const MATCH = { ignoreVary: true };

/** Serve from a cache, falling back to the network and remembering what it answered. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, MATCH);
  if (hit !== undefined) return hit;
  const response = await fetch(request);
  /* Only a real 200. Caching a 404 or a captive portal's redirect would pin the failure
     for as long as the cache lives, which is exactly as long as nobody can explain it. */
  if (response.ok && response.status === 200) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  /* The base address itself, not every navigation. This application has no routes — the
     screens are React state — so the only document it owns is that one, and answering
     more broadly would hand the shell to somebody who navigated to /chat.txt or /og.png
     on purpose. Query and fragment are not part of the comparison, which is what lets an
     OAuth return and a shared-recipe link open offline like any other visit. */
  if (request.mode === 'navigate' && url.pathname === BASE) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(BASE, { cacheName: PRECACHE, ignoreVary: true });
        /* The network is the fallback rather than the other way round: an installed
           application that shows a browser error page because a phone is in a lift is
           the failure this whole file exists to prevent. */
        return cached !== undefined ? cached : fetch(request);
      })(),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    if (SHELL.indexOf(url.pathname) !== -1) {
      event.respondWith(cacheFirst(request, PRECACHE));
    } else if (url.pathname.startsWith(ASSETS)) {
      /* A lazy chunk — an audio encoder, most likely. Cached when it is first reached
         rather than at install time, so nobody downloads a megabyte for a format they
         never export. */
      event.respondWith(cacheFirst(request, RUNTIME));
    }
    return;
  }

  if (FONT_ORIGINS.indexOf(url.origin) !== -1) {
    event.respondWith(
      /* Re-issued as a CORS request. The stylesheet link is 'no-cors', whose response is
         opaque — status 0, body unreadable — and storing one would mean caching an error
         indistinguishable from a success. Both Google Fonts origins answer CORS requests
         with 'Access-Control-Allow-Origin: *', so asking properly gives a response this
         worker can actually check before it keeps it. */
      cacheFirst(new Request(url.href, { mode: 'cors', credentials: 'omit' }), FONTS).catch(
        /* Offline with nothing cached. The stacks in styles.css fall back to system
           faces, so failing here is a different typeface and not a broken page. */
        () => fetch(request),
      ),
    );
  }

  /* Everything else — the bank, Freesound, the model vendors, chat.txt, og.png — is not
     answered here at all, which leaves it to the network exactly as if no worker existed. */
});
`;
}

/**
 * Every URL fetched at install time, in the order they are written into the worker.
 *
 * The rule is "what the first paint needs, and nothing that only some visits need": the
 * document, the entry chunk and everything it pulls in *statically*, the stylesheet, the
 * manifest and the icons. A dynamic import is by construction something the application
 * decided it could live without until later, so it is left to the runtime cache.
 *
 * @param bundle Rollup's output, keyed by file name.
 * @param base The site's base path, with a trailing slash.
 */
export function shellUrls(
  bundle: Readonly<Record<string, { type: string; isEntry?: boolean; imports?: readonly string[] }>>,
  base: string,
): string[] {
  const entry = Object.entries(bundle).find(
    ([, item]) => item.type === 'chunk' && item.isEntry === true,
  )?.[0];
  const chunks = new Set<string>();

  /* Breadth-first over static imports only. Rollup gives each chunk its direct imports,
     and a chunk graph is a graph rather than a tree — the set is what stops a shared
     helper imported from two places from being walked twice. */
  const queue = entry === undefined ? [] : [entry];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (chunks.has(name)) continue;
    chunks.add(name);
    for (const next of bundle[name]?.imports ?? []) queue.push(next);
  }

  const css = Object.entries(bundle)
    .filter(([name, item]) => item.type === 'asset' && name.endsWith('.css'))
    .map(([name]) => name);

  return [
    /* The document, addressed as the site's root rather than as `index.html`. That is the
       URL a navigation is answered from, and the one the manifest's `start_url` names. */
    base,
    ...[...chunks].sort().map((name) => `${base}${name}`),
    ...css.sort().map((name) => `${base}${name}`),
    `${base}${MANIFEST_PATH}`,
    ...ICONS.map((icon) => `${base}${icon.src}`),
  ];
}

/**
 * Make the built playground installable and usable with no network.
 *
 * The head tags and the manifest ship in `vite dev` as well, because they are how you
 * check by hand that the icons and the install prompt are right. The **worker** is a
 * build artefact only: one registered against the dev server would serve yesterday's
 * modules over HMR, and the failure looks like a bug in whatever was being edited.
 *
 * @param base The site's base path, with a trailing slash — as `vite.config.ts` computes it.
 */
export function pwa(base: string): Plugin {
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  let outDir = '';

  return {
    name: 'txt2sfx:pwa',

    configResolved(config) {
      /* Resolved against the project root rather than used as given: `build.outDir` is
         allowed to be relative, and a relative path here would be resolved against
         whatever directory the build was started from. `resolve` leaves an absolute one
         alone, so this costs nothing in the ordinary case. */
      outDir = resolve(config.root, config.build.outDir);
    },

    transformIndexHtml: (): HtmlTagDescriptor[] => manifestTags(base),

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if ((request.url ?? '').split('?')[0] !== `/${MANIFEST_PATH}`) {
          next();
          return;
        }
        response.setHeader('content-type', 'application/manifest+json; charset=utf-8');
        response.end(JSON.stringify(appManifest(base), null, 2));
      });
    },

    /**
     * Written from disk rather than emitted into the bundle, and that is the whole
     * reason this runs here instead of in `generateBundle`.
     *
     * The version has to cover `index.html`, which is not content-hashed — a build that
     * changed only the document (a meta tag, a title) would otherwise produce a
     * byte-identical worker, and every installed copy would keep serving the old
     * document from its cache forever, with nothing anywhere reporting a problem. The
     * document is emitted by another plugin's `generateBundle`, so reading it *there*
     * would make correctness depend on plugin ordering. By `writeBundle` every file
     * rollup produces is on disk and the question does not arise.
     */
    writeBundle(_options, bundle) {
      const shell = shellUrls(bundle as never, base);

      writeFileSync(`${outDir}/${MANIFEST_PATH}`, `${JSON.stringify(appManifest(base), null, 2)}\n`);

      const digest = createHash('sha256');
      for (const url of shell) {
        const path = url.slice(base.length);
        /* The icons are still in `public/` at this point — Vite copies that directory
           after every `writeBundle` has run — so both roots are tried. */
        const file = path === '' ? `${outDir}/index.html` : `${outDir}/${path}`;
        let bytes: Buffer;
        try {
          bytes = readFileSync(file);
        } catch {
          bytes = readFileSync(`${publicDir}${path}`);
        }
        digest.update(url).update(bytes);
      }
      /* Twelve hex characters of SHA-256. This names a cache and appears in no security
         decision — it only has to differ whenever the shell differs, and 48 bits is far
         past the point where two consecutive builds could collide. */
      const version = digest.digest('hex').slice(0, 12);

      writeFileSync(
        `${outDir}/${SW_PATH}`,
        serviceWorkerSource({ base, version, shell, assets: `${base}assets/` }),
      );
    },
  };
}
