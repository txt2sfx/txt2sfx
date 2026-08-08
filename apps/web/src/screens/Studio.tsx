/**
 * One sound, and everything that can be done to it.
 *
 * ## Three views over one recipe, not three tools
 *
 * `Soundline` is the sound as this project makes it. `Model` is the same prompt answered
 * by a diffusion model, which is a target rather than a rival. `Compare A / B` is the
 * two of them measured against each other — or against a second seed, or against a file.
 * They are tabs rather than panels because they answer the same question at three
 * distances and only one of them is wanted at a time, and because the middle one is
 * expensive: the model view holds a subprocess and a checkpoint, and putting it
 * permanently on screen would start it for people who never asked.
 *
 * The prompt row above them stays put across all three, and takes its accent hue from
 * whichever is active — so the colour of the page says which mode you are in without a
 * label for it. It also *acts* on whichever is active: Make sound runs the loop on
 * `Soundline` and the diffusion model on `Model`, which is why this screen holds a handle
 * on the model panel and a flag for what it is doing. The panel keeps its own Render
 * button — the row is a second door to the same run, not a replacement — and the two
 * cannot disagree, because both call through the one handle.
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
import { SoundPanel } from '../components/SoundPanel.js';
import { SoundlineCard } from '../components/SoundlineCard.js';
import { captionProviderFor } from '../lib/agent.js';
import { catHue } from '../lib/design.js';
import { ago, ms } from '../lib/format.js';
import { useI18n } from '../lib/i18n.js';
import type { Format } from '../lib/download.js';
import type { Slot } from '../lib/slots.js';
import type { Generation, ProviderSettings } from '../lib/useGenerate.js';
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

  /* --- views --- */
  readonly view: StudioView;
  readonly onView: (view: StudioView) => void;

  /* --- the run --- */
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  readonly settings: ProviderSettings;
  readonly onSettingsChange: (settings: ProviderSettings) => void;
  readonly generation: Generation;
  readonly agentReady: boolean;

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
  /** The Model tab can install the model; when it does, the rest of the app must know. */
  readonly onModelReady: (ready: boolean) => void;
  readonly onLoadFile: (file: File) => void;
  readonly onNewTake: () => void;
  readonly onModelRendered: (file: File) => void;

  /* --- fitting --- */
  readonly fitting: string | null;
  readonly fitRunning: boolean;
  readonly fitBlocked: string | null;
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
  const running = toModel ? modelBusy : props.generation.running;

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
            settings={props.settings}
            onSettingsChange={props.onSettingsChange}
            storedKeys={props.generation.storedKeys}
            onForgetKey={props.generation.forgetKey}
            onLoadKey={props.generation.loadKey}
            hasReference={props.b !== null}
            agentReady={props.agentReady}
            running={running}
            /* The model's abort is immediate — it kills a subprocess — so there is no
               "stopping…" state to report for it. */
            stopping={toModel ? false : props.generation.stopping}
            view={props.view}
            modelReady={props.modelAvailable}
            onRun={() => {
              if (toModel) modelControls.current?.run();
              else props.generation.start(props.prompt.trim(), props.settings);
            }}
            onStop={() => {
              if (toModel) modelControls.current?.stop();
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
            hadTarget={props.settings.matchReference && props.b !== null}
            seed={props.seed}
            onTake={() => props.generation.take(props.prompt.trim())}
          />

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
                className={props.view === 'compare' ? 'selected violet' : ''}
                onClick={() => props.onView('compare')}
              >
                {t('studio.compare')}
              </button>
            </nav>
            {props.view === 'compare' ? <span className="faint hint">{t('studio.hintCompare')}</span> : null}
            {props.view === 'model' ? <span className="faint hint">{t('studio.hintModel')}</span> : null}
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
                onLoadFile={props.onLoadFile}
                onNewTake={props.onNewTake}
                onFit={props.onFit}
                fitBlocked={props.fitBlocked}
                maxPeak={props.maxPeak}
              />
            ) : null}
          </section>

          {/* The recipe and its numbers stay below every view except the model's, which
              has no recipe by definition — showing an editor under it would suggest the
              diffusion render could be tuned, and it cannot. */}
          {props.view === 'model' ? null : (
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
