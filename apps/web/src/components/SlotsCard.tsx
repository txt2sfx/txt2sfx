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
 * *anchored* (see `lib/master.ts`): centre is the recipe as it was opened, the ratio
 * beside each label says how far it has been taken from there, and putting a knob back
 * in the middle puts the recipe's own numbers back. Nothing snaps back on release.
 *
 * Which is why the fork button sits in their header rather than in the panel's. An
 * anchored master is a view of one recipe, not a second recipe; the button is how the
 * shifted version becomes a recipe of its own — and the knobs, having a new zero, return
 * to the middle.
 *
 * @packageDocumentation
 */

import { formatNumber } from '@txt2sfx/core';
import { layerColor } from '../lib/design.js';
import { useI18n, type Key } from '../lib/i18n.js';
import { MASTER_CENTER, MASTER_KINDS, formatRatio, type MasterKind, type MasterPositions } from '../lib/master.js';
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
  /** Where each master stands relative to the anchored recipe; `0.5` is ×1. */
  readonly masters: MasterPositions;
  /** A master with nothing to turn is muted rather than hidden — see the header. */
  readonly masterAvailable: Readonly<Record<MasterKind, boolean>>;
  readonly onMaster: (kind: MasterKind, position: number) => void;
  /** Make what the masters produced a recipe of its own, and re-anchor on it. */
  readonly onFork: () => void;
  /** `null` when forking is available, otherwise why it is not. */
  readonly forkBlocked: string | null;
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
  onFork,
  forkBlocked,
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
          <span className="slider-head">
            <span className="mono faint slider-label">{t('master.title')}</span>
            <span className="spacer" />
            <button
              type="button"
              onClick={onFork}
              disabled={forkBlocked !== null}
              title={forkBlocked ?? t('master.forkTitle')}
            >
              ⎘ {t('master.fork')}
            </button>
          </span>
          {MASTER_KINDS.map((kind) => {
            const available = masterAvailable[kind];
            const blocked = MASTER_BLOCKED[kind];
            const moved = masters[kind];
            return (
              <label className="slider" key={kind}>
                <span className="slider-head">
                  <span className="mono slider-label">{t(MASTER_LABEL[kind])}</span>
                  <span className="spacer" />
                  {/* The readout an anchored knob has and a jog did not: how far this
                      recipe has been taken from the one that was opened. Faint at rest,
                      so a row of ×1 does not read as three numbers worth reading. */}
                  <span className={`mono slider-value${moved === MASTER_CENTER ? ' faint' : ''}`}>
                    {formatRatio(moved)}
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={moved}
                  disabled={!available}
                  aria-label={t(MASTER_LABEL[kind])}
                  title={available || blocked === undefined ? undefined : t(blocked)}
                  onChange={(event) => onMaster(kind, event.target.valueAsNumber)}
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
