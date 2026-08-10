/**
 * One sound in the gallery.
 *
 * The card carries four facts and they are ordered by what a person scanning a grid
 * actually uses: the **name**, because that is how it will be referred to; the
 * **category**, because it is the recipe's own claim about what kind of thing this is
 * and the validator enforces it; the **waveform**, which is recognition without
 * reading; and the **prompt**, last and clamped to a single line with the rest of it in
 * the tooltip, because it is the only part that explains *why* the sound exists and the
 * card is still a grid cell.
 *
 * ## The card is not a button any more
 *
 * It used to be one, with the play glyph and a chip beside the name as `role="button"` spans
 * inside it stopping propagation — the only way to put controls inside a control
 * without nesting `<button>` in `<button>`, which is invalid. That bought one large
 * click target and cost every other affordance on the card its obviousness: a card
 * whose whole surface navigates has no way to say *which* of its parts do something
 * else, and the two that did had to be discovered.
 *
 * So the surface is inert and **Open** is a button of its own. The round glyph still
 * plays without leaving the gallery — auditioning ten candidates should not cost ten
 * navigations — and with no outer click to swallow, every control here is a real
 * `<button>`: no propagation to stop, no hand-written `keydown` to reimplement what the
 * element already does.
 *
 * ## Why a card can be downloaded without being opened
 *
 * For the same reason it can be played without being opened. Somebody who came looking
 * for a door slam, found one and wants the file has no business in the editor, and the
 * three clicks through the studio to get there were three clicks spent proving the
 * catalog is not a catalog. The recipe is compiled or rendered at the moment a format is
 * picked (`downloadRecipe`), so the shortcut costs a card nothing until it is used.
 *
 * @packageDocumentation
 */

import { useState } from 'react';
import { Bars } from './Bars.js';
import { DownloadMenu } from './FormatMenu.js';
import { IconPause, IconPlay, IconStar } from './Icons.js';
import { catColor, catHue } from '../lib/design.js';
import type { Format } from '../lib/download.js';
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
  readonly favorite: boolean;
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
  /**
   * Star this recipe, or take the star back.
   *
   * The star is per browser and per name (`lib/library.ts`), not a bank rating — the
   * heart in the social row is the one other people see. This one answers "the four I
   * keep coming back to", which is what the studio's Favourites tab lists.
   */
  readonly onFavorite: () => void;
  /** Hand this recipe over in one format. Async — MP3 and M4A are encoded. */
  readonly onDownload: (format: Format) => Promise<unknown> | void;
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
  favorite,
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
  onFavorite,
  onDownload,
}: SoundCardProps): React.JSX.Element {
  const { t } = useI18n();
  const { values, ready } = useBars(source, seed, BAR_COUNT, name);
  /* The card clips its own contents — rounded corners, a waveform drawn to the edge —
     so the format popover has to be let out for as long as it is open. */
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <article
      className={`card${menuOpen ? ' menu-open' : ''}`}
      /* One number in, every shade of the category out: the stylesheet derives the
         border, the badge, the hover and the play button from `--hue`, so a new
         category needs a line in `design.ts` and nothing here. */
      style={{ ['--hue' as string]: String(catHue(category)) }}
    >
      <div className="card-head">
        <span className="mono card-name">{name}</span>
        <span className="cat">{category ?? 'misc'}</span>
        <div className="spacer" />
        <span className="mono faint">{ms(durationMs)}</span>
        {/* Where the trash chip used to be, doing the opposite job. A star is a mark,
            not an edit: nothing about the recipe changes, and the only thing that reads
            it is the studio's Favourites tab. */}
        <button
          type="button"
          className={`star${favorite ? ' on' : ''}`}
          title={t(favorite ? 'card.unfavorite' : 'card.favorite')}
          aria-pressed={favorite}
          onClick={onFavorite}
        >
          <IconStar size={13} on={favorite} />
        </button>
      </div>

      <div className="card-body">
        <button
          type="button"
          className="play-round"
          title={playing ? t('card.stop') : t('card.play')}
          onClick={onPlay}
        >
          {playing ? <IconPause size={13} /> : <IconPlay size={13} />}
        </button>
        <Bars
          values={values}
          muted={!ready}
          playing={playing}
          durationMs={durationMs}
          className="bars-card"
          color={catColor(category, 0.7, 0.115)}
        />
      </div>

      {/* The social row exists only for a published recipe, and it says who made it —
          a like is worth having because it is attached to a name. */}
      {bankId === undefined ? null : (
        <div className="card-social">
          <button
            type="button"
            className={`chip-social${liked ? ' on' : ''}`}
            title={liked ? t('card.unlikeTitle') : t('card.likeTitle')}
            onClick={() => onLike?.()}
          >
            {liked ? '♥' : '♡'} {likes}
          </button>
          <button
            type="button"
            className="chip-social"
            title={t('card.commentsTitle')}
            onClick={() => onComments?.()}
          >
            ✎ {comments}
          </button>
          {author === undefined ? null : <span className="mono faint card-author">@{author}</span>}
        </div>
      )}

      {/* The last row carries the prompt *and* the two controls that leave the gallery,
          because a paragraph of its own was costing every card a line of height for text
          that is clamped to one line anyway. The prompt takes the slack and ellipses; the
          edit time and the buttons are fixed width beside it. Download is a glyph and
          Open is a word — a card is browsed for a sound to work on far more often than
          for a file to take, and the row should read that way. */}
      <div className="card-actions">
        <p className="card-prompt" title={prompt === '' ? undefined : prompt}>
          {prompt === '' ? <span className="faint">{t('card.noPrompt')}</span> : prompt}
        </p>
        {editedAt === undefined ? null : (
          <span className="mono card-edited">{t('card.edited', { when: ago(editedAt) })}</span>
        )}
        <DownloadMenu
          onDownload={onDownload}
          onOpenChange={setMenuOpen}
          title={t('card.downloadTitle', { name })}
        />
        <button type="button" className="card-open" onClick={onOpen} title={t('card.openTitle')}>
          {t('card.open')}
        </button>
      </div>
    </article>
  );
}
