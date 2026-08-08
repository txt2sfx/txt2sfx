/**
 * The thread on one recipe — and the reason the whole feature exists.
 *
 * ## A reply can be a sound
 *
 * The form has two fields: a sentence, and an optional soundline. `Reply with a
 * version` fills the second with the recipe as published, so disagreeing means editing
 * the thing you disagree with — "your gate, 40 ms off the tail" arrives as something
 * that can be pressed and heard rather than as a description of a sound nobody made.
 * The server holds an attached soundline to exactly what it holds a published recipe
 * to: it parses, validates and renders, or it is refused with the rule that refused it.
 *
 * That is also why the form is hard for a spammer to use: the valuable half of it
 * requires the grammar, and the other half cannot contain a link.
 *
 * ## The link rule is stated before it is enforced
 *
 * The hint under the box says comments carry no links and that `#12` refers to a
 * recipe. A rule discovered by having a comment rejected reads as a bug; a rule read
 * before typing reads as a rule.
 *
 * ## Why a dialog
 *
 * The gallery card is a `<button>`, and a form inside a button is invalid HTML and
 * behaves like it. A dialog also matches what a thread is for: something to open on
 * one sound, read, answer and close — not a permanent column beside a grid.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useState } from 'react';
import type { RecipeComment } from '@txt2sfx/shared';
import type { AccountState } from '../lib/account.js';
import { BankError, type BankClient } from '../lib/bank.js';
import { ago } from '../lib/format.js';
import { useI18n } from '../lib/i18n.js';

export interface CommentsDialogProps {
  readonly bank: BankClient;
  readonly account: AccountState;
  /** The bank recipe being discussed. */
  readonly recipe: { readonly id: number; readonly name: string; readonly soundline: string };
  readonly onClose: () => void;
  /** Play an attached soundline without leaving the thread. */
  readonly onPlay: (name: string, source: string) => void;
  /** Open an attached soundline in the studio, which is where it can be worked on. */
  readonly onOpen: (name: string, source: string) => void;
}

export function CommentsDialog({
  bank,
  account,
  recipe,
  onClose,
  onPlay,
  onOpen,
}: CommentsDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [comments, setComments] = useState<readonly RecipeComment[] | null>(null);
  const [body, setBody] = useState('');
  const [attached, setAttached] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bank.comments(recipe.id).then((thread) => {
      if (!cancelled) setComments(thread);
    });
    return () => {
      cancelled = true;
    };
  }, [bank, recipe.id]);

  /* Escape closes, because a dialog that can only be dismissed with the mouse is a
     dialog that traps whoever opened it from the keyboard. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = useCallback(
    async (event: React.FormEvent): Promise<void> => {
      event.preventDefault();
      if (sending) return;
      setSending(true);
      setError(null);
      try {
        const posted = await bank.comment(recipe.id, body, attached ?? undefined);
        setComments((thread) => [...(thread ?? []), posted]);
        setBody('');
        setAttached(null);
        /* The allowance just moved, and the header shows it. */
        account.refresh();
      } catch (cause) {
        setError(cause instanceof BankError ? cause.message : String(cause));
      } finally {
        setSending(false);
      }
    },
    [account, attached, bank, body, recipe.id, sending],
  );

  const canWrite = account.config?.mode !== 'github' || account.account !== null;

  return (
    <div className="scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('comments.title', { name: recipe.name })}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <span className="mono">{t('comments.title', { name: recipe.name })}</span>
          <div className="spacer" />
          <button type="button" className="link" onClick={onClose}>
            {t('comments.close')}
          </button>
        </div>

        <div className="thread">
          {comments === null ? <p className="faint">{t('comments.loading')}</p> : null}
          {comments !== null && comments.length === 0 ? <p className="faint">{t('comments.empty')}</p> : null}
          {(comments ?? []).map((comment) => (
            <article className="comment" key={comment.id}>
              <header>
                <span className="mono">{comment.author.login}</span>
                <span className="mono faint">{ago(Date.parse(comment.createdAt))}</span>
              </header>
              {comment.body === '' ? null : <p>{comment.body}</p>}
              {comment.soundline === undefined ? null : (
                <div className="comment-sound">
                  <button
                    type="button"
                    className="play-round small"
                    title={t('card.play')}
                    onClick={() => onPlay(`${recipe.name} · ${comment.author.login}`, comment.soundline ?? '')}
                  >
                    ▶
                  </button>
                  <pre className="mono">{comment.soundline}</pre>
                  <button
                    type="button"
                    className="link"
                    onClick={() => onOpen(`${recipe.name}-${comment.author.login}`, comment.soundline ?? '')}
                  >
                    {t('comments.openInStudio')}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>

        {canWrite ? (
          <form className="comment-form" onSubmit={(event) => void send(event)}>
            <textarea
              value={body}
              rows={3}
              maxLength={500}
              placeholder={t('comments.placeholder')}
              aria-label={t('comments.placeholder')}
              onChange={(event) => setBody(event.target.value)}
            />
            {attached === null ? (
              <button type="button" className="link" onClick={() => setAttached(recipe.soundline)}>
                {t('comments.attach')}
              </button>
            ) : (
              <div className="attached">
                <textarea
                  className="mono"
                  value={attached}
                  rows={6}
                  aria-label={t('comments.attachedAria')}
                  onChange={(event) => setAttached(event.target.value)}
                />
                <button type="button" className="link" onClick={() => setAttached(null)}>
                  {t('comments.detach')}
                </button>
              </div>
            )}
            <p className="faint small">{t('comments.rule')}</p>
            {error === null ? null : <p className="bad">{error}</p>}
            <button type="submit" className="primary" disabled={sending || (body.trim() === '' && attached === null)}>
              {sending ? t('comments.sending') : t('comments.send')}
            </button>
          </form>
        ) : (
          <div className="comment-form">
            <p className="faint">{t('comments.signInFirst')}</p>
            <button type="button" className="primary" onClick={account.signIn}>
              {t('account.signIn')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
