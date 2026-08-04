/**
 * One slider per `~` slot, grouped by layer.
 *
 * The knobs are exactly the values the author already marked as uncertain, which
 * makes this panel the manual half of the optimizer that arrives in phase 4: the
 * search space is the same, only the search is done by ear. Frequencies and times
 * travel logarithmically — see `lib/slots.ts` for why that is not cosmetic.
 *
 * @packageDocumentation
 */

import { formatNumber } from '@txt2sfx/core';
import { positionToValue, valueToPosition, type Slot } from '../lib/slots.js';

export interface SlidersProps {
  readonly slots: readonly Slot[];
  /** Layer order, for the accent colour. */
  readonly layerNames: readonly string[];
  readonly onChange: (slot: Slot, value: number) => void;
}

export function Sliders({ slots, layerNames, onChange }: SlidersProps): React.JSX.Element {
  if (slots.length === 0) {
    return (
      <p className="hint">
        No <code>~</code> slots in this recipe. Mark a value as <code>~480Hz[300..900]</code> to get a knob for it.
      </p>
    );
  }

  const groups = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = slot.layer ?? '';
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [slot]);
    else list.push(slot);
  }

  return (
    <div className="sliders">
      {[...groups].map(([layer, list]) => {
        const accent = layer === '' ? -1 : layerNames.indexOf(layer);
        return (
          <div className="slider-group" key={layer === '' ? '<header>' : layer} data-accent={accent % 4}>
            <div className="slider-group-name">{layer === '' ? 'header' : layer}</div>
            {list.map((slot) => (
              <label className="slider" key={slot.id}>
                <span className="slider-label">{slot.label}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={valueToPosition(slot, slot.value)}
                  onChange={(event) => onChange(slot, positionToValue(slot, event.target.valueAsNumber))}
                />
                <span className="slider-value">
                  {formatNumber(slot.value)}
                  {slot.unit}
                </span>
                <span className="slider-range">
                  {formatNumber(slot.min)}‥{formatNumber(slot.max)}
                </span>
              </label>
            ))}
          </div>
        );
      })}
    </div>
  );
}
