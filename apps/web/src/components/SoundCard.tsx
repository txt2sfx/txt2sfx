/**
 * One sound in the gallery.
 *
 * The card carries four facts and they are ordered by what a person scanning a grid
 * actually uses: the **name**, because that is how it will be referred to; the
 * **category**, because it is the recipe's own claim about what kind of thing this is
 * and the validator enforces it; the **waveform**, which is recognition without
 * reading; and the **prompt**, last and clamped to two lines, because it is the only
 * part that explains *why* the sound exists.
 *
 * Two clickable regions inside one clickable card, which needs care. The card opens
 * the studio, the round button plays without leaving the gallery — auditioning ten
 * candidates should not cost ten navigations — and the trash chip does neither. Both
 * inner controls stop propagation, and the outer element is a `button` so the keyboard
 * gets the same three targets the mouse has.
 *
 * @packageDocumentation
 */

import { Bars } from './Bars.js';
import { catColor, catHue } from '../lib/design.js';
import { ago, ms } from '../lib/format.js';
import { useI18n } from '../lib/i18n.js';
import { useBars } from '../lib/useBars.js';

/** Bars across a card. 44 is about 6 px each at the grid's minimum column width. */
const BAR_COUNT = 44;

export interface SoundCardProps {
  readonly name: string;
  readonly prompt: string;
  readonly source: string;
  readonly category: string | undefined;
  readonly durationMs: number;
  readonly seed: number;
  readonly editedAt: number | undefined;
  readonly trashed: boolean;
  readonly playing: boolean;
  /**
   * The bank's id, when this recipe is published.
   *
   * Everything social hangs off it being present: a recipe in `examples/` or one
   * generated a minute ago has nobody to like it and nothing to discuss, and drawing
   * a hollow heart on it would promise otherwise.
   */
  readonly bankId?: number;
  readonly likes?: number;
  readonly liked?: boolean;
  readonly comments?: number;
  readonly author?: string;
  readonly onOpen: () => void;
  readonly onPlay: () => void;
  readonly onTrash: () => void;
  readonly onLike?: () => void;
  readonly onComments?: () => void;
}

export function SoundCard({
  name,
  prompt,
  source,
  category,
  durationMs,
  seed,
  editedAt,
  trashed,
  playing,
  bankId,
  likes = 0,
  liked = false,
  comments = 0,
  author,
  onLike,
  onComments,
  onOpen,
  onPlay,
  onTrash,
}: SoundCardProps): React.JSX.Element {
  const { t } = useI18n();
  const { values, ready } = useBars(source, seed, BAR_COUNT, name);

  return (
    <button
      type="button"
      className="card"
      /* One number in, every shade of the category out: the stylesheet derives the
         border, the badge, the hover and the play button from `--hue`, so a new
         category needs a line in `design.ts` and nothing here. */
      style={{ ['--hue' as string]: String(catHue(category)) }}
      onClick={onOpen}
    >
      <div className="card-head">
        <span className="mono card-name">{name}</span>
        <span className="cat">{category ?? 'misc'}</span>
        <div className="spacer" />
        <span className="mono faint">{ms(durationMs)}</span>
        <span
          role="button"
          tabIndex={0}
          className="chip-danger"
          title={trashed ? t('card.restoreTitle') : t('card.trashTitle')}
          onClick={(event) => {
            event.stopPropagation();
            onTrash();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.stopPropagation();
            event.preventDefault();
            onTrash();
          }}
        >
          {trashed ? t('card.restore') : t('card.trash')}
        </span>
      </div>

      <div className="card-body">
        <span
          role="button"
          tabIndex={0}
          className="play-round"
          title={playing ? t('card.stop') : t('card.play')}
          onClick={(event) => {
            event.stopPropagation();
            onPlay();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.stopPropagation();
            event.preventDefault();
            onPlay();
          }}
        >
          {playing ? '❚❚' : '▶'}
        </span>
        <Bars
          values={values}
          muted={!ready}
          playing={playing}
          durationMs={durationMs}
          className="bars-card"
          color={catColor(category, 0.7, 0.115)}
        />
      </div>

      <p className="card-prompt">{prompt === '' ? <span className="faint">{t('card.noPrompt')}</span> : prompt}</p>

      {/* The social row exists only for a published recipe, and it says who made it —
          a like is worth having because it is attached to a name. */}
      {bankId === undefined ? null : (
        <div className="card-social">
          <span
            role="button"
            tabIndex={0}
            className={`chip-social${liked ? ' on' : ''}`}
            title={liked ? t('card.unlikeTitle') : t('card.likeTitle')}
            onClick={(event) => {
              event.stopPropagation();
              onLike?.();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.stopPropagation();
              event.preventDefault();
              onLike?.();
            }}
          >
            {liked ? '♥' : '♡'} {likes}
          </span>
          <span
            role="button"
            tabIndex={0}
            className="chip-social"
            title={t('card.commentsTitle')}
            onClick={(event) => {
              event.stopPropagation();
              onComments?.();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.stopPropagation();
              event.preventDefault();
              onComments?.();
            }}
          >
            ✎ {comments}
          </span>
          {author === undefined ? null : <span className="mono faint card-author">@{author}</span>}
        </div>
      )}

      {editedAt === undefined ? null : (
        <div className="mono card-edited">{t('card.edited', { when: ago(editedAt) })}</div>
      )}
    </button>
  );
}
