/**
 * One sound, and everything that can be done to it.
 *
 * ## Four views over one recipe, not four tools
 *
 * `Soundline` is the sound as this project makes it. `Model` is the same prompt answered
 * by a diffusion model, and `Search` is the same prompt answered by somebody's recording
 * in a public library — both targets rather than rivals, at two different costs: thirty
 * seconds of this machine's CPU, or one request. `Compare A / B` is any two of them
 * measured against each other — or against a second seed, or against a file. They are
 * tabs rather than panels because they answer the same question at four distances and
 * only one of them is wanted at a time, and because the expensive one is expensive: the
 * model view holds a subprocess and a checkpoint, and putting it permanently on screen
 * would start it for people who never asked.
 *
 * The prompt row above them stays put across all four, and takes its accent hue from
 * whichever is active — so the colour of the page says which mode you are in without a
 * label for it. It also *acts* on whichever is active: Make sound runs the loop on
 * `Soundline`, the diffusion model on `Model` and the library search on `Search`, which
 * is why this screen holds a handle on the model panel and a flag for what it is doing.
 * The panel keeps its own Render button — the row is a second door to the same run, not a
 * replacement — and the two cannot disagree, because both call through the one handle.
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

import { audioCaption } from '@txt2sfx/agent';
import { declaredDurationMs, type CodegenResult, type RenderResult, type SoundlineError } from '@txt2sfx/core';
import type { SoundAST, ValidationIssue } from '@txt2sfx/shared';
import { useMemo, useRef, useState } from 'react';
import { ComparePanel, type BKind } from '../components/ComparePanel.js';
import { ExportCard } from '../components/ExportCard.js';
import { ModelPanel, type CaptionWriter, type ModelControls } from '../components/ModelPanel.js';
import { PromptRow, type StudioView } from '../components/PromptRow.js';
import { Rail, type RailMode } from '../components/Rail.js';
import { RunStrip } from '../components/RunStrip.js';
import { SlotsCard } from '../components/SlotsCard.js';
import { SearchPanel } from '../components/SearchPanel.js';
import { SoundPanel } from '../components/SoundPanel.js';
import { SoundlineCard } from '../components/SoundlineCard.js';
import { captionProviderFor, type ProviderKind } from '../lib/agent.js';
import { catHue } from '../lib/design.js';
import { ago, ms } from '../lib/format.js';
import { useI18n } from '../lib/i18n.js';
import type { Format } from '../lib/download.js';
import type { MasterKind, MasterPositions } from '../lib/master.js';
import type { Slot } from '../lib/slots.js';
import type { FreesoundSound } from '../lib/freesound.js';
import type { Generation, ProviderSettings } from '../lib/useGenerate.js';
import type { LibrarySearch } from '../lib/useSearch.js';
import type { GalleryItem } from './Gallery.js';

export interface StudioProps {
  /* --- the catalog --- */
  readonly items: readonly GalleryItem[];
  readonly selected: string;
  readonly dirty: readonly string[];
  readonly railMode: RailMode;
  readonly onRailMode: (mode: RailMode) => void;
  readonly onSelect: (name: string) => void;
  readonly onTrash: (name: string) => void;
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

  /* --- the library --- */
  readonly search: LibrarySearch;
  /** Make this recording the B side: fetch its preview, decode it, name it. */
  readonly onUseSound: (sound: FreesoundSound) => Promise<void>;
  /** The app's toast, for the panels that report a download or a clipboard write. */
  readonly onStatus: (message: string) => void;

  /* --- playback and export --- */
  readonly playing: boolean;
  readonly looping: boolean;
  readonly onPlay: () => void;
  readonly onLoop: () => void;
  readonly formatId: string;
  readonly onFormat: (id: string) => void;
  /** The Model tab keeps its own — audio only, and remembered separately. */
  readonly modelFormatId: string;
  readonly onModelFormat: (id: string) => void;
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
  /** The Model tab can install the model; when it does, the rest of the app must know. */
  readonly onModelReady: (ready: boolean) => void;
  readonly onLoadFile: (file: File) => void;
  readonly onNewTake: () => void;
  /** A microphone recording is running; both of the compare panel's record controls say so. */
  readonly recording: boolean;
  readonly onRecord: (thenFit: boolean) => void;
  readonly onModelRendered: (file: File) => void;
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

  /* The Model tab's run, reachable from the prompt row. Null whenever that tab is not
     mounted, which is also when nothing can ask for it. `setModelBusy` goes down as-is
     rather than wrapped: the panel reports on every change and on unmount, and a fresh
     closure each render would make that fire in a loop. */
  const modelControls = useRef<ModelControls | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const toModel = props.view === 'model';
  const toSearch = props.view === 'search';

  /**
   * Who writes the reference model's caption.
   *
   * Built here rather than in the panel because *which* model answers is the prompt
   * row's decision, and the row is on this screen. Null when the picker's choice cannot
   * translate — the panel then says so instead of pretending.
   */
  const writeCaption = useMemo<CaptionWriter | null>(() => {
    const provider = captionProviderFor(props.settings, props.agentReady);
    if (provider === null) return null;
    return ({ prompt, seconds, signal }) => audioCaption({ prompt, provider, seconds, signal });
  }, [props.settings, props.agentReady]);

  /**
   * Who writes the search query and reorders the answer.
   *
   * The same choice, and therefore the same function: both stages are *about words in
   * English* rather than about sound design, and there is only one model in this tab to
   * ask either of. Null is not a failure here: a search with no model runs on the prompt
   * as typed and on the library's own relevance, which is a working search.
   */
  const searchProvider = useMemo(
    () => captionProviderFor(props.settings, props.agentReady),
    [props.settings, props.agentReady],
  );

  const running = toModel ? modelBusy : toSearch ? props.search.running : props.generation.running;

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
        onTrash={props.onTrash}
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
            running={running}
            /* The model's abort is immediate — it kills a subprocess — so there is no
               "stopping…" state to report for it. */
            stopping={toModel || toSearch ? false : props.generation.stopping}
            view={props.view}
            modelReady={props.modelAvailable}
            searchReady={props.search.connection.state === 'on'}
            onRun={() => {
              if (toModel) modelControls.current?.run();
              else if (toSearch) props.search.start(props.prompt.trim(), searchProvider);
              else props.generation.start(props.prompt.trim(), props.settings, { attached: props.agentReady });
            }}
            onStop={() => {
              if (toModel) modelControls.current?.stop();
              else if (toSearch) props.search.cancel();
              else props.generation.cancel();
            }}
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
                    className={props.view === 'model' ? 'selected amber' : ''}
                    onClick={() => props.onView('model')}
                  >
                    {t('studio.model')}
                  </button>
                  <button
                    type="button"
                    className={props.view === 'search' ? 'selected green' : ''}
                    onClick={() => props.onView('search')}
                  >
                    {t('studio.search')}
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
                {props.view === 'model' ? <span className="faint hint">{t('studio.hintModel')}</span> : null}
                {props.view === 'search' ? <span className="faint hint">{t('studio.hintSearch')}</span> : null}
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
                    onTrash={() => props.onTrash(props.selected)}
                    onShare={props.onShare}
                  />
                ) : null}

                {props.view === 'model' ? (
                  <ModelPanel
                    prompt={props.prompt}
                    render={props.bKind === 'model' ? props.b : null}
                    onRendered={props.onModelRendered}
                    onCompare={() => {
                      props.onBKind('model');
                      props.onView('compare');
                    }}
                    formatId={props.modelFormatId}
                    onFormat={props.onModelFormat}
                    onDownload={props.onDownload}
                    seed={props.seed}
                    writeCaption={writeCaption}
                    onReady={props.onModelReady}
                    controls={modelControls}
                    onBusy={setModelBusy}
                  />
                ) : null}

                {props.view === 'search' ? (
                  <SearchPanel search={props.search} onUseSound={props.onUseSound} onStatus={props.onStatus} />
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
                    onFindLibrary={() => props.onView('search')}
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

              {/* The recipe and its numbers stay below the views that are *about* the recipe,
                  and disappear under the two that are not. A diffusion render and a stranger's
                  recording both have no recipe by definition: an editor, a slider rack and an
                  Export card under either of them would suggest that what is on screen can be
                  tuned and exported as ours, and neither can. What is under them instead is
                  the thing itself, which is all there is to say about it. */}
              {props.view === 'model' || props.view === 'search' ? null : (
                <>
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
