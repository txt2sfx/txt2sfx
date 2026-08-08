/**
 * Connecting a Freesound account, from the page's side.
 *
 * ## Why there is no key field any more
 *
 * Because a shared key would be against the API terms and a per-user key is not
 * something Freesound's settings offer any more: what a person can create there is an
 * *application*, and applications reach users through OAuth2. So the tab asks the user
 * to log in to Freesound, and every request afterwards carries their own token — which
 * is exactly the state §4d of the terms requires ("logged on to the Platform with valid
 * user credentials and live session").
 *
 * The bank does one step of that dance and nothing else: the `code → token` exchange
 * is signed with a client secret that cannot ship to a browser. It stores nothing —
 * see `apps/server/src/routes/freesound.ts`, where the absence is a test.
 *
 * ## Where the tokens live, and why keeping them is the default
 *
 * In this tab, and — unlike a pasted model key — **kept without being asked**, encrypted
 * under a non-extractable `CryptoKey` in IndexedDB (`lib/keystore.ts` documents exactly
 * what that does and does not protect against). Never `localStorage`, which is the
 * project's standing rule for anything that is a secret.
 *
 * The difference from the model keys is not carelessness, it is that the two credentials
 * are not alike. A vendor key is a bearer secret with a bill attached, pasted once, with
 * no way to revoke it from inside this page — so keeping it is the user's call, made with
 * a tick. This is an OAuth grant for the user's own Freesound account, created by a round
 * trip they walked through themselves, scoped to that account, and revocable from two
 * places: **Disconnect** here, which erases it, and their Freesound settings, which kills
 * it everywhere. A connection that had to be re-established on every reload would not be
 * a connection; it would be a ceremony. And what is actually being kept is the refresh
 * token — the access token expires in 24 hours no matter what.
 *
 * ## The hand-off, and why the fragment is scrubbed
 *
 * Identical to sign-in (`lib/account.ts`), deliberately: the bank sends the browser back
 * with `#freesound=<one-time code>`, the page trades it over `POST`, and the fragment is
 * rewritten with `replaceState` the moment it is read — before the exchange even
 * happens — so the code is never in history or in the next screenshot. A refused
 * connection comes back as `#freesound_error=<code>`.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { canRemember, keystore } from './keystore.js';

/** The keystore entry the connection lives under. */
const STORED_UNDER = 'freesound-oauth';

/**
 * Refresh this many seconds before the access token is due to expire.
 *
 * A minute, because the only cost of refreshing early is one request and the cost of
 * refreshing late is a search that fails in front of somebody. The clock is the
 * browser's, so this also absorbs a modest amount of clock skew.
 */
const EARLY_REFRESH_SECONDS = 60;

/** What the tab holds after a connection. */
export interface FreesoundTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds when the access token stops working. */
  readonly expiresAt: number;
}

/** Whether this bank can connect anybody at all. */
export type ConnectionState = 'unknown' | 'unavailable' | 'off' | 'connecting' | 'on';

/** The connection, as the panel sees it. */
export interface FreesoundConnection {
  readonly state: ConnectionState;
  /** Set when the last attempt failed: the bank's or the library's code, verbatim. */
  readonly error: string | null;
  /** Send the browser to freesound.org to ask for permission. */
  readonly connect: () => void;
  /** Forget the tokens here and in the keystore. Freesound is not told; it cannot be. */
  readonly disconnect: () => void;
  /**
   * A usable access token, refreshing first when the current one is spent.
   *
   * `null` when there is no connection — the caller shows the connect button rather
   * than a failure.
   */
  readonly token: () => Promise<string | null>;
  /** Force a refresh after the library has refused a token this tab believed in. */
  readonly refresh: () => Promise<string | null>;
}

/** What the page found in the URL after a connection round trip. */
export interface ConnectHandoff {
  readonly code?: string;
  readonly error?: string;
}

/** Read `#freesound=` / `#freesound_error=` out of a fragment. */
export function handoffFrom(hash: string): ConnectHandoff {
  const code = /[#&]freesound=([^&]+)/.exec(hash)?.[1];
  const error = /[#&]freesound_error=([^&]+)/.exec(hash)?.[1];
  return {
    ...(code === undefined ? {} : { code: decodeURIComponent(code) }),
    ...(error === undefined ? {} : { error: decodeURIComponent(error) }),
  };
}

/** The fragment with both connection parameters removed, `''` when nothing is left. */
export function withoutHandoff(hash: string): string {
  const rest = hash
    .replace(/^#/, '')
    .split('&')
    .filter((part) => part !== '' && !/^freesound(_error)?=/.test(part));
  return rest.length === 0 ? '' : `#${rest.join('&')}`;
}

/** Is this token still good, given the early-refresh margin? */
export function isFresh(tokens: FreesoundTokens, now = Date.now()): boolean {
  return tokens.accessToken !== '' && tokens.expiresAt - EARLY_REFRESH_SECONDS * 1000 > now;
}

/** Turn what the bank returns into what the tab keeps. */
function tokensFrom(body: unknown, now = Date.now()): FreesoundTokens | null {
  const row = (body ?? {}) as Record<string, unknown>;
  const accessToken = typeof row['accessToken'] === 'string' ? row['accessToken'] : '';
  const refreshToken = typeof row['refreshToken'] === 'string' ? row['refreshToken'] : '';
  const expiresIn = typeof row['expiresIn'] === 'number' ? row['expiresIn'] : 0;
  if (accessToken === '' || refreshToken === '') return null;
  /* An unknown lifetime is treated as *already old* rather than as forever: the worst
     case is one extra refresh, where the other worst case is a search that fails. */
  return { accessToken, refreshToken, expiresAt: now + expiresIn * 1000 };
}

export interface FreesoundAuthOptions {
  /** Where the bank is. The connection is offered only when that bank offers it. */
  readonly bankUrl: string;
  readonly fetchImpl?: typeof fetch;
}

export function useFreesoundAuth(options: FreesoundAuthOptions): FreesoundConnection {
  const { bankUrl } = options;
  const [state, setState] = useState<ConnectionState>('unknown');
  const [error, setError] = useState<string | null>(null);

  /** The tokens, behind a ref: a token read must never be one render out of date. */
  const tokens = useRef<FreesoundTokens | null>(null);
  /** One refresh at a time — three simultaneous 401s must not spend three refreshes. */
  const refreshing = useRef<Promise<string | null> | null>(null);
  /**
   * `fetch`, **bound**, and that is not a style choice.
   *
   * A ref holds it, so `call.current(url)` is a method call and `this` is the ref
   * object — which WebIDL rejects with `Illegal invocation`. The failure is silent
   * here, because the probe below treats any throw as "this bank cannot connect
   * anybody", so the symptom was a correctly configured bank reported as unconfigured.
   */
  const call = useRef<typeof fetch>(options.fetchImpl ?? fetch.bind(globalThis));

  /** Hold a connection, or drop one — in the tab and on disk, together. */
  const store = useCallback((next: FreesoundTokens | null): void => {
    tokens.current = next;
    setState(next === null ? 'off' : 'on');
    if (!canRemember) return;
    if (next === null) void keystore.forget(STORED_UNDER);
    else void keystore.save(STORED_UNDER, JSON.stringify(next));
  }, []);

  /* Does this bank offer the connection, and is there one remembered? Both answers are
     needed before the panel can draw anything honest, and neither costs a round trip
     to freesound.org. */
  useEffect(() => {
    let cancelled = false;

    const boot = async (): Promise<void> => {
      let enabled = false;
      try {
        const response = await call.current(`${bankUrl}/api/freesound/config`);
        enabled = response.ok && ((await response.json()) as { enabled?: unknown }).enabled === true;
      } catch {
        /* No bank, or a bank too old to know the route. Either way the tab cannot
           connect anybody, and saying so is the honest state. */
      }
      if (cancelled) return;
      /* Never downgrade what the return trip has already established. Both effects run
         at mount and this one awaits a round trip, so a plain `setState` here lands
         *after* a completed exchange and puts a connected tab back on the button — seen
         the first time the whole flow was walked end to end. */
      if (!enabled) {
        setState((current) => (current === 'on' ? current : 'unavailable'));
        return;
      }

      if (canRemember) {
        const stored = await keystore.load(STORED_UNDER);
        if (cancelled) return;
        if (stored !== null) {
          try {
            const parsed = JSON.parse(stored) as FreesoundTokens;
            if (typeof parsed.refreshToken === 'string' && parsed.refreshToken !== '') {
              tokens.current = parsed;
              setState('on');
              return;
            }
          } catch {
            /* A stored value that no longer parses is indistinguishable from none. */
          }
        }
      }
      setState((current) => (current === 'unknown' ? 'off' : current));
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [bankUrl]);

  /* The return trip. Read and scrub the fragment before anything else happens with it. */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handoff = handoffFrom(window.location.hash);
    if (handoff.code === undefined && handoff.error === undefined) return;

    const cleaned = withoutHandoff(window.location.hash);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${cleaned}`);

    if (handoff.error !== undefined) {
      setError(handoff.error);
      setState((current) => (current === 'connecting' ? 'off' : current));
      return;
    }

    const code = handoff.code ?? '';
    setState('connecting');
    void (async () => {
      try {
        const response = await call.current(`${bankUrl}/api/freesound/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const body: unknown = await response.json();
        const next = response.ok ? tokensFrom(body) : null;
        if (next === null) {
          setError(String((body as { error?: unknown }).error ?? 'exchange-failed'));
          setState('off');
          return;
        }
        setError(null);
        store(next);
      } catch (failure: unknown) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setState('off');
      }
    })();
  }, [bankUrl, store]);

  const refresh = useCallback(async (): Promise<string | null> => {
    const current = tokens.current;
    if (current === null) return null;
    if (refreshing.current !== null) return refreshing.current;

    const run = (async (): Promise<string | null> => {
      try {
        const response = await call.current(`${bankUrl}/api/freesound/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });
        const next = response.ok ? tokensFrom((await response.json()) as unknown) : null;
        if (next === null) {
          /* A refresh token freesound no longer honours is a connection that is over.
             Saying so and showing the button beats retrying forever. */
          store(null);
          setError('expired');
          return null;
        }
        store(next);
        return next.accessToken;
      } catch (failure: unknown) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return null;
      } finally {
        refreshing.current = null;
      }
    })();

    refreshing.current = run;
    return run;
  }, [bankUrl, store]);

  const token = useCallback(async (): Promise<string | null> => {
    const current = tokens.current;
    if (current === null) return null;
    return isFresh(current) ? current.accessToken : refresh();
  }, [refresh]);

  const connect = useCallback(() => {
    if (typeof window === 'undefined') return;
    setError(null);
    setState('connecting');
    const back = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    window.location.href = `${bankUrl}/api/freesound/start?return=${encodeURIComponent(back)}`;
  }, [bankUrl]);

  /**
   * Forget the connection here, completely.
   *
   * Freesound is not told, because there is nothing to tell it: OAuth2 has no "revoke"
   * in this flow, so the honest scope of this button is *this browser*. The tokens go
   * from the tab and from the keystore in one call, and the panel says where the other
   * half of the revocation lives.
   */
  const disconnect = useCallback(() => {
    store(null);
    setError(null);
  }, [store]);

  return {
    state,
    error,
    connect,
    disconnect,
    token,
    refresh,
  };
}
