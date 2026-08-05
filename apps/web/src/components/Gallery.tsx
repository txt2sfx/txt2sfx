/**
 * The recipe list.
 *
 * Grouped by origin — this session, then whichever store is selected — because the
 * groups differ in what you can do with them, not merely in where they came from:
 * a session recipe is unsaved, an `examples/` recipe is on disk and writable under
 * dev, and a bank recipe is published and shared. A flat list with a badge would
 * make "is this saved?" a thing you have to read rather than see.
 *
 * @packageDocumentation
 */

import type { Entry, Origin } from '../lib/catalog.js';

export interface GalleryProps {
  readonly entries: readonly Entry[];
  readonly selected: string;
  /** Names whose editor buffer differs from the stored source. */
  readonly dirty: readonly string[];
  readonly onSelect: (name: string) => void;
}

const GROUP_LABEL: Readonly<Record<Origin, string>> = {
  session: 'this session',
  examples: 'examples/',
  bank: 'bank',
};

export function Gallery({ entries, selected, dirty, onSelect }: GalleryProps): React.JSX.Element {
  /* Origins in the order they first appear, so the grouping follows `mergeCatalog`
     rather than imposing an order of its own. */
  const origins: Origin[] = [];
  for (const entry of entries) if (!origins.includes(entry.origin)) origins.push(entry.origin);

  if (entries.length === 0) {
    return (
      <nav className="gallery">
        <p className="hint">Nothing here yet — describe a sound above, or start the bank server.</p>
      </nav>
    );
  }

  return (
    <nav className="gallery">
      {origins.map((origin) => (
        <div className="gallery-group" key={origin}>
          <div className="gallery-group-label">{GROUP_LABEL[origin]}</div>
          {entries
            .filter((entry) => entry.origin === origin)
            .map((entry) => (
              <button
                type="button"
                key={`${origin}-${entry.name}`}
                className={entry.name === selected ? 'gallery-item selected' : 'gallery-item'}
                title={entry.prompt ?? entry.name}
                onClick={() => onSelect(entry.name)}
              >
                <span className="gallery-name">{entry.name}</span>
                {entry.rating === undefined || entry.rating === 0 ? null : (
                  <span className="gallery-rating" title="votes">
                    {entry.rating > 0 ? `+${String(entry.rating)}` : String(entry.rating)}
                  </span>
                )}
                {dirty.includes(entry.name) ? (
                  <span className="gallery-dirty" title="unsaved edits">
                    ●
                  </span>
                ) : null}
              </button>
            ))}
        </div>
      ))}
    </nav>
  );
}
