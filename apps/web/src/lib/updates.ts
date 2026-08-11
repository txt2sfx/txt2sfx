/**
 * The page's half of the service worker: registering it, and asking before it takes over.
 *
 * `plugins/pwa.ts` is the worker itself and explains what it caches. This file exists for
 * one decision that cannot be made inside a worker, because the worker cannot see what the
 * tab is in the middle of.
 *
 * ## Why an update is a button and not a reload
 *
 * A new build installs in the background and then *waits*. Swapping it in means reloading
 * the page, and this page is not a document — it is a workbench holding things that exist
 * nowhere else: generated recipes that have not been saved to `examples/` or published, a
 * decoded reference file, a microphone take, and possibly a fit a few thousand renders
 * into a differential-evolution search. `lib/session.ts` rescues the recipes and nothing
 * rescues the rest. An automatic reload would spend somebody's model call and somebody's
 * recording to deliver a stylesheet change, at a moment chosen by a deploy.
 *
 * So the worker never calls `skipWaiting()` on its own, and this module reports "there is
 * a newer version" as state. {@link applyUpdate} is the only thing that hands the worker
 * permission, and the reload that follows is one the reader asked for.
 *
 * ## Why nothing is registered under `vite dev`
 *
 * A worker serving cached modules to a dev server is HMR that silently stops working, and
 * the symptom appears in whatever file was being edited rather than here. Development
 * therefore unregisters instead of registering — that is not symmetry for its own sake:
 * `vite preview` and `vite dev` are both `localhost`, so a worker installed by a preview
 * on this machine outlives the preview and would otherwise be waiting in a dev tab
 * tomorrow, serving a build from last week.
 *
 * @packageDocumentation
 */

import { useCallback, useSyncExternalStore } from 'react';

/** The worker that has installed and is waiting for permission to take over. */
let waiting: ServiceWorker | null = null;

const listeners = new Set<() => void>();

function announce(next: ServiceWorker | null): void {
  if (waiting === next) return;
  waiting = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True once a newer build is installed and waiting. Read by {@link useUpdate}. */
function ready(): boolean {
  return waiting !== null;
}

/**
 * How long a tab may go without asking whether it is out of date.
 *
 * The browser re-fetches `sw.js` on navigation, which for an application people leave
 * open in a pinned tab can be days. An hour is short enough that a deploy is noticed the
 * same working day and long enough that the check costs one conditional request against a
 * static host — and it is only spent when somebody actually returns to the tab.
 */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Set only by {@link applyUpdate}, so a first install's `controllerchange` never reloads. */
let asked = false;

/**
 * Register the worker, or clear one left behind by a preview.
 *
 * Never rejects and never throws: a browser with service workers switched off, a page
 * opened from a `file://` URL and a registration refused by an enterprise policy are all
 * the same event here — the playground works, and it works online only.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  if (import.meta.env.DEV) {
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) void registration.unregister();
    });
    return;
  }

  const base = import.meta.env.BASE_URL;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    /* The first install claims its clients too, and that is not an update — reloading
       there would restart the page somebody has just opened, for no change at all. */
    if (!asked) return;
    window.location.reload();
  });

  void navigator.serviceWorker
    .register(`${base}sw.js`, {
      scope: base,
      /* Never read the worker script out of the HTTP cache. Static hosts serve it with a
         max-age like everything else, and a stale script is an update nobody is offered. */
      updateViaCache: 'none',
    })
    .then((registration) => {
      /* Already waiting when the page loaded — an update that installed during an earlier
         visit and was never taken. `controller` is the test for "this is an update rather
         than a first install": without one, this worker is nobody's replacement. */
      if (registration.waiting !== null && navigator.serviceWorker.controller !== null) {
        announce(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (installing === null) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller !== null) {
            announce(installing);
          }
        });
      });

      let checked = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (Date.now() - checked < UPDATE_CHECK_MS) return;
        checked = Date.now();
        void registration.update().catch(() => {
          /* Offline, most likely. There is nothing to report and nothing to retry — the
             next time this tab is looked at is the next attempt. */
        });
      });
    })
    .catch(() => {
      /* See the note above: a refused registration is not a degraded playground. */
    });
}

/**
 * Let the waiting worker take over, then reload onto it.
 *
 * The reload is not issued here. It happens when the new worker actually takes control,
 * which is the only moment at which the page and its assets are guaranteed to come from
 * the same build — reloading first would race the swap and could load the new document
 * against the old worker.
 */
export function applyUpdate(): void {
  const worker = waiting;
  if (worker === null) return;
  asked = true;
  announce(null);
  worker.postMessage({ type: 'skip-waiting' });
}

/** Whether a newer build is waiting, and the one thing to do about it. */
export function useUpdate(): { ready: boolean; apply: () => void } {
  /* `false` for the server snapshot, which this application never renders — but
     `useSyncExternalStore` demands one, and a getter that touched the store there would
     be the kind of thing that only fails once somebody adds prerendering. */
  const value = useSyncExternalStore(subscribe, ready, () => false);
  return { ready: value, apply: useCallback(applyUpdate, []) };
}
