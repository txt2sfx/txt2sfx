/**
 * The recipe list.
 *
 * Phase 5 replaces the source of these entries with the bank server's `/retrieve`;
 * the component's contract — a list of named soundlines, one of them selected —
 * is deliberately the same shape either way.
 *
 * @packageDocumentation
 */

import type { Recipe } from '../lib/examples.js';

export interface GalleryProps {
  readonly recipes: readonly Recipe[];
  readonly selected: string;
  /** Names whose editor buffer differs from what is on disk. */
  readonly dirty: readonly string[];
  readonly onSelect: (name: string) => void;
}

export function Gallery({ recipes, selected, dirty, onSelect }: GalleryProps): React.JSX.Element {
  return (
    <nav className="gallery">
      {recipes.map((recipe) => (
        <button
          type="button"
          key={recipe.name}
          className={recipe.name === selected ? 'gallery-item selected' : 'gallery-item'}
          onClick={() => onSelect(recipe.name)}
        >
          <span className="gallery-name">{recipe.name}</span>
          {dirty.includes(recipe.name) ? <span className="gallery-dirty" title="unsaved edits">●</span> : null}
        </button>
      ))}
    </nav>
  );
}
