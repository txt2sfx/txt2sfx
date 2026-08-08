/**
 * Being signed in to the bank, from the page's side.
 *
 * ## The token is a secret, so it is not in `localStorage`
 *
 * The project's rule is that `localStorage` holds preferences and unsaved work and
 * never a secret. A session token is a secret — anybody holding it can publish and
 * comment as its owner until it expires — so it goes where the API key goes: encrypted
 * under a non-extractable `CryptoKey` in IndexedDB (`lib/keystore.ts` documents exactly
 * what that does and does not protect against). Where the keystore is unavailable, the
 * token lives in the tab and sign-in simply does not survive a reload, which is a worse
 * experience and not a worse promise.
 *
 * ## The hand-off, and why the hash is scrubbed
 *
 * The bank sends the browser back with `#signin=<one-time code>`. The code is traded
 * for the token over `POST` and is worthless afterwards — but leaving it in the address
 * bar would put it in history and in the next screenshot, so the fragment is rewritten
 * with `replaceState` the moment it is read, before the exchange even happens.
 *
 * A failed sign-in comes back as `#signin_error=<code>`, which is turned into a
 * sentence here rather than shown raw: `account-too-new` is the one people will
 * actually hit, and "your GitHub account is too new" is the difference between a rule
 * and a bug.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BankAccount, BankAuthConfig, BankClient } from './bank.js';
import { BankError } from './bank.js';
import { canRemember, keystore } from './keystore.js';
import { t } from './i18n.js';

/** The keystore entry the session lives under. */
const STORED_UNDER = 'bank-session';

/** What the page found in the URL after a sign-in round trip. */
export interface SignInHandoff {
  readonly code?: string;
  readonly error?: string;
}

/**
 * Read `#signin=` / `#signin_error=` out of a fragment.
 *
 * Tolerant, like `share.ts`: a mangled fragment must produce "no sign-in happened"
 * and an ordinary playground, never a broken page.
 */
export function handoffFrom(hash: string): SignInHandoff {
  const code = /[#&]signin=([^&]+)/.exec(hash)?.[1];
  const error = /[#&]signin_error=([^&]+)/.exec(hash)?.[1];
  return {
    ...(code === undefined ? {} : { code: decodeURIComponent(code) }),
    ...(error === undefined ? {} : { error: decodeURIComponent(error) }),
  };
}

/** The fragment with both sign-in parameters removed, `''` when nothing is left. */
export function withoutHandoff(hash: string): string {
  const rest = hash
    .replace(/^#/, '')
    .split('&')
    .filter((part) => part !== '' && !part.startsWith('signin=') && !part.startsWith('signin_error='));
  return rest.length === 0 ? '' : `#${rest.join('&')}`;
}

/** A sign-in failure as a sentence. Unknown codes keep their code — it is a clue. */
export function signInMessage(code: string): string {
  if (code === 'account-too-new') return t('account.errorTooNew');
  if (code === 'banned') return t('account.errorBanned');
  if (code === 'cancelled') return t('account.errorCancelled');
  return t('account.errorGeneric', { code });
}

/** Everything the UI needs to know about being signed in. */
export interface AccountState {
  /** `null` until the bank has been asked, then the mode it runs in. */
  readonly config: BankAuthConfig | null;
  /** `null` when nobody is signed in. */
  readonly account: BankAccount | null;
  /** The last thing that happened, for the status line. */
  readonly notice: string | null;
  readonly busy: boolean;
  signIn(): void;
  signOut(): void;
  /** Re-read the allowances, after a write spent one. */
  refresh(): void;
}

/**
 * Sign-in, as a hook.
 *
 * The token is held in a ref rather than in state and handed to the client through a
 * getter (see `BankClientOptions.token`): the client is memoized for the lifetime of
 * the tab, and rebuilding it on every sign-in would re-run every effect keyed on it —
 * including the one that lists the gallery.
 *
 * @param bank - The client, built with `token: () => tokenRef.current`.
 * @param tokenRef - The same ref that getter reads.
 */
export function useAccount(
  bank: BankClient,
  tokenRef: React.MutableRefObject<string | null>,
): AccountState {
  const [config, setConfig] = useState<BankAuthConfig | null>(null);
  const [account, setAccount] = useState<BankAccount | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const claimed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void bank.authConfig().then((answer) => {
      if (!cancelled) setConfig(answer);
    });
    return () => {
      cancelled = true;
    };
  }, [bank]);

  /* One effect for both ways a session appears: coming back from the provider, and
     finding one this browser already had. The hand-off wins — somebody who just
     pressed "sign in" means to sign in as whoever they just authorized. */
  useEffect(() => {
    let cancelled = false;

    const adopt = async (token: string, remember: boolean): Promise<void> => {
      tokenRef.current = token;
      if (remember && canRemember) await keystore.save(STORED_UNDER, token).catch(() => undefined);
      const who = await bank.me();
      if (!cancelled) setAccount(who);
    };

    const run = async (): Promise<void> => {
      if (!claimed.current) {
        claimed.current = true;
        const handoff = handoffFrom(window.location.hash);
        if (handoff.code !== undefined || handoff.error !== undefined) {
          /* Scrubbed first, exchanged second: the code is single-use, but a value in
             the address bar outlives the tab in screenshots and in history. */
          const rest = withoutHandoff(window.location.hash);
          window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${rest}`);
        }
        if (handoff.error !== undefined) {
          setNotice(signInMessage(handoff.error));
          return;
        }
        if (handoff.code !== undefined) {
          setBusy(true);
          try {
            const session = await bank.exchange(handoff.code);
            await adopt(session.token, true);
            if (!cancelled) setNotice(t('account.signedInAs', { login: session.actor.login }));
          } catch (error) {
            if (!cancelled) setNotice(error instanceof BankError ? error.message : String(error));
          } finally {
            if (!cancelled) setBusy(false);
          }
          return;
        }
      }

      if (tokenRef.current === null && canRemember) {
        const stored = await keystore.load(STORED_UNDER).catch(() => null);
        if (stored !== null) await adopt(stored, false);
        return;
      }
      if (tokenRef.current !== null) {
        const who = await bank.me();
        if (!cancelled) setAccount(who);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [bank, tokenRef, nonce]);

  const signIn = useCallback(() => {
    /* Back to exactly this page, fragment and all — someone signing in from a shared
       recipe should land on that recipe, not on the front door. */
    const returnTo = `${window.location.origin}${window.location.pathname}${window.location.search}${withoutHandoff(window.location.hash)}`;
    window.location.assign(bank.signInUrl(returnTo));
  }, [bank]);

  const signOut = useCallback(() => {
    setBusy(true);
    void bank.signOut().finally(() => {
      tokenRef.current = null;
      void keystore.forget(STORED_UNDER).catch(() => undefined);
      setAccount(null);
      setBusy(false);
      setNotice(t('account.signedOut'));
    });
  }, [bank, tokenRef]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  return { config, account, notice, busy, signIn, signOut, refresh };
}
