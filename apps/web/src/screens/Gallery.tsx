/**
 * The catalog, and the front door.
 *
 * ## One box, and it searches
 *
 * The hero used to carry a second input — a prompt with a Generate button beside the
 * search below it — and two boxes on one screen is two boxes to choose between before
 * knowing what either does. They also answered the same intent from opposite ends:
 * somebody who wants a door slam wants the one that already exists if there is one, and
 * a run costs a model call and a fit. So the hero is the search, at hero size, and
 * generating is what the empty state offers when the catalog has nothing — the point
 * below where searching has actually failed. The studio keeps its own prompt row, which
 * is where a run has somewhere to land.
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
 * ## Why freesound.org answers the same box
 *
 * Because it is the same question. Somebody who types `door slam` wants a door slam,
 * and "does one already exist" has two indexes that can answer it: this project's bank
 * of recipes and a public library of two hundred thousand recordings. Asking that twice,
 * in two places, on two screens, was the arrangement that made the library feel like a
 * separate application bolted to the side — so the search box is one box, and the
 * library's answer is a second block under the catalog's.
 *
 * It is a *second block* rather than rows mixed into the grid, and that distinction is
 * the honest one this screen exists to make: a recipe is a few hundred bytes of
 * JavaScript you can ship, and a recording is somebody else's file under somebody else's
 * licence. Sorting them into one list would be claiming they are the same kind of thing.
 * So the block carries its own heading, its own licence chips and its own caption, and
 * the one verb on a row is `→ B` — take it into the studio as a target.
 *
 * Nothing is asked of freesound.org until an account is connected, which is what the
 * button beside the search box is for, and nothing is asked *unprompted* even then: the
 * search fires behind the same debounce the bank's does, one step further out, because
 * it is a request to another company's servers on somebody else's rate limit.
 *
 * @packageDocumentation
 */

import { useMemo } from 'react';
import { SOUND_CATEGORIES } from '@txt2sfx/shared';
import { SoundCard } from '../components/SoundCard.js';
import { Bars } from '../components/Bars.js';
import { FreesoundButton, FreesoundResults } from '../components/Freesound.js';
import type { Origin } from '../lib/catalog.js';
import { catHue } from '../lib/design.js';
import { downloadRecipe } from '../lib/download.js';
import type { FreesoundSound } from '../lib/freesound.js';
import { useI18n, type Key } from '../lib/i18n.js';
import { ghostBars } from '../lib/layers.js';
import type { LibrarySearch } from '../lib/useSearch.js';

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
  readonly favorite: boolean;
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
  /**
   * Start a run from this screen.
   *
   * Reachable in one place now — the empty state — and always with the query as the
   * prompt, which is what the person who typed it wanted when the catalog came back
   * with nothing.
   */
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
   * False with no agent and no key, and then the empty state's button says `Find one in
   * the bank instead` rather than `Generate it instead` — the run will search the
   * catalog rather than generate anything, and a button that claimed otherwise is
   * exactly the confusion `lib/retrieval.ts` exists to avoid.
   */
  readonly canGenerate: boolean;
  readonly onboarded: boolean;
  readonly onDismissOnboarding: () => void;
  readonly playing: string | null;
  readonly onOpen: (name: string) => void;
  readonly onPlay: (name: string) => void;
  /** Star a recipe, or take the star back. Per browser — see `lib/library.ts`. */
  readonly onFavorite: (name: string) => void;
  /** Like or unlike a published recipe. Absent when there is no bank to ask. */
  readonly onLike: (item: GalleryItem) => void;
  readonly onComments: (item: GalleryItem) => void;

  /* --- the library ------------------------------------------------------- */

  /**
   * The freesound.org search, driven by this screen's own box.
   *
   * Handed in rather than owned here for the reason `lib/useSearch.ts` gives: the one
   * thing a result is *for* is `→ B`, which opens the studio, so a list that lived in
   * this component would die at the moment it became useful.
   */
  readonly search: LibrarySearch;
  /** Make this recording the B side: fetch its preview, decode it, open Compare on it. */
  readonly onUseSound: (sound: FreesoundSound) => Promise<void>;
  /**
   * The app's toast — every download on this screen reports through it.
   *
   * Both kinds: the library's fetched files, and a card's own export, which is compiled
   * or rendered on the spot and can therefore fail on a recipe the catalog still lists.
   */
  readonly onStatus: (message: string) => void;
}

/** The three steps, which is the whole of the product in eleven words. */
const STEPS: readonly Key[] = ['gallery.step1', 'gallery.step2', 'gallery.step3'];

export function Gallery({
  items,
  seed,
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
  onFavorite,
  onLike,
  onComments,
  search,
  onUseSound,
  onStatus,
}: GalleryProps): React.JSX.Element {
  const { t } = useI18n();
  const favoriteCount = items.filter((item) => item.favorite).length;

  /* Filtering by category *and* by star through one control, because they are the
     same question — "which subset of the catalog am I looking at" — and two controls
     would let the user ask for the favourites of one category, which nobody wants. */
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
      if (filter === 'favorites') return item.favorite && matches(item);
      return (filter === 'all' || item.category === filter) && matches(item);
    });
  }, [items, filter, query, serverFiltered]);

  /* With a bank answering, every category is a live question and the chip row is the
     vocabulary. Offline it is only the categories the catalog actually contains, plus
     whichever is selected so the chip you clicked cannot vanish under you — a row of
     nine chips where six match nothing is a menu of dead ends. */
  const categories = useMemo(() => {
    if (allCategories) return SOUND_CATEGORIES;
    const present = new Set(items.map((item) => item.category));
    return SOUND_CATEGORIES.filter((category) => present.has(category) || filter === category);
  }, [items, filter, allCategories]);

  return (
    <div className="screen screen-gallery">
      <section className="hero">
        <div className="wrap">
          <h1>{t('gallery.title')}</h1>
          <p className="lede">{t('gallery.lede')}</p>

          {/* No form around it, deliberately: the list is already answering every
              keystroke — the bank behind a debounce, the bundle immediately — so there
              is nothing left for Enter to submit, and a form would give it a page
              reload as its default action. */}
          <div className="hero-row">
            <div className="input-shell accent hero-search">
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

            {/* Beside the box rather than under the results, because it is a property of
                the session and not of this query: connected, the same box answers twice
                for as long as the connection lasts. */}
            <FreesoundButton connection={search.connection} />
          </div>

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
            {/* The chips only — the box that used to sit beside them is the hero now.
                They are still the same control as the search: one question, "which
                subset am I looking at", asked twice. */}
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
                className={`chip chip-star${filter === 'favorites' ? ' selected' : ''}`}
                onClick={() => onFilterChange(filter === 'favorites' ? 'all' : 'favorites')}
              >
                ★ {t('gallery.favorites')} · {favoriteCount}
              </button>
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="empty">
              <Bars values={ghostBars('empty', 30)} className="bars-ghost" />
              <p>
                {query.trim() === ''
                  ? filter === 'favorites'
                    ? t('gallery.emptyFavorites')
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
                  favorite={item.favorite}
                  playing={playing === item.name}
                  {...(item.bankId === undefined ? {} : { bankId: item.bankId })}
                  {...(item.likes === undefined ? {} : { likes: item.likes })}
                  {...(item.liked === undefined ? {} : { liked: item.liked })}
                  {...(item.comments === undefined ? {} : { comments: item.comments })}
                  {...(item.author === undefined ? {} : { author: item.author })}
                  onOpen={() => onOpen(item.name)}
                  onPlay={() => onPlay(item.name)}
                  onFavorite={() => onFavorite(item.name)}
                  /* The gallery's own seed, the same one the card's waveform was drawn
                     with: a download that differed from the picture beside it would be a
                     different sound under the name that was clicked. */
                  onDownload={async (format) =>
                    onStatus(await downloadRecipe(item.name, item.source, seed, format))
                  }
                  onLike={() => onLike(item)}
                  onComments={() => onComments(item)}
                />
              ))}
            </div>
          )}

          {/* Only with an account connected, and only once there is a question to
              answer. An empty box is the front page rather than a search, and a
              freesound heading over nothing on the front page would advertise a second
              catalog that is not there. */}
          {search.connection.state === 'on' && query.trim() !== '' ? (
            <section className="fs-block">
              <div className="fs-head">
                <h2>{t('gallery.freesoundHeading')}</h2>
                <span className="faint hint">{t('gallery.freesoundHint')}</span>
              </div>
              <FreesoundResults search={search} onUseSound={onUseSound} onStatus={onStatus} />
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}
