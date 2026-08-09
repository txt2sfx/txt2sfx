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
 * ## The three above the rack
 *
 * The masters are not slots and are drawn apart from them: a slot is one number the
 * author marked as uncertain, a master moves every number of a kind at once. They are
 * *jogs* — they show no absolute position, because between two gestures the text is
 * the state (see `lib/master.ts`) — so the control returns to centre on release and
 * this component reports the release rather than tracking it.
 *
 * @packageDocumentation
 */

import { formatNumber } from '@txt2sfx/core';
import { layerColor } from '../lib/design.js';
import { useI18n, type Key } from '../lib/i18n.js';
import { MASTER_KINDS, type MasterKind } from '../lib/master.js';
import { positionToValue, valueToPosition, type Slot } from '../lib/slots.js';

/**
 * What to say about a master that has nothing to turn.
 *
 * Each names what the recipe is missing rather than reporting a failure. `length`
 * is absent on purpose: every sound declares a duration, so that knob is never dead.
 */
const MASTER_BLOCKED: Readonly<Partial<Record<MasterKind, Key>>> = {
  pitch: 'master.noFreq',
  brightness: 'master.noFilters',
};

/** The label of each master, in the dictionary. */
const MASTER_LABEL: Readonly<Record<MasterKind, Key>> = {
  pitch: 'master.pitch',
  length: 'master.length',
  brightness: 'master.brightness',
};

export interface SlotsCardProps {
  readonly slots: readonly Slot[];
  readonly layerNames: readonly string[];
  readonly onChange: (slot: Slot, value: number) => void;
  /** Current jog position of each master, 0..1; the centre (`0.5`) when at rest. */
  readonly masters: Readonly<Record<MasterKind, number>>;
  /** A master with nothing to turn is muted rather than hidden — see the header. */
  readonly masterAvailable: Readonly<Record<MasterKind, boolean>>;
  readonly onMaster: (kind: MasterKind, position: number) => void;
  /** The gesture ended: the text already holds the result, the knob goes back to centre. */
  readonly onMasterCommit: (kind: MasterKind) => void;
  /** Roll every slot inside its own range. */
  readonly onVariation: () => void;
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
  masters,
  masterAvailable,
  onMaster,
  onMasterCommit,
  onVariation,
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
        <button
          type="button"
          onClick={onVariation}
          disabled={slots.length === 0}
          title={slots.length === 0 ? t('slots.variationBlocked') : t('slots.variationTitle')}
        >
          ⚄ {t('slots.variation')}
        </button>
        {fitRunning ? (
          <button type="button" onClick={onStopFit} title={t('slots.stopTitle')}>
            ■ {t('slots.stop')}
          </button>
        ) : (
          <button
            type="button"
            className="violet"
            /* With no argument: the handler behind this takes an optional reference to
               fit against, and `onClick={onFit}` would hand it a mouse event. */
            onClick={() => onFit()}
            disabled={fitBlocked !== null}
            title={fitBlocked ?? t('slots.fitTitle')}
          >
            ⌖ {t('slots.fit')}
          </button>
        )}
      </div>

      <div className="panel-body">
        <div className="sliders masters">
          <span className="mono faint slider-label">{t('master.title')}</span>
          {MASTER_KINDS.map((kind) => {
            const available = masterAvailable[kind];
            const blocked = MASTER_BLOCKED[kind];
            return (
              <label className="slider" key={kind}>
                {/* No value readout: a jog has no absolute position to report, and a
                    number that snapped back to ×1 on every release would read as a bug. */}
                <span className="mono slider-label">{t(MASTER_LABEL[kind])}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={masters[kind]}
                  disabled={!available}
                  aria-label={t(MASTER_LABEL[kind])}
                  title={available || blocked === undefined ? undefined : t(blocked)}
                  onChange={(event) => onMaster(kind, event.target.valueAsNumber)}
                  /* Three ways a gesture can end, and all three have to commit: the
                     pointer released, an arrow key released, or focus leaving mid-drag
                     (a pointer that went up outside the window). Missing one would
                     leave the knob off-centre with a stale base behind it. */
                  onPointerUp={() => onMasterCommit(kind)}
                  onKeyUp={() => onMasterCommit(kind)}
                  onBlur={() => onMasterCommit(kind)}
                />
              </label>
            );
          })}
        </div>

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
