/**
 * The studio's working set.
 *
 * ## Not the catalog — what this session has touched
 *
 * The rail used to list everything the gallery lists: the reference set, the bundled
 * presets and whatever the bank answered with, a few hundred rows deep once a bank is
 * up. That makes the sidebar a second catalog, worse than the first one — no waveform,
 * no prompt, no search — and it buries the four recipes somebody is actually moving
 * between under everything they have never opened.
 *
 * So a row appears here once the session has a reason for it: a recipe that was edited
 * (`library.touched`, which is also what the "edited 2m ago" line reads), one this tab
 * generated or imported (`origin === 'session'`), and whatever is open right now — the
 * last of those because opening from the gallery is not an edit and a rail with no row
 * for the recipe on screen would read as a bug. Browsing stays in the gallery, which
 * has the search and the pictures for it.
 *
 * ## Three orderings, because there are three reasons to look
 *
 * `Recent` is the default and answers *what was I just doing* — the ordering anyone
 * wants while iterating, and the reason `lib/library.ts` keeps a touch time at all.
 * `Categories` answers *what else is a foley* and is how you find the sibling to
 * compare against. `Favourites` answers *the ones I keep coming back to*, and it is
 * the one tab that ignores the working set: a star is precisely how a recipe stays
 * reachable from here after the session that touched it ended.
 *
 * Sorting by recency is deliberately not the same as sorting by name, which is what
 * the old sidebar did. Alphabetical is the right default for a *reference set* that
 * does not change; it is the wrong one for a working set, where the thing you touched
 * a minute ago is the thing you want and its name is an accident.
 *
 * ## Why the rail is not the gallery
 *
 * The gallery is for choosing; the rail is for switching. So: no waveforms, no
 * prompts, one line each, and the colour of the row is the recipe's category — which
 * carries identity at a glance without spending a column on a badge.
 *
 * The one exception is the play glyph, because auditioning is the cheapest way to know
 * you have the right row and switching to find out costs the editor's state. It is dim
 * until the row is hovered so a still list stays a list of names, and it stops at the
 * click rather than selecting, so hearing a neighbour never moves you off your work.
 *
 * @packageDocumentation
 */

import { useMemo } from 'react';
import { catHue } from '../lib/design.js';
import { ago, ms } from '../lib/format.js';
import { useI18n } from '../lib/i18n.js';
import type { GalleryItem } from '../screens/Gallery.js';

/** Which ordering the rail is in. */
export type RailMode = 'recent' | 'categories' | 'favorites';

export interface RailProps {
  readonly items: readonly GalleryItem[];
  readonly selected: string;
  readonly dirty: readonly string[];
  readonly mode: RailMode;
  readonly onMode: (mode: RailMode) => void;
  readonly onSelect: (name: string) => void;
  readonly onPlay: (name: string) => void;
  readonly onFavorite: (name: string) => void;
  readonly onNew: () => void;
  /** Name of whatever is sounding right now, from anywhere in the app, or `null`. */
  readonly playing: string | null;
}

/** A labelled run of rows. */
interface Group {
  readonly label: string;
  readonly hue: number | null;
  readonly items: readonly GalleryItem[];
  readonly emptyText: string;
}

export function Rail({
  items,
  selected,
  dirty,
  mode,
  onMode,
  onSelect,
  onPlay,
  onFavorite,
  onNew,
  playing,
}: RailProps): React.JSX.Element {
  const { t } = useI18n();
  /* The working set, and the one place it is defined — both orderings that describe
     *this session* read it, so a row cannot be in Recent and missing from Categories.
     Favourites is not one of them: a star is what carries a recipe across sessions. */
  const live = items.filter(
    (item) => item.editedAt !== undefined || item.origin === 'session' || item.name === selected,
  );
  const starred = items.filter((item) => item.favorite);

  const groups = useMemo<readonly Group[]>(() => {
    if (mode === 'favorites') {
      return [
        { label: t('rail.groupFavorites'), hue: 85, items: starred, emptyText: t('rail.emptyFavorites') },
      ];
    }
    /* An empty working set has no categories to group by, and a screen showing nothing
       at all cannot say why. One empty group, with the sentence that names the way out. */
    if (mode === 'recent' || live.length === 0) {
      /* Anything never touched sorts after everything that was, rather than to the top
         with a timestamp of zero — that is the row this session merely opened, and it
         belongs below the ones actually worked on. */
      const byRecency = [...live].sort((a, b) => (b.editedAt ?? 0) - (a.editedAt ?? 0));
      return [{ label: t('rail.groupRecent'), hue: 195, items: byRecency, emptyText: t('rail.emptyRecent') }];
    }
    const seen: string[] = [];
    for (const item of live) {
      const category = item.category ?? 'misc';
      if (!seen.includes(category)) seen.push(category);
    }
    return seen.sort().map((category) => ({
      label: category,
      hue: catHue(category),
      items: live.filter((item) => (item.category ?? 'misc') === category),
      emptyText: '',
    }));
  }, [live, starred, mode, t]);

  return (
    <aside className="rail">
      <div className="rail-top">
        <button type="button" className="primary block" onClick={onNew}>
          <span className="plus">+</span>
          {t('rail.new')}
        </button>
      </div>

      <div className="rail-tabs">
        {(['recent', 'categories', 'favorites'] as const).map((id) => (
          <button type="button" key={id} className={mode === id ? 'selected' : ''} onClick={() => onMode(id)}>
            {id === 'favorites' && starred.length > 0
              ? t('rail.favoritesCount', { count: starred.length })
              : t(`rail.${id}`)}
          </button>
        ))}
      </div>

      <div className="rail-list">
        {groups.map((group) => (
          <div className="rail-group" key={group.label}>
            <div className="rail-group-head" style={group.hue === null ? undefined : { ['--hue' as string]: String(group.hue) }}>
              <span className="mono rail-group-label">{group.label}</span>
              <div className="spacer" />
              <span className="mono faint">{group.items.length}</span>
            </div>

            {group.items.length === 0 ? (
              <p className="rail-empty">{group.emptyText}</p>
            ) : (
              group.items.map((item) => (
                <div
                  key={item.name}
                  role="button"
                  tabIndex={0}
                  className={`rail-row${item.name === selected ? ' selected' : ''}`}
                  style={{ ['--hue' as string]: String(catHue(item.category)) }}
                  onClick={() => onSelect(item.name)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onSelect(item.name);
                  }}
                >
                  <span
                    role="button"
                    tabIndex={0}
                    className={`rail-play${item.name === playing ? ' playing' : ''}`}
                    title={item.name === playing ? t('card.stop') : t('card.play')}
                    onClick={(event) => {
                      event.stopPropagation();
                      onPlay(item.name);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.stopPropagation();
                      event.preventDefault();
                      onPlay(item.name);
                    }}
                  >
                    {item.name === playing ? '❚❚' : '▶'}
                  </span>
                  <span className="rail-name">{item.name}</span>
                  {dirty.includes(item.name) ? (
                    <span className="dirty" title={t('rail.unsaved')}>
                      ●
                    </span>
                  ) : null}
                  <span className="mono faint rail-meta">
                    {mode === 'recent' && item.editedAt !== undefined ? ago(item.editedAt) : ms(item.durationMs)}
                  </span>
                  {/* Dim until the row is hovered, like the play glyph and for the same
                      reason — except when it is on, because a star that only appears
                      under the pointer could not answer "which of these did I keep". */}
                  <span
                    role="button"
                    tabIndex={0}
                    className={`rail-act${item.favorite ? ' on' : ''}`}
                    title={t(item.favorite ? 'card.unfavorite' : 'card.favorite')}
                    onClick={(event) => {
                      event.stopPropagation();
                      onFavorite(item.name);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.stopPropagation();
                      onFavorite(item.name);
                    }}
                  >
                    {item.favorite ? '★' : '☆'}
                  </span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
