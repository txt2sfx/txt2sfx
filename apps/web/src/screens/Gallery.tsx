/**
 * The catalog, and the front door.
 *
 * ## Why the prompt box is here and not only in the studio
 *
 * The previous playground opened on an editor with a recipe already loaded, which
 * answers the question "what is this" with "a text editor for something". The first
 * thing on screen should be the claim the project actually makes — *describe a sound,
 * get code that plays it* — and a box to test it with. So the hero is one sentence and
 * one input, and pressing Generate hands the prompt to the studio and starts the run
 * there, because that is where the answer needs somewhere to land.
 *
 * ## Why search and category filters, over twelve recipes
 *
 * Because twelve is the starting number. The gallery merges three stores — this
 * session's generated sounds, `examples/` on disk, and whatever a running bank holds —
 * and the bank is the one that grows without bound. Building the filters at twelve
 * recipes rather than at two hundred is the cheap moment to do it, and the category
 * chips do a second job at any size: they are the vocabulary the validator enforces,
 * so seeing them as the axis of the catalog teaches what `pop` and `cycle` mean here.
 *
 * ## The empty state has a button
 *
 * A search that matches nothing is not a dead end in a tool whose whole point is
 * making the thing that is missing. `Generate it instead` takes the query as the
 * prompt, which is almost always what the person typing it wanted.
 *
 * @packageDocumentation
 */

import { useMemo } from 'react';
import { SOUND_CATEGORIES } from '@txt2sfx/shared';
import { SoundCard } from '../components/SoundCard.js';
import { Bars } from '../components/Bars.js';
import type { Origin } from '../lib/catalog.js';
import { catHue } from '../lib/design.js';
import { useI18n, type Key } from '../lib/i18n.js';
import { ghostBars } from '../lib/layers.js';

/** A gallery row, with everything the card needs already derived. */
export interface GalleryItem {
  readonly name: string;
  readonly source: string;
  readonly prompt: string;
  readonly category: string | undefined;
  readonly durationMs: number;
  /* The catalog's own union, not a copy of it: a second spelling of the same set
     is how an added origin gets a dead branch somewhere instead of a type error. */
  readonly origin: Origin;
  readonly editedAt: number | undefined;
  readonly trashed: boolean;
  /** Present only for a recipe that lives in the bank — see {@link SoundCard}. */
  readonly bankId?: number;
  readonly likes?: number;
  readonly liked?: boolean;
  readonly comments?: number;
  readonly author?: string;
}

export interface GalleryProps {
  readonly items: readonly GalleryItem[];
  readonly seed: number;
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  readonly onGenerate: (prompt: string) => void;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly filter: string;
  readonly onFilterChange: (filter: string) => void;
  /**
   * The bank entries in `items` are the *answer to `query`*, not a plain listing.
   *
   * When they are, they must not be filtered again here: the server matched them on
   * prompts and tags through its FTS index, and neither of those is inside the
   * `name + source` this screen can see — so re-applying the substring test would throw
   * away most of what was found. Everything else in the list is local and keeps being
   * filtered locally.
   */
  readonly serverFiltered: boolean;
  /**
   * Offer every category, not only the ones on screen.
   *
   * True when a bank is answering, because then a chip is a *query* and the category it
   * names is almost certainly in the bank even when nothing listed right now carries it.
   * Offline it stays false and the row shows only what the bundle contains, which is the
   * rule that keeps it from becoming a menu of dead ends.
   */
  readonly allCategories: boolean;
  /**
   * Something on this page can write a new recipe.
   *
   * False with no agent and no key, and then the two buttons that start a run say
   * `Find in bank` instead of `Generate` — the run will search the catalog rather than
   * generate anything, and a button that claimed otherwise is exactly the confusion
   * `lib/retrieval.ts` exists to avoid.
   */
  readonly canGenerate: boolean;
  readonly onboarded: boolean;
  readonly onDismissOnboarding: () => void;
  readonly playing: string | null;
  readonly onOpen: (name: string) => void;
  readonly onPlay: (name: string) => void;
  readonly onTrash: (name: string) => void;
  /** Like or unlike a published recipe. Absent when there is no bank to ask. */
  readonly onLike: (item: GalleryItem) => void;
  readonly onComments: (item: GalleryItem) => void;
}

/** The three steps, which is the whole of the product in eleven words. */
const STEPS: readonly Key[] = ['gallery.step1', 'gallery.step2', 'gallery.step3'];

export function Gallery({
  items,
  seed,
  prompt,
  onPromptChange,
  onGenerate,
  query,
  onQueryChange,
  filter,
  onFilterChange,
  serverFiltered,
  allCategories,
  canGenerate,
  onboarded,
  onDismissOnboarding,
  playing,
  onOpen,
  onPlay,
  onTrash,
  onLike,
  onComments,
}: GalleryProps): React.JSX.Element {
  const { t } = useI18n();
  const trashedCount = items.filter((item) => item.trashed).length;

  /* Filtering by category *and* by trash through one control, because they are the
     same question — "which subset of the catalog am I looking at" — and two controls
     would let the user ask for the trash of one category, which nobody wants. */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (item: GalleryItem): boolean =>
      needle === '' ||
      /* A bank row that arrived *because* of this query has already been matched, by an
         index that can see prompts and tags. Testing it again against the text this
         screen happens to hold would drop most of the answer. */
      (serverFiltered && item.origin === 'bank') ||
      item.name.toLowerCase().includes(needle) ||
      item.prompt.toLowerCase().includes(needle) ||
      item.source.toLowerCase().includes(needle);

    return items.filter((item) => {
      if (filter === 'trash') return item.trashed && matches(item);
      if (item.trashed) return false;
      return (filter === 'all' || item.category === filter) && matches(item);
    });
  }, [items, filter, query, serverFiltered]);

  /* With a bank answering, every category is a live question and the chip row is the
     vocabulary. Offline it is only the categories the catalog actually contains, plus
     whichever is selected so the chip you clicked cannot vanish under you — a row of
     nine chips where six match nothing is a menu of dead ends. */
  const categories = useMemo(() => {
    if (allCategories) return SOUND_CATEGORIES;
    const present = new Set(items.filter((item) => !item.trashed).map((item) => item.category));
    return SOUND_CATEGORIES.filter((category) => present.has(category) || filter === category);
  }, [items, filter, allCategories]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (prompt.trim() !== '') onGenerate(prompt.trim());
  };

  return (
    <div className="screen screen-gallery">
      <section className="hero">
        <div className="wrap">
          <h1>{t('gallery.title')}</h1>
          <p className="lede">{t('gallery.lede')}</p>

          <form className="hero-row" onSubmit={submit}>
            <div className="input-shell accent">
              <span className="mono caret">&gt;</span>
              <input
                type="text"
                name="prompt"
                className="mono"
                value={prompt}
                placeholder={t('gallery.placeholder')}
                aria-label={t('gallery.describeAria')}
                onChange={(event) => onPromptChange(event.target.value)}
              />
            </div>
            {/* The label is the truth about what the press does, here as much as in the
                studio's row: with nothing able to write a recipe this box searches the
                catalog, and calling that Generate is the one thing retrieval must never
                do. See `lib/retrieval.ts`. */}
            <button type="submit" className="primary big" disabled={prompt.trim() === ''}>
              {t(canGenerate ? 'gallery.generate' : 'gallery.find')}
            </button>
          </form>

          {onboarded ? null : (
            <div className="onboard">
              {STEPS.map((step, index) => (
                <div className="onboard-step" key={step}>
                  <span className="step-n">{index + 1}</span>
                  <span>{t(step)}</span>
                </div>
              ))}
              <div className="spacer" />
              <button type="button" className="link" onClick={onDismissOnboarding}>
                {t('gallery.gotIt')}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="catalog">
        <div className="wrap">
          <div className="filters">
            <div className="input-shell small">
              <span className="faint">⌕</span>
              <input
                type="search"
                name="search"
                value={query}
                placeholder={t('gallery.searchPlaceholder')}
                aria-label={t('gallery.searchAria')}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </div>

            <div className="chips">
              <button
                type="button"
                className={`chip${filter === 'all' ? ' selected' : ''}`}
                onClick={() => onFilterChange('all')}
              >
                {t('gallery.all')}
              </button>
              {categories.map((category) => (
                <button
                  type="button"
                  key={category}
                  className={`chip cat-chip${filter === category ? ' selected' : ''}`}
                  style={{ ['--hue' as string]: String(catHue(category)) }}
                  onClick={() => onFilterChange(category)}
                >
                  {category}
                </button>
              ))}
              <button
                type="button"
                className={`chip chip-quiet${filter === 'trash' ? ' selected' : ''}`}
                onClick={() => onFilterChange(filter === 'trash' ? 'all' : 'trash')}
              >
                {t('gallery.trash')} · {trashedCount}
              </button>
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="empty">
              <Bars values={ghostBars('empty', 30)} className="bars-ghost" />
              <p>
                {query.trim() === ''
                  ? filter === 'trash'
                    ? t('gallery.emptyTrash')
                    : t('gallery.emptyCategory', { category: filter })
                  : t('gallery.emptyQuery', { query: query.trim() })}
              </p>
              {query.trim() === '' ? null : (
                <button type="button" className="primary" onClick={() => onGenerate(query.trim())}>
                  {t(canGenerate ? 'gallery.generateInstead' : 'gallery.findInstead')}
                </button>
              )}
            </div>
          ) : (
            <div className="grid">
              {visible.map((item) => (
                <SoundCard
                  key={item.name}
                  name={item.name}
                  prompt={item.prompt}
                  source={item.source}
                  category={item.category}
                  durationMs={item.durationMs}
                  seed={seed}
                  editedAt={item.editedAt}
                  trashed={item.trashed}
                  playing={playing === item.name}
                  {...(item.bankId === undefined ? {} : { bankId: item.bankId })}
                  {...(item.likes === undefined ? {} : { likes: item.likes })}
                  {...(item.liked === undefined ? {} : { liked: item.liked })}
                  {...(item.comments === undefined ? {} : { comments: item.comments })}
                  {...(item.author === undefined ? {} : { author: item.author })}
                  onOpen={() => onOpen(item.name)}
                  onPlay={() => onPlay(item.name)}
                  onTrash={() => onTrash(item.name)}
                  onLike={() => onLike(item)}
                  onComments={() => onComments(item)}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
