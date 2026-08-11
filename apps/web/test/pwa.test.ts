/**
 * The installable playground, and the four ways it breaks without anybody noticing.
 *
 * A service worker is the least observable thing in a web application. It runs in another
 * global, it only takes effect on the *second* visit, and every failure mode here looks
 * like a working site to the person who deployed it:
 *
 * 1. **It caches something it must never cache.** A model call carries a key the visitor
 *    pasted; publishing to the bank carries a bearer token. Both are `POST`, and the rule
 *    that keeps them away from storage is one line that nothing else in the repository
 *    would miss if it were deleted.
 * 2. **It swaps a build under a running tab.** One call to `skipWaiting()` in the install
 *    handler turns every deploy into a reload in the middle of somebody's fit, and the
 *    only symptom is work that occasionally disappears.
 * 3. **The version stops covering the document.** `index.html` is the one file a Vite
 *    build does not content-hash, so a worker versioned off asset names alone goes on
 *    serving last month's document from cache with nothing reporting a problem.
 * 4. **The manifest names an icon that does not ship.** Nothing resolves those paths at
 *    build time — the install prompt simply stops appearing, on somebody else's phone.
 *
 * The pure halves are exercised as functions; the version is exercised against a real
 * directory, because that failure is precisely about what is on disk.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FONT_ORIGINS,
  ICONS,
  MANIFEST_PATH,
  PLATE,
  SW_PATH,
  appManifest,
  manifestTags,
  pwa,
  serviceWorkerSource,
  shellUrls,
} from '../plugins/pwa.js';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** A build's output as rollup describes it: an entry, a static import, a lazy chunk. */
const BUNDLE = {
  'assets/index-aaaa.js': { type: 'chunk', isEntry: true, imports: ['assets/src-bbbb.js'] },
  'assets/src-bbbb.js': { type: 'chunk', isEntry: false, imports: [] },
  'assets/mp3-encoder-cccc.js': { type: 'chunk', isEntry: false, imports: [] },
  'assets/index-dddd.css': { type: 'asset' },
  'index.html': { type: 'asset' },
};

const worker = (base = '/'): string =>
  serviceWorkerSource({
    base,
    version: 'deadbeef0001',
    shell: shellUrls(BUNDLE, base),
    assets: `${base}assets/`,
  });

describe('the service worker', () => {
  it('is JavaScript that parses', () => {
    /* Compiles the body without running it — the only check available for a file that
       has no module system, no imports and a global object this process does not have. */
    expect(() => new Function(worker())).not.toThrow();
  });

  /* The whole "ask, never reload" decision, in one assertion. `skipWaiting` may appear
     exactly once, in the handler for the message the page sends when somebody presses
     the button; in the install handler it would cost people work. */
  it('never takes over on its own', () => {
    const source = worker();
    expect(source.match(/skipWaiting\(\)/g)).toHaveLength(1);
    const install = source.slice(source.indexOf("addEventListener('install'"), source.indexOf("addEventListener('activate'"));
    expect(install).not.toContain('skipWaiting');
    expect(source).toContain("event.data.type === 'skip-waiting'");
  });

  /* A key or a session token must never reach storage. Declining before anything else is
     looked at is what guarantees it, so the order of these two lines is the test. */
  it('declines everything that is not a plain GET, before it looks at anything', () => {
    const source = worker();
    const handler = source.slice(source.indexOf("addEventListener('fetch'"));
    const declines = handler.indexOf("request.method !== 'GET'");
    expect(declines).toBeGreaterThan(-1);
    expect(declines).toBeLessThan(handler.indexOf('respondWith'));
  });

  /* Everything this page talks to that is not the site itself: the bank, Freesound, the
     model vendors. None of them may be named here, and the fonts are the one exception
     that is — an origin acquiring a cache should have to be written down on purpose. */
  it('intercepts no cross-origin host but the two the typefaces come from', () => {
    const source = worker();
    for (const origin of FONT_ORIGINS) expect(source).toContain(origin);
    for (const host of ['txt2sfx.pix3.dev', 'freesound.org', 'googleapis.com/v1', 'anthropic.com']) {
      expect(source, host).not.toContain(host);
    }
    /* Two, and the count is the point: the list is `indexOf`ed against a live request. */
    expect(source.match(/https:\/\/fonts\./g)).toHaveLength(FONT_ORIGINS.length);
  });

  /* The shell is answered for the site's own address and for nothing else — a reader who
     navigated to /chat.txt on purpose must get /chat.txt. */
  it('answers navigations only at the base address', () => {
    expect(worker()).toContain("request.mode === 'navigate' && url.pathname === BASE");
  });

  it('names both caches after the version, so activating cannot read the old one', () => {
    const source = worker();
    expect(source).toContain("'txt2sfx-shell-' + VERSION");
    expect(source).toContain("'txt2sfx-lazy-' + VERSION");
    /* The fonts are deliberately not versioned — they are not this build's files. */
    expect(source).toMatch(/const FONTS = 'txt2sfx-fonts'/);
  });
});

describe('the precache list', () => {
  it('is the entry chunk and what it imports statically, plus the document and the style', () => {
    const shell = shellUrls(BUNDLE, '/');
    expect(shell[0]).toBe('/');
    expect(shell).toContain('/assets/index-aaaa.js');
    expect(shell).toContain('/assets/src-bbbb.js');
    expect(shell).toContain('/assets/index-dddd.css');
  });

  /* The megabyte that is not spent. An encoder reached only by exporting M4A is cached
     the first time it is used, and costs a first-time visitor nothing. */
  it('leaves lazily loaded chunks to the runtime cache', () => {
    expect(shellUrls(BUNDLE, '/')).not.toContain('/assets/mp3-encoder-cccc.js');
  });

  it('carries the icons and the manifest, because an offline install still draws itself', () => {
    const shell = shellUrls(BUNDLE, '/');
    for (const icon of ICONS) expect(shell, icon.src).toContain(`/${icon.src}`);
    expect(shell).toContain(`/${MANIFEST_PATH}`);
  });

  /* A fork publishing to a project site sets `PAGES_BASE_PATH`; a precache list that
     ignored it would install a worker that 404s on every one of its own files. */
  it('is written under the configured base path, every entry of it', () => {
    for (const url of shellUrls(BUNDLE, '/txt2sfx/')) expect(url.startsWith('/txt2sfx/')).toBe(true);
  });
});

describe('the manifest', () => {
  it('names icons that actually ship, at the sizes an install prompt requires', () => {
    const sizes = ICONS.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    /* Without one of these Android crops the square icon into its own launcher shape and
       takes the corners of the drawing with it. */
    expect(ICONS.some((icon) => icon.purpose === 'maskable')).toBe(true);
    for (const icon of ICONS) {
      expect(existsSync(r(`../public/${icon.src}`)), icon.src).toBe(true);
    }
  });

  /* Linked from the document rather than the manifest, because Safari reads no manifest —
     which also means nothing else in this repository resolves the path. */
  it('ships the icon iOS asks for by name', () => {
    const tags = manifestTags('/');
    const link = tags.find((tag) => tag.attrs?.['rel'] === 'apple-touch-icon');
    const href = String(link?.attrs?.['href'] ?? '');
    expect(href).not.toBe('');
    expect(existsSync(r(`../public/${href.slice(1)}`)), href).toBe(true);
  });

  it('is one application under any base path, and says where it starts', () => {
    const manifest = appManifest('/txt2sfx/');
    expect(manifest['id']).toBe('/txt2sfx/');
    expect(manifest['start_url']).toBe('/txt2sfx/');
    expect(manifest['scope']).toBe('/txt2sfx/');
    expect(manifest['display']).toBe('standalone');
    const icons = manifest['icons'] as { src: string }[];
    for (const icon of icons) expect(icon.src.startsWith('/txt2sfx/')).toBe(true);
  });

  /* The splash screen is drawn from the manifest before the first frame exists, so a
     colour that disagrees with the stylesheet is a flash of the wrong background on every
     cold start. One value, and the document's own theme tag has to be it too. */
  it('paints the same plate the page does', () => {
    const manifest = appManifest('/');
    expect(manifest['background_color']).toBe(PLATE);
    expect(manifest['theme_color']).toBe(PLATE);
    const theme = manifestTags('/').find((tag) => tag.attrs?.['name'] === 'theme-color');
    expect(theme?.attrs?.['content']).toBe(PLATE);
    /* The favicon in `index.html` is the same plate, inlined. */
    expect(readFileSync(r('../index.html'), 'utf8')).toContain(PLATE.replace('#', '%23'));
  });
});

/* ------------------------------------------------------------------------- *
 * What the worker actually does
 * ------------------------------------------------------------------------- */

/** A response, with the two properties the worker reads and the one method it calls. */
interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  clone: () => FakeResponse;
}

/** A request, resolved against the site's origin exactly as the browser would. */
class FakeRequest {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
  readonly cache: string;
  constructor(input: string, init: { method?: string; mode?: string; cache?: string } = {}) {
    this.url = new URL(input, `${ORIGIN}/`).href;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'no-cors';
    this.cache = init.cache ?? 'default';
  }
}

const ORIGIN = 'https://txt2sfx.github.io';

/** Where a cache filed something. The URL is the whole key — the worker relies on that. */
const keyOf = (input: FakeRequest | string): string =>
  typeof input === 'string' ? new URL(input, `${ORIGIN}/`).href : input.url;

/**
 * Run the generated worker against mocks of the four globals it uses.
 *
 * Executing it rather than reading it is the only way to test the rules that matter:
 * "a POST is never cached" is a claim about behaviour, and a `toContain` on the source
 * would keep passing after somebody moved the check below the first `respondWith`.
 */
function runWorker(source: string): {
  fire: (type: string, event: Record<string, unknown>) => Promise<void>;
  ask: (url: string, init?: { method?: string; mode?: string }) => Promise<FakeResponse | null>;
  caches: Map<string, Map<string, FakeResponse>>;
  fetched: FakeRequest[];
  skipped: () => boolean;
} {
  const store = new Map<string, Map<string, FakeResponse>>();
  const fetched: FakeRequest[] = [];
  let skipped = false;

  const respond = (url: string): FakeResponse => {
    const response: FakeResponse = { ok: true, status: 200, url, clone: () => response };
    return response;
  };

  const fetchMock = async (request: FakeRequest | string): Promise<FakeResponse> => {
    const asRequest = typeof request === 'string' ? new FakeRequest(request) : request;
    fetched.push(asRequest);
    return respond(asRequest.url);
  };

  const cacheFor = (name: string): Map<string, FakeResponse> => {
    const existing = store.get(name);
    if (existing !== undefined) return existing;
    const created = new Map<string, FakeResponse>();
    store.set(name, created);
    return created;
  };

  const cachesMock = {
    open: async (name: string) => {
      const entries = cacheFor(name);
      return {
        match: async (request: FakeRequest | string) => entries.get(keyOf(request)),
        put: async (request: FakeRequest | string, response: FakeResponse) => {
          entries.set(keyOf(request), response);
        },
        addAll: async (requests: readonly FakeRequest[]) => {
          for (const request of requests) entries.set(keyOf(request), await fetchMock(request));
        },
      };
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
    match: async (request: FakeRequest | string, options: { cacheName?: string } = {}) =>
      store.get(options.cacheName ?? '')?.get(keyOf(request)),
  };

  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const selfMock = {
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
      handlers.set(type, handler);
    },
    location: { origin: ORIGIN },
    clients: { claim: async () => undefined },
    skipWaiting: () => {
      skipped = true;
    },
  };

  /* The worker's four free variables, handed in as parameters. Everything else it uses —
     `URL`, `Promise`, `Map` — is a language global and is already here. */
  new Function('self', 'caches', 'fetch', 'Request', source)(selfMock, cachesMock, fetchMock, FakeRequest);

  const fire = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const pending: Promise<unknown>[] = [];
    handlers.get(type)?.({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  };

  const ask = async (
    url: string,
    init: { method?: string; mode?: string } = {},
  ): Promise<FakeResponse | null> => {
    let answer: Promise<FakeResponse> | null = null;
    handlers.get('fetch')?.({
      request: new FakeRequest(url, init),
      respondWith: (promise: Promise<FakeResponse>) => {
        answer = promise;
      },
    });
    return answer === null ? null : await answer;
  };

  return { fire, ask, caches: store, fetched, skipped: () => skipped };
}

describe('the worker, running', () => {
  /** An installed worker, its precache warm and its network log cleared. */
  async function installed(): Promise<ReturnType<typeof runWorker>> {
    const running = runWorker(worker());
    await running.fire('install', {});
    running.fetched.length = 0;
    return running;
  }

  it('precaches the whole shell, bypassing the HTTP cache to do it', async () => {
    const running = runWorker(worker());
    await running.fire('install', {});
    const precache = [...running.caches.values()][0];
    for (const url of shellUrls(BUNDLE, '/')) {
      expect(precache?.has(`${ORIGIN}${url}`), url).toBe(true);
    }
    /* The stale-document trap: without 'reload' an install minutes after a deploy can
       precache the previous index.html against this build's hashed assets. */
    for (const request of running.fetched) expect(request.cache).toBe('reload');
  });

  /* The rule the visitor's key depends on. A model call is a POST carrying a pasted
     secret, and publishing to the bank is a POST carrying a bearer token. */
  it('does not answer, or store, anything that is not a GET', async () => {
    const running = await installed();
    const before = running.caches.size;
    expect(await running.ask('https://generativelanguage.googleapis.com/v1/models', { method: 'POST' })).toBeNull();
    expect(await running.ask('https://txt2sfx.pix3.dev/api/recipes', { method: 'POST' })).toBeNull();
    expect(running.caches.size).toBe(before);
    expect(running.fetched).toHaveLength(0);
  });

  /* Reading the bank is a GET, and it still must not be touched: a cached listing is a
     gallery that goes on showing recipes somebody deleted. */
  it('leaves other hosts to the network, GET or not', async () => {
    const running = await installed();
    for (const url of [
      'https://txt2sfx.pix3.dev/api/recipes',
      'https://freesound.org/apiv2/search/text/',
      'https://api.anthropic.com/v1/messages',
    ]) {
      expect(await running.ask(url), url).toBeNull();
    }
  });

  it('opens offline: the document is answered from cache, with no network at all', async () => {
    const running = await installed();
    const answer = await running.ask('/', { mode: 'navigate' });
    expect(answer?.url).toBe(`${ORIGIN}/`);
    expect(running.fetched).toHaveLength(0);
  });

  /* A shared recipe and an OAuth return both arrive as the base address with a payload
     after it. Neither may miss the cache — that is the offline install failing on exactly
     the two links people send each other. */
  it('opens offline through a shared link and an auth return', async () => {
    const running = await installed();
    for (const url of ['/?code=abc&state=xyz', '/#share=eyJuYW1lIjoi']) {
      expect((await running.ask(url, { mode: 'navigate' }))?.url, url).toBe(`${ORIGIN}/`);
    }
    expect(running.fetched).toHaveLength(0);
  });

  it('hands /chat.txt to the network even when it is navigated to', async () => {
    const running = await installed();
    expect(await running.ask('/chat.txt', { mode: 'navigate' })).toBeNull();
  });

  it('serves the shell from cache and fetches a lazy chunk exactly once', async () => {
    const running = await installed();
    await running.ask('/assets/index-aaaa.js');
    expect(running.fetched).toHaveLength(0);

    /* First reach for the encoder: over the network, and kept. */
    expect(await running.ask('/assets/mp3-encoder-cccc.js')).not.toBeNull();
    expect(running.fetched).toHaveLength(1);
    await running.ask('/assets/mp3-encoder-cccc.js');
    expect(running.fetched).toHaveLength(1);
  });

  it('keeps the fonts in a cache of their own', async () => {
    const running = await installed();
    await running.ask('https://fonts.gstatic.com/s/archivo/v19/font.woff2');
    const fonts = running.caches.get('txt2sfx-fonts');
    expect(fonts?.size).toBe(1);
  });

  it('stops waiting only when the page says so', async () => {
    const running = await installed();
    await running.fire('message', { data: { type: 'something-else' } });
    expect(running.skipped()).toBe(false);
    await running.fire('message', { data: { type: 'skip-waiting' } });
    expect(running.skipped()).toBe(true);
  });

  /* An old build's shell left behind is storage nobody can reach and a cache that could
     answer after an update. The fonts are not this build's and stay. */
  it('drops every cache but its own on activation', async () => {
    const running = await installed();
    await running.ask('https://fonts.gstatic.com/s/archivo/v19/font.woff2');
    running.caches.set('txt2sfx-shell-0000deadbeef', new Map());
    await running.fire('activate', {});
    expect([...running.caches.keys()].sort()).toEqual([
      'txt2sfx-fonts',
      'txt2sfx-shell-deadbeef0001',
    ]);
  });
});

describe('the emitted build', () => {
  /**
   * Drive `configResolved` and `writeBundle` against a real directory.
   *
   * @param html What `index.html` contains for this build.
   * @returns The generated worker, as text.
   */
  function build(html: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'txt2sfx-pwa-'));
    try {
      mkdirSync(join(dir, 'assets'), { recursive: true });
      writeFileSync(join(dir, 'index.html'), html);
      writeFileSync(join(dir, 'assets/index-aaaa.js'), 'entry');
      writeFileSync(join(dir, 'assets/src-bbbb.js'), 'imported');
      writeFileSync(join(dir, 'assets/index-dddd.css'), 'style');

      const plugin = pwa('/');
      /* The hooks, called the way `chat-prompt.test.ts` calls them: a build takes seconds
         and would be testing Vite rather than this file. */
      const resolved = plugin.configResolved;
      const configure = typeof resolved === 'function' ? resolved : resolved?.handler;
      /* `root` and a relative `outDir`, which is the shape Vite actually hands over —
         an absolute one here would let a plugin that ignored `root` pass anyway. */
      configure?.call({} as never, { root: dir, build: { outDir: '.' } } as never);

      const write = plugin.writeBundle;
      const emit = typeof write === 'function' ? write : write?.handler;
      if (emit === undefined) throw new Error('the plugin writes nothing');
      emit.call({} as never, {} as never, BUNDLE as never);

      /* The manifest lands beside it, or the precache list points at a 404. */
      expect(existsSync(join(dir, MANIFEST_PATH))).toBe(true);
      return readFileSync(join(dir, SW_PATH), 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const version = (source: string): string => /const VERSION = "([^"]+)"/.exec(source)?.[1] ?? '';

  it('produces the same worker twice for the same files', () => {
    const html = '<!doctype html><title>txt2sfx</title>';
    expect(version(build(html))).toBe(version(build(html)));
    expect(version(build(html))).not.toBe('');
  });

  /* The reason the worker is written in `writeBundle` from disk rather than emitted from
     the chunk graph. `index.html` is not content-hashed, so a build that changed only the
     document would otherwise be byte-identical here — and every installed copy would keep
     serving the old one from its cache, forever, with nothing anywhere saying so. */
  it('changes version when only the document changed', () => {
    const before = build('<!doctype html><title>txt2sfx</title>');
    const after = build('<!doctype html><title>txt2sfx — soundline playground</title>');
    expect(version(before)).not.toBe(version(after));
  });
});
