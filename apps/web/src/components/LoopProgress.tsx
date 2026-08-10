/**
 * What is happening, while it happens — and the card that is not there yet.
 *
 * ## Why a phase list and not a spinner
 *
 * Composing a soundtrack is four different waits with nothing in common: a request to a
 * model, a deterministic judgement of what came back, a few dozen offline renders, and one
 * sum over all of them. A spinner says "some of that" for ten seconds. The list says which
 * one, how far in, and — on a repair trip — what was wrong with the last answer, which is
 * the difference between a screen that is working and a screen that looks stuck.
 *
 * Every row is a real pending promise. `useLoop.ts` argues the rule this file obeys: no
 * phase is announced before it starts, none is interpolated, and the whole thing is
 * faster on a faster machine because it is a measurement rather than a script. That is
 * also why the phase list is *shorter* with no model attached — the seeded composer has
 * nothing to write and nothing to judge, and showing two instantly-completed rows would
 * be theatre.
 *
 * ## Why there is a skeleton at all
 *
 * The previous arrangement used to stay on screen through the round trip. A finished
 * timeline under a spinner reads as the answer, so the reader spent the wait studying the
 * thing they had just asked to replace. A dimmed placeholder in the shape of the card that
 * is coming says the same thing honestly: this space is about to hold a soundtrack, and it
 * does not hold one yet.
 *
 * ## The breathing row
 *
 * Twenty-eight bars on one slow staggered animation, tinted with the phase's own hue —
 * the lane's colour once lanes exist. It is *not* a level meter and never claims to be:
 * nothing has been rendered yet during the first two phases, so a bar reacting to audio
 * would be a bar making something up. It is the only element on this screen whose whole
 * job is that waiting for a sound feels like waiting for a sound rather than for a
 * network. Held to the same rule as everything else honest here — it carries no number,
 * so it cannot report a wrong one.
 *
 * @packageDocumentation
 */

import { HUE } from '../lib/design.js';
import { useI18n, type Key } from '../lib/i18n.js';
import type { ComposePhase, Composing } from '../lib/useLoop.js';

/**
 * What each lane is called while it is being composed.
 *
 * One line per lane rather than a generic "working…", because these are the seconds in
 * which the user finds out whether the thing being built is the thing they asked for, and
 * "winding the arp" answers that where a spinner does not. Used only when the composer had
 * nothing to say for itself — a model writes its own caption into the score.
 */
const LANE_MESSAGE: Readonly<Record<string, Key>> = {
  drums: 'loop.msg.drums',
  perc: 'loop.msg.perc',
  bass: 'loop.msg.bass',
  chords: 'loop.msg.chords',
  keys: 'loop.msg.keys',
  epiano: 'loop.msg.epiano',
  organ: 'loop.msg.organ',
  stabs: 'loop.msg.stabs',
  guitar: 'loop.msg.guitar',
  riff: 'loop.msg.riff',
  brass: 'loop.msg.brass',
  lead: 'loop.msg.lead',
  arp: 'loop.msg.arp',
  bells: 'loop.msg.bells',
  fx: 'loop.msg.fx',
  pads: 'loop.msg.pads',
  strings: 'loop.msg.strings',
  choir: 'loop.msg.choir',
  drone: 'loop.msg.drone',
  air: 'loop.msg.air',
};

/** The phases, in the order they run. The list's order is this array's order. */
const PHASES: readonly ComposePhase[] = ['writing', 'checking', 'voicing', 'mixing'];

/** What each phase is called. */
const PHASE_LABEL: Readonly<Record<ComposePhase, Key>> = {
  writing: 'loop.phase.writing',
  checking: 'loop.phase.checking',
  voicing: 'loop.phase.voicing',
  mixing: 'loop.phase.mixing',
};

export interface LoopProgressProps {
  readonly composing: Composing | null;
  /** True while a mixdown is in flight, which outlives {@link composing}. */
  readonly mixing: boolean;
  /**
   * Whether a model is in the loop.
   *
   * Decides whether `writing` and `checking` are rows at all — not whether they are
   * ticked. A seeded composition that showed them as instantly done would be claiming a
   * model answered.
   */
  readonly withModel: boolean;
}

/** How many bars the breathing row is made of. Enough to read as a texture, few enough to stay one line. */
const BREATH_BARS = 28;

/**
 * The bars, as heights.
 *
 * Two overlapping sine periods so no two neighbours match and the row has no visible seam
 * when it loops, over a floor of 40% — a bar much shorter than that reads as a dash in a
 * dotted rule rather than as part of a row, and the animation already takes every bar down
 * to a quarter of its height at the bottom of the swell.
 *
 * Computed once at module load: it is a decoration with no inputs, and recomputing it per
 * render would be work in the middle of the one moment the main thread is already busy
 * rendering audio.
 */
const BREATH: readonly { readonly height: number; readonly delay: number }[] = Array.from(
  { length: BREATH_BARS },
  (_, index) => ({
    height: Math.round(66 + Math.sin((index / BREATH_BARS) * Math.PI * 3) * 20 + Math.sin(index * 0.7) * 12),
    delay: Math.round((index / BREATH_BARS) * 900),
  }),
);

/** The phase list, or nothing at all when nothing is running. */
export function LoopProgress({ composing, mixing, withModel }: LoopProgressProps): React.JSX.Element | null {
  const { t } = useI18n();
  const phase: ComposePhase | null = composing?.phase ?? (mixing ? 'mixing' : null);
  if (phase === null) return null;

  /* A mixdown on its own — a mute toggled, a track selected — is one row. Ticking the
     phases above it would claim a composition happened, and nothing was composed. */
  const shown =
    composing === null
      ? (['mixing'] as const)
      : withModel
        ? PHASES
        : PHASES.filter((entry) => entry === 'voicing' || entry === 'mixing');
  const at = PHASES.indexOf(phase);
  const hue = composing?.hue ?? HUE.recipe;

  /** What this phase can say about itself right now. Empty when it has nothing true to say. */
  const detail = (entry: ComposePhase): string => {
    if (composing === null) return '';
    switch (entry) {
      case 'writing':
        return [
          composing.trips > 1 ? t('loop.phase.trip', { attempt: composing.attempt, trips: composing.trips }) : '',
          composing.rejected === null ? '' : t('loop.phase.repairing', { rule: composing.rejected }),
        ]
          .filter((part) => part !== '')
          .join(' · ');
      case 'checking':
        return composing.chars === 0 ? '' : t('loop.phase.chars', { chars: composing.chars });
      case 'voicing':
        return composing.total === 0
          ? ''
          : [
              t('loop.progress', { done: composing.done, total: composing.total }),
              composing.caption ??
                t(LANE_MESSAGE[composing.lane] ?? 'loop.msg.generic', { lane: composing.lane }),
            ].join(' · ');
      case 'mixing':
        return '';
    }
  };

  return (
    <div className="stages" style={{ ['--hue' as string]: String(hue) }} role="status" aria-live="polite">
      <div className="breath" aria-hidden="true">
        {BREATH.map((bar, index) => (
          <i
            key={index}
            style={{ height: `${String(bar.height)}%`, animationDelay: `${String(bar.delay)}ms` }}
          />
        ))}
      </div>

      {shown.map((entry) => {
        const index = PHASES.indexOf(entry);
        const state = index < at ? 'done' : index === at ? 'active' : 'waiting';
        return (
          <div className={`stage ${state}`} key={entry}>
            <span className="stage-mark" aria-hidden="true" />
            <span className="mono stage-name">{t(PHASE_LABEL[entry])}</span>
            <span className="mono faint stage-detail">{state === 'waiting' ? '' : detail(entry)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** How many placeholder lane rows the skeleton draws. The median lane count of a palette. */
const GHOST_LANES = 4;

/**
 * The card before the soundtrack exists.
 *
 * Shaped like the real one — a title line, a transport, four lane rows — so the phase list
 * does not move down the page when the answer lands. Dimmed rather than shimmering: the
 * shimmer is on the phase list, where something is actually happening.
 */
export function LoopSkeleton(props: LoopProgressProps): React.JSX.Element {
  return (
    <section className="loop-card loop-ghost">
      <LoopProgress {...props} />
      <div className="ghost-head">
        <span className="ghost-line ghost-title" />
        <span className="ghost-line ghost-meta" />
      </div>
      <div className="ghost-transport">
        <span className="ghost-line ghost-button" />
        <span className="ghost-line ghost-word" />
      </div>
      <div className="ghost-lanes">
        {Array.from({ length: GHOST_LANES }, (_, index) => (
          <div className="ghost-lane" key={index}>
            <span className="ghost-line ghost-label" />
            <span className="ghost-line ghost-track" />
          </div>
        ))}
      </div>
    </section>
  );
}
