/**
 * One sound, and everything that can be done to it.
 *
 * ## Two views over one recipe
 *
 * `Soundline` is the sound as this project makes it; `Compare A / B` is that sound
 * measured against something else — a second seed, a file, a microphone, a diffusion
 * render, a recording from freesound.org. Two views rather than one screen because the
 * comparison is the expensive one: it runs FFTs over both sides on every edit, and
 * nobody looking at the slider rack is reading a spectrogram.
 *
 * It used to be four. `Model` and `Search` were the other two, and both were moved out
 * for the same reason: neither is a *view of the recipe*. A diffusion render and a
 * stranger's recording have no soundline, no slots and nothing to export, so both tabs
 * spent their existence explaining that the editor below them did not apply — and both
 * are now where their subject is. The render is a screen of its own
 * (`screens/Render.tsx`); the library search answers the gallery's catalog box, because
 * "is there already a door slam" is one question and it was being asked in two places.
 * What they leave behind is the road they were on: both still arrive here as B.
 *
 * The prompt row above the views stays put across both and always means the recipe —
 * with two views over one subject there is no longer an engine to choose between.
 *
 * ## Why the recipe stays editable while a run is going
 *
 * Because a generate run is a minute long and the thing to do during it is look at the
 * last one. Nothing here locks: the editor, the sliders and the transport all keep
 * working, and a finished run adds a new entry to the catalog instead of overwriting
 * what is on screen.
 *
 * @packageDocumentation
 */

import { declaredDurationMs, type CodegenResult, type RenderResult, type SoundlineError } from '@txt2sfx/core';
import type { SoundAST, ValidationIssue } from '@txt2sfx/shared';
import { ComparePanel, type BKind } from '../components/ComparePanel.js';
import { ExportCard } from '../components/ExportCard.js';
import { PromptRow } from '../components/PromptRow.js';
import { Rail, type RailMode } from '../components/Rail.js';
import { RunStrip } from '../components/RunStrip.js';
import { SlotsCard } from '../components/SlotsCard.js';
import { SoundPanel } from '../components/SoundPanel.js';
import { SoundlineCard } from '../components/SoundlineCard.js';
import type { ProviderKind } from '../lib/agent.js';
import { catHue } from '../lib/design.js';
import { ago, ms } from '../lib/format.js';
import { useI18n } from '../lib/i18n.js';
import type { Format } from '../lib/download.js';
import type { MasterKind, MasterPositions } from '../lib/master.js';
import type { Slot } from '../lib/slots.js';
import type { Generation, ProviderSettings } from '../lib/useGenerate.js';
import type { GalleryItem } from './Gallery.js';

/**
 * Which of the studio's two views is showing.
 *
 * Lives here rather than in the prompt row, which used to own it: the row now takes an
 * *engine* and knows nothing about views, and the only screen with views is this one.
 */
export type StudioView = 'sound' | 'compare';

export interface StudioProps {
  /* --- the catalog --- */
  readonly items: readonly GalleryItem[];
  readonly selected: string;
  readonly dirty: readonly string[];
  readonly railMode: RailMode;
  readonly onRailMode: (mode: RailMode) => void;
  readonly onSelect: (name: string) => void;
  readonly onFavorite: (name: string) => void;
  readonly onNew: () => void;
  /** Audition a row without selecting it; `railPlaying` is the name currently sounding. */
  readonly onRailPlay: (name: string) => void;
  readonly railPlaying: string | null;

  /* --- the recipe --- */
  readonly source: string;
  readonly onSourceChange: (source: string) => void;
  readonly ast: SoundAST | null;
  readonly errors: readonly SoundlineError[];
  readonly issues: readonly ValidationIssue[];
  readonly warnings: readonly string[];
  readonly code: CodegenResult | null;
  readonly rendered: RenderResult | null;
  readonly seed: number;
  readonly slots: readonly Slot[];
  readonly onSlotChange: (slot: Slot, value: number) => void;
  /** Where each master stands relative to the recipe it was anchored on; `0.5` is ×1. */
  readonly masters: MasterPositions;
  /** Whether each master has anything of its kind to move in this recipe. */
  readonly masterAvailable: Readonly<Record<MasterKind, boolean>>;
  readonly onMaster: (kind: MasterKind, position: number) => void;
  /** File the shifted recipe as one of this session's own, and re-anchor on it. */
  readonly onFork: () => void;
  readonly forkBlocked: string | null;
  readonly onVariation: () => void;

  /* --- views --- */
  readonly view: StudioView;
  readonly onView: (view: StudioView) => void;

  /* --- the run --- */
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  readonly settings: ProviderSettings;
  /** Who answers, derived once in `App` so nothing on this screen can decide otherwise. */
  readonly model: ProviderKind | null;
  /** Opens the model dialog; the row and the header badge open the same one. */
  readonly onOpenSettings: () => void;
  readonly generation: Generation;
  readonly agentReady: boolean;

  /* --- playback and export --- */
  readonly playing: boolean;
  readonly looping: boolean;
  readonly onPlay: () => void;
  readonly onLoop: () => void;
  readonly formatId: string;
  readonly onFormat: (id: string) => void;
  readonly onDownload: (format: Format) => Promise<unknown> | void;
  readonly onShare: () => void;

  /* --- comparison --- */
  readonly b: { readonly name: string; readonly buffer: AudioBuffer } | null;
  readonly bKind: BKind;
  readonly onBKind: (kind: BKind) => void;
  readonly candidateLayers: readonly (AudioBuffer | null)[];
  readonly modelAvailable: boolean;
  /** True when what is loaded as B came from the library. */
  readonly libraryLoaded: boolean;
  readonly onLoadFile: (file: File) => void;
  readonly onNewTake: () => void;
  /** A microphone recording is running; both of the compare panel's record controls say so. */
  readonly recording: boolean;
  readonly onRecord: (thenFit: boolean) => void;
  /**
   * Where the two B sides that are not made here now live.
   *
   * Both used to be tabs on this screen. The compare panel still offers them as chips,
   * because that is where somebody stands when they need one — so a chip with nothing
   * behind it takes you to the screen that can make one, rather than being disabled with
   * an explanation.
   */
  readonly onFindLibrary: () => void;
  readonly onRenderModel: () => void;
  /**
   * A run is in flight for a recipe that does not exist yet, started from the gallery.
   *
   * Everything below the run strip is *about a recipe*, and there is not one — so under
   * this flag the tabs, the panel, the editor and the slider rack are replaced by a
   * placeholder of their own shape rather than by the previously selected recipe, which
   * would be a stranger's sound presented as the answer to the sentence just typed.
   */
  readonly composing: boolean;
  /**
   * Whether the next generation is aimed at B.
   *
   * Lives in {@link ProviderSettings} because that is what a run is handed, but it is
   * switched from the compare panel: it means nothing until there is a B, and a control
   * that is dead until you load a file belongs beside the file.
   */
  readonly matchReference: boolean;
  readonly onMatchReference: (next: boolean) => void;

  /* --- fitting --- */
  readonly fitting: string | null;
  readonly fitRunning: boolean;
  readonly fitBlocked: string | null;
  /** Why record → Fit cannot work — the same reasons minus the missing B. */
  readonly recordFitBlocked: string | null;
  readonly onFit: () => void;
  readonly onStopFit: () => void;

  readonly maxPeak: number;
}

export function Studio(props: StudioProps): React.JSX.Element {
  const { t } = useI18n();
  const current = props.items.find((item) => item.name === props.selected);
  const layerNames = props.ast?.layers.map((layer) => layer.name) ?? [];

  return (
    <div className="screen screen-studio">
      <Rail
        items={props.items}
        selected={props.selected}
        dirty={props.dirty}
        mode={props.railMode}
        onMode={props.onRailMode}
        onSelect={props.onSelect}
        onPlay={props.onRailPlay}
        onFavorite={props.onFavorite}
        onNew={props.onNew}
        playing={props.railPlaying}
      />

      <main className="studio-main">
        <div className="column">
          <PromptRow
            prompt={props.prompt}
            onPromptChange={props.onPromptChange}
            model={props.model}
            onOpenSettings={props.onOpenSettings}
            running={props.generation.running}
            stopping={props.generation.stopping}
            engine="recipe"
            modelReady={props.modelAvailable}
            onRun={() => props.generation.start(props.prompt.trim(), props.settings, { attached: props.agentReady })}
            onStop={() => props.generation.cancel()}
          />

          <RunStrip
            running={props.generation.running}
            log={props.generation.log}
            progress={props.generation.progress}
            best={props.generation.best}
            result={props.generation.result}
            error={props.generation.error}
            hadTarget={props.matchReference && props.b !== null}
            seed={props.seed}
            onTake={() => props.generation.take(props.prompt.trim())}
          />

          {props.composing ? (
            <Composing running={props.generation.running} />
          ) : (
            <>
              <div className="views">
                <nav className="segmented small" aria-label={t('studio.viewAria')}>
                  <button
                    type="button"
                    className={props.view === 'sound' ? 'selected cyan' : ''}
                    onClick={() => props.onView('sound')}
                  >
                    {t('studio.soundline')}
                  </button>
                  <button
                    type="button"
                    className={props.view === 'compare' ? 'selected violet' : ''}
                    onClick={() => props.onView('compare')}
                  >
                    {t('studio.compare')}
                  </button>
                </nav>
                {props.view === 'compare' ? <span className="faint hint">{t('studio.hintCompare')}</span> : null}
              </div>

              <section className="card-panel" style={{ ['--hue' as string]: String(catHue(current?.category)) }}>
                <div className="card-panel-head">
                  <h2 className="mono">{props.selected}</h2>
                  <span className="cat">{current?.category ?? props.ast?.category ?? 'misc'}</span>
                  {/* The *declared* duration, which is the header's contract and the number the
                      validator enforces — not the rendered buffer's length, which carries the
                      analyzer's trailing pad and would report a 55 ms pop as 105 ms. */}
                  <span className="mono faint">
                    {ms(props.ast === null ? 0 : declaredDurationMs(props.ast))}
                    {current?.editedAt === undefined ? '' : t('studio.edited', { when: ago(current.editedAt) })}
                    {props.dirty.includes(props.selected) ? t('studio.unsaved') : ''}
                  </span>
                </div>

                {props.view === 'sound' ? (
                  <SoundPanel
                    name={props.selected}
                    ast={props.ast}
                    rendered={props.rendered}
                    seed={props.seed}
                    playing={props.playing}
                    looping={props.looping}
                    formatId={props.formatId}
                    onFormat={props.onFormat}
                    onDownload={props.onDownload}
                    onPlay={props.onPlay}
                    onLoop={props.onLoop}
                    onFavorite={() => props.onFavorite(props.selected)}
                    favorite={current?.favorite ?? false}
                    onShare={props.onShare}
                  />
                ) : null}

                {props.view === 'compare' ? (
                  <ComparePanel
                    candidateName={props.selected}
                    candidate={props.rendered?.buffer ?? null}
                    candidateLayers={props.candidateLayers}
                    layerNames={layerNames}
                    b={props.b}
                    bKind={props.bKind}
                    onBKind={props.onBKind}
                    modelAvailable={props.modelAvailable}
                    libraryLoaded={props.libraryLoaded}
                    onLoadFile={props.onLoadFile}
                    onFindLibrary={props.onFindLibrary}
                    onRenderModel={props.onRenderModel}
                    onNewTake={props.onNewTake}
                    recording={props.recording}
                    onRecord={props.onRecord}
                    onFit={props.onFit}
                    fitBlocked={props.fitBlocked}
                    recordFitBlocked={props.recordFitBlocked}
                    matchReference={props.matchReference}
                    onMatchReference={props.onMatchReference}
                    maxPeak={props.maxPeak}
                  />
                ) : null}
              </section>

              {/* Under both views now, and that is the point of the two that left: every
                  view on this screen is about the recipe, so the editor, the slider rack
                  and the Export card are always about what is above them. They used to be
                  hidden under `Model` and `Search`, where they would have suggested that a
                  diffusion render or a stranger's recording could be tuned and exported as
                  ours — and neither can. */}
              <SoundlineCard
                source={props.source}
                errors={props.errors}
                issues={props.issues}
                warnings={props.warnings}
                onChange={props.onSourceChange}
              />

              <div className="pair">
                <SlotsCard
                  slots={props.slots}
                  layerNames={layerNames}
                  onChange={props.onSlotChange}
                  masters={props.masters}
                  masterAvailable={props.masterAvailable}
                  onMaster={props.onMaster}
                  onFork={props.onFork}
                  forkBlocked={props.forkBlocked}
                  onVariation={props.onVariation}
                  fitting={props.fitting}
                  fitRunning={props.fitRunning}
                  fitBlocked={props.fitBlocked}
                  onFit={props.onFit}
                  onStopFit={props.onStopFit}
                />
                <ExportCard
                  code={props.code}
                  source={props.source}
                  peak={props.rendered?.peak ?? null}
                  seed={props.seed}
                  onCompare={() => props.onView('compare')}
                />
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * The studio with no recipe in it yet.
 *
 * Blocks of the right shape rather than an empty column or a centred spinner. The empty
 * column makes the strip above jump upward the moment a recipe lands, at exactly the
 * moment the reader is looking at it; the spinner is a second thing saying "wait" next to
 * a strip that is already naming the stage it is on. Placeholders say *what is coming* and
 * where, which is the one thing neither of the alternatives says.
 *
 * The pulse stops when the run does. A run that ended with nothing — cancelled, or a model
 * that never answered — leaves the shapes still and a sentence pointing at the rail, since
 * picking a recipe there is the way out and nothing else on this screen is.
 */
function Composing({ running }: { readonly running: boolean }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="studio-composing" aria-busy={running}>
      <p className="caption">{t(running ? 'studio.composing' : 'studio.composingIdle')}</p>
      <div className={`skeleton skeleton-panel${running ? ' pulsing' : ''}`} aria-hidden="true" />
      <div className="pair">
        <div className={`skeleton skeleton-card${running ? ' pulsing' : ''}`} aria-hidden="true" />
        <div className={`skeleton skeleton-card${running ? ' pulsing' : ''}`} aria-hidden="true" />
      </div>
    </div>
  );
}
