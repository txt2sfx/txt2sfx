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
  readonly origin: 'session' | 'examples' | 'bank';
  readonly editedAt: number | undefined;
  readonly trashed: boolean;
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
  readonly onboarded: boolean;
  readonly onDismissOnboarding: () => void;
  readonly playing: string | null;
  readonly onOpen: (name: string) => void;
  readonly onPlay: (name: string) => void;
  readonly onTrash: (name: string) => void;
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
  onboarded,
  onDismissOnboarding,
  playing,
  onOpen,
  onPlay,
  onTrash,
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
      item.name.toLowerCase().includes(needle) ||
      item.prompt.toLowerCase().includes(needle) ||
      item.source.toLowerCase().includes(needle);

    return items.filter((item) => {
      if (filter === 'trash') return item.trashed && matches(item);
      if (item.trashed) return false;
      return (filter === 'all' || item.category === filter) && matches(item);
    });
  }, [items, filter, query]);

  /* Only the categories the catalog actually contains, plus whichever is selected so
     the chip you clicked cannot vanish under you. A row of nine chips where six match
     nothing is a menu of dead ends. */
  const categories = useMemo(() => {
    const present = new Set(items.filter((item) => !item.trashed).map((item) => item.category));
    return SOUND_CATEGORIES.filter((category) => present.has(category) || filter === category);
  }, [items, filter]);

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
            <button type="submit" className="primary big" disabled={prompt.trim() === ''}>
              {t('gallery.generate')}
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
                  {t('gallery.generateInstead')}
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
                  onOpen={() => onOpen(item.name)}
                  onPlay={() => onPlay(item.name)}
                  onTrash={() => onTrash(item.name)}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
