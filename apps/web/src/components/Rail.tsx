/**
 * The studio's list of everything else.
 *
 * ## Three orderings, because there are three reasons to look
 *
 * `Recent` is the default and answers *what was I just doing* — the ordering anyone
 * wants while iterating, and the reason `lib/library.ts` keeps a touch time at all.
 * `Categories` answers *what else is a foley* and is how you find the sibling to
 * compare against. `Trash` answers *what did I hide* and exists because hiding
 * something with no way to see the pile is how a tool loses a user's work.
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
 * @packageDocumentation
 */

import { useMemo } from 'react';
import { catHue } from '../lib/design.js';
import { ago, ms } from '../lib/format.js';
import { useI18n } from '../lib/i18n.js';
import type { GalleryItem } from '../screens/Gallery.js';

/** Which ordering the rail is in. */
export type RailMode = 'recent' | 'categories' | 'trash';

export interface RailProps {
  readonly items: readonly GalleryItem[];
  readonly selected: string;
  readonly dirty: readonly string[];
  readonly mode: RailMode;
  readonly onMode: (mode: RailMode) => void;
  readonly onSelect: (name: string) => void;
  readonly onTrash: (name: string) => void;
  readonly onNew: () => void;
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
  onTrash,
  onNew,
}: RailProps): React.JSX.Element {
  const { t } = useI18n();
  const live = items.filter((item) => !item.trashed);
  const trashed = items.filter((item) => item.trashed);

  const groups = useMemo<readonly Group[]>(() => {
    if (mode === 'trash') {
      return [{ label: t('rail.groupTrash'), hue: null, items: trashed, emptyText: t('rail.emptyTrash') }];
    }
    if (mode === 'recent') {
      /* Anything never touched here sorts after everything that was, rather than to
         the top with a timestamp of zero: a fresh checkout would otherwise show the
         reference set as the most recent work. */
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
  }, [live, trashed, mode, t]);

  return (
    <aside className="rail">
      <div className="rail-top">
        <button type="button" className="primary block" onClick={onNew}>
          <span className="plus">+</span>
          {t('rail.new')}
        </button>
      </div>

      <div className="rail-tabs">
        {(['recent', 'categories', 'trash'] as const).map((id) => (
          <button type="button" key={id} className={mode === id ? 'selected' : ''} onClick={() => onMode(id)}>
            {id === 'trash' && trashed.length > 0
              ? t('rail.trashCount', { count: trashed.length })
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
                  className={`rail-row${item.name === selected && !item.trashed ? ' selected' : ''}`}
                  style={{ ['--hue' as string]: String(catHue(item.category)) }}
                  onClick={() => !item.trashed && onSelect(item.name)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !item.trashed) onSelect(item.name);
                  }}
                >
                  <span className="rail-name">{item.name}</span>
                  {dirty.includes(item.name) ? (
                    <span className="dirty" title={t('rail.unsaved')}>
                      ●
                    </span>
                  ) : null}
                  <span className="mono faint rail-meta">
                    {mode === 'recent' && item.editedAt !== undefined ? ago(item.editedAt) : ms(item.durationMs)}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="rail-act"
                    title={item.trashed ? t('rail.restore') : t('rail.moveToTrash')}
                    onClick={(event) => {
                      event.stopPropagation();
                      onTrash(item.name);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.stopPropagation();
                      onTrash(item.name);
                    }}
                  >
                    {item.trashed ? '↺' : '✕'}
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
