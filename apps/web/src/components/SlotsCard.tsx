/**
 * The `~value[min..max]` literals, as knobs — and the button that turns them.
 *
 * ## What a slot is, in the interface
 *
 * A tilde in a recipe means "about this, and here is where to look": it is
 * simultaneously the optimizer's search space and a slider's travel. That double duty
 * is the reason this panel and the Fit button live together — moving a knob by hand and
 * letting differential evolution move all of them are the same operation at two
 * different speeds, and separating them into different parts of the app would hide that.
 *
 * Frequency and time travel logarithmically (see `lib/slots.ts`): on a linear
 * `[500..8000]` Hz slider the entire musically useful bottom octave lives in the first
 * five percent of the travel, which makes tuning by ear impossible.
 *
 * ## Why the empty state teaches instead of apologising
 *
 * A recipe with no tildes has no knobs, and "no slots" as a message wastes the one
 * moment the reader is looking for them. The syntax is shown instead, because the fix
 * is to write one.
 *
 * @packageDocumentation
 */

import { formatNumber } from '@txt2sfx/core';
import { layerColor } from '../lib/design.js';
import { useI18n } from '../lib/i18n.js';
import { positionToValue, valueToPosition, type Slot } from '../lib/slots.js';

export interface SlotsCardProps {
  readonly slots: readonly Slot[];
  readonly layerNames: readonly string[];
  readonly onChange: (slot: Slot, value: number) => void;
  /** Progress or verdict of a fit, or `null` if none has run. */
  readonly fitting: string | null;
  readonly fitRunning: boolean;
  /** Why Fit is unavailable, or `null` when it is available. */
  readonly fitBlocked: string | null;
  readonly onFit: () => void;
  readonly onStopFit: () => void;
}

export function SlotsCard({
  slots,
  layerNames,
  onChange,
  fitting,
  fitRunning,
  fitBlocked,
  onFit,
  onStopFit,
}: SlotsCardProps): React.JSX.Element {
  const { t } = useI18n();

  /* The example and the tilde stay outside the dictionary and inside `<code>`: they are
     the language's own syntax, and a translator who "localised" `~700Hz[500..1400]` would
     be teaching a recipe that does not parse. So the placeholder is left standing and
     split on here, rather than substituted — a string cannot carry an element. */
  const [before = '', after = ''] = t('slots.teachAfter').split('{example}');

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="mono panel-title">{t('slots.title')}</span>
        <div className="spacer" />
        {fitting === null ? null : <span className="mono faint">{fitting}</span>}
        {fitRunning ? (
          <button type="button" onClick={onStopFit} title={t('slots.stopTitle')}>
            ■ {t('slots.stop')}
          </button>
        ) : (
          <button
            type="button"
            className="violet"
            onClick={onFit}
            disabled={fitBlocked !== null}
            title={fitBlocked ?? t('slots.fitTitle')}
          >
            ⌖ {t('slots.fit')}
          </button>
        )}
      </div>

      <div className="panel-body">
        {slots.length === 0 ? (
          <p className="teach">
            {t('slots.teachBefore')}
            <code>~</code>
            {before}
            <code>~700Hz[500..1400]</code>
            {after}
          </p>
        ) : (
          <div className="sliders">
            {slots.map((slot) => {
              const layerIndex = slot.layer === null ? -1 : layerNames.indexOf(slot.layer);
              return (
                <label className="slider" key={slot.id}>
                  <span className="slider-head">
                    <span
                      className="mono slider-label"
                      style={layerIndex < 0 ? undefined : { color: layerColor(layerIndex) }}
                    >
                      {slot.layer === null ? slot.label : `${slot.layer} · ${slot.label}`}
                    </span>
                    <span className="spacer" />
                    <span className="mono slider-value">
                      {formatNumber(slot.value)}
                      {slot.unit}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.001}
                    value={valueToPosition(slot, slot.value)}
                    aria-label={`${slot.layer ?? 'sound'} ${slot.label}`}
                    onChange={(event) => onChange(slot, positionToValue(slot, event.target.valueAsNumber))}
                  />
                  <span className="mono slider-range">
                    {formatNumber(slot.min)}…{formatNumber(slot.max)}
                    {slot.unit}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
