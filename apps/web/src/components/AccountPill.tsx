/**
 * Who you are to the bank, in the corner of the top bar.
 *
 * Three states and they are genuinely different, so none of them is a spinner:
 *
 * - **no bank, or a solo bank** — nothing is drawn. A personal bank on a laptop has
 *   one writer and no sign-in, and a disabled button explaining that would be an
 *   apology for a feature nobody asked for.
 * - **signed out** — one button, and the label says what signing in *buys*: publishing,
 *   liking and replying. A bare "Sign in" on a page that works fine without one is a
 *   demand with no reason attached.
 * - **signed in** — the handle, the avatar, and the number that actually matters: how
 *   many recipes are left in today's allowance. Somebody who is about to hit a limit
 *   should find out before the write, not from a 429.
 *
 * The avatar is loaded from the provider, which is one third-party request per signed-in
 * session. It is the only one this page makes, it is started by an explicit sign-in, and
 * it fails to a monogram — `referrerPolicy="no-referrer"` so GitHub is not told which
 * page is showing it.
 *
 * @packageDocumentation
 */

import { useState } from 'react';
import type { AccountState } from '../lib/account.js';
import { useI18n } from '../lib/i18n.js';

export interface AccountPillProps {
  readonly state: AccountState;
}

export function AccountPill({ state }: AccountPillProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [broken, setBroken] = useState(false);

  /* `config === null` is "the bank did not answer", which is a normal state for a
     playground with no bank running — and indistinguishable, to a visitor, from a
     bank that has no sign-in. Both draw nothing. */
  if (state.config === null || state.config.mode !== 'github') return null;

  const account = state.account;
  if (account === null) {
    return (
      <button
        type="button"
        className="pill"
        title={t('account.signInTitle', { days: state.config.minAccountAgeDays ?? 30 })}
        disabled={state.busy}
        onClick={state.signIn}
      >
        <span className="mono">{t('account.signIn')}</span>
      </button>
    );
  }

  const left = account.allowances['recipe']?.remaining ?? 0;

  return (
    <div className="account-group">
      <span className="pill pill-ok" title={t('account.standing', { count: account.standing, left })}>
        {account.actor.avatarUrl === '' || broken ? (
          <span className="avatar-fallback">{account.actor.login.slice(0, 1).toUpperCase()}</span>
        ) : (
          <img
            className="avatar"
            src={account.actor.avatarUrl}
            alt=""
            width={16}
            height={16}
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
          />
        )}
        <span className="mono">{account.actor.login}</span>
        <span className="mono faint">{t('account.left', { count: left })}</span>
      </span>
      <button type="button" className="link" disabled={state.busy} onClick={state.signOut}>
        {t('account.signOut')}
      </button>
    </div>
  );
}
