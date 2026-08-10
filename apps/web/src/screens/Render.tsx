/**
 * AI Render — the other kind of answer, at the size of a screen.
 *
 * ## Why it is a screen and not a tab any more
 *
 * It was a tab inside the studio, which put it *under a recipe*. Everything else on that
 * screen is about one soundline — the editor, the sliders, the export card — and a
 * diffusion render has none of those things by definition, so the tab spent its whole
 * existence explaining that the panel below it did not apply. The deeper problem was the
 * subject: what this does is answer the prompt with a rendered audio file, which is not a
 * view of the recipe on screen. It is a different thing made from the same sentence.
 *
 * As a screen it also stops being buried. The install is a gated, multi-gigabyte download
 * that most visitors do not have; a top-level tab is somewhere that state can be seen and
 * fixed once, rather than discovered on the fourth tab of a screen someone reached by
 * opening a recipe they did not want.
 *
 * ## What it is *for*, said in one place
 *
 * A target. Stable Audio returns a few hundred kilobytes of MP3 for a sound this project
 * ships as eight hundred bytes of JavaScript, so as a deliverable the two are not in the
 * same category; as a *reference* it is the most valuable thing on the machine, because
 * finding a recording of "a rusty gate opening slowly, then a heavy latch" by hand is the
 * slow step in every session. So the one thing this screen hands onward is B — `→ Compare`
 * loads the render as the B side and opens the studio on it, where `⌖ Fit to reference`
 * and `match reference` apply unchanged.
 *
 * The panel itself is unchanged and still owns the subprocess, the log and the install
 * form; see `components/ModelPanel.tsx` for why the log *is* the progress bar. This file
 * is the frame: a prompt, a sentence saying what the screen is, and the panel.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { assetFileName, titleFromText } from '@txt2sfx/agent';
import { ModelPanel, type CaptionWriter, type ModelControls } from '../components/ModelPanel.js';
import { PromptRow } from '../components/PromptRow.js';
import { RenderRail } from '../components/RenderRail.js';
import type { ProviderKind } from '../lib/agent.js';
import type { Format } from '../lib/download.js';
import { useI18n } from '../lib/i18n.js';
import { forgetRender, keepRender, listRenders, renameRender, type KeptRender } from '../lib/renders.js';

/**
 * How a rendered sound gets the name a game project would file it under.
 *
 * Same shape and same reason as {@link CaptionWriter}: which model answers is `App`'s
 * decision, and this screen knows nothing about keys or bridges. Null when nothing on
 * the page can write one — the row is then named from the caption by
 * `@txt2sfx/agent`'s `titleFromText`, which is a name rather than a placeholder.
 */
export type NameWriter = (input: {
  readonly text: string;
  readonly signal: AbortSignal;
}) => Promise<{ readonly title: string; readonly file: string }>;

export interface RenderScreenProps {
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  /** Who would write the caption — read here only to draw the gear, as the studio does. */
  readonly model: ProviderKind | null;
  readonly onOpenSettings: () => void;
  /** How the prompt becomes something t5-base can read. Null when no model can. */
  readonly writeCaption: CaptionWriter | null;
  /** How a kept render gets its name. Null when no model can write one. */
  readonly writeName: NameWriter | null;
  /** Where a sentence for the toast goes — a saved file, at its size. */
  readonly onStatus: (message: string) => void;
  /** The last render, decoded — the same object Compare uses as B, when B is a render. */
  readonly render: { readonly name: string; readonly buffer: AudioBuffer } | null;
  readonly onRendered: (file: File) => void;
  /** Make the render the B side and open the studio's compare view on it. */
  readonly onCompare: () => void;
  readonly formatId: string;
  readonly onFormat: (id: string) => void;
  readonly onDownload: (format: Format) => Promise<unknown> | void;
  readonly seed: number;
  /** Draw a new session seed — the panel puts the button beside the length. */
  readonly onReseed: () => void;
  /** Told when an install finishes, so the rest of the app stops saying "missing". */
  readonly onModelReady: (ready: boolean) => void;
  readonly modelAvailable: boolean;
}

export function RenderScreen(props: RenderScreenProps): React.JSX.Element {
  const { t } = useI18n();

  /* The panel's run and abort, handed up so the prompt row can press them — the same
     arrangement the studio used, and for the same reason: the subprocess's lifetime
     belongs next to the panel that shows its log, not in the screen above it. */
  const controls = useRef<ModelControls | null>(null);
  const [busy, setBusy] = useState(false);
  /* The caption is written by the panel and pressed for in the row, so the one bit of
     state that has to cross between them is whether a call is in flight. */
  const [writing, setWriting] = useState(false);

  /* --- the renders this browser kept --------------------------------------- */

  const [kept, setKept] = useState<readonly KeptRender[]>([]);
  /* The file the panel just produced, waiting for the duration. `App` decodes it on its
     way to becoming B, so the buffer arrives one render later through `props.render` —
     and decoding it a second time here to learn a number that is already on its way
     would be two decodes of the same MP3 for one row in a list. */
  const pending = useRef<File | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listRenders().then((entries) => {
      if (!cancelled) setKept(entries);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const { render, writeName, prompt, seed } = props;

  useEffect(() => {
    const file = pending.current;
    if (file === null || render === null) return;
    pending.current = null;

    const controller = new AbortController();
    void keepRender({
      title: '',
      file: '',
      blob: file,
      /* From the file the bridge returned rather than from the format menu: what is
         stored is those bytes, and a row offering `.wav` for an MP3 would be the same
         renamed-file lie `lib/download.ts` refuses everywhere else. */
      extension: file.name.split('.').pop() ?? 'mp3',
      bytes: file.size,
      durationMs: render.buffer.duration * 1000,
      prompt,
      seed,
    }).then(async (record) => {
      if (record === null) return;
      setKept((current) => [record, ...current]);

      /* The name arrives after the row does, on purpose: the render is finished and
         audible, and making the list wait for one more model call would hold the result
         hostage to the cheapest step in the chain. With no model to ask, the caption
         still names it — its first clause is the subject, which is exactly what a name
         wants — rather than leaving a list of "unnamed". */
      const fromText = { title: titleFromText(prompt), file: assetFileName(titleFromText(prompt)) };
      const named =
        writeName === null
          ? fromText
          : ((await writeName({ text: prompt, signal: controller.signal }).catch(() => null)) ?? fromText);
      if (controller.signal.aborted) return;
      await renameRender(record.id, named.title, named.file);
      setKept((current) =>
        current.map((entry) => (entry.id === record.id ? { ...entry, title: named.title, file: named.file } : entry)),
      );
    });

    return () => controller.abort();
  }, [render, writeName, prompt, seed]);

  const forget = useCallback((id: string) => {
    setKept((current) => current.filter((entry) => entry.id !== id));
    void forgetRender(id);
  }, []);

  return (
    <div className="screen screen-render">
      <main className="render-main">
        <div className="column">
          <PromptRow
            prompt={props.prompt}
            onPromptChange={props.onPromptChange}
            model={props.model}
            onOpenSettings={props.onOpenSettings}
            running={busy}
            /* The model's abort kills a subprocess, so it takes effect at once and there
               is no "stopping…" state to report. */
            stopping={false}
            engine="model"
            modelReady={props.modelAvailable}
            onRun={() => controls.current?.run()}
            onStop={() => controls.current?.stop()}
            /* On this screen the sentence in the row *is* the caption t5-base reads, so
               the row carries its length and the button that rewrites it. */
            caption={{
              writing,
              canWrite: props.writeCaption !== null,
              onRewrite: () => controls.current?.rewrite(),
            }}
          />

          <section className="card-panel render-panel">
            <div className="card-panel-head">
              <h2 className="mono">{t('render.title')}</h2>
              <span className="faint hint">{t('render.hint')}</span>
            </div>

            <ModelPanel
              prompt={props.prompt}
              onPrompt={props.onPromptChange}
              render={props.render}
              /* Kept on the way past. The screen above needs the file to become B and
                 the rail needs the same bytes to keep — one hand-off, not two. */
              onRendered={(file) => {
                pending.current = file;
                props.onRendered(file);
              }}
              onCompare={props.onCompare}
              formatId={props.formatId}
              onFormat={props.onFormat}
              onDownload={props.onDownload}
              seed={props.seed}
              onReseed={props.onReseed}
              writeCaption={props.writeCaption}
              onReady={props.onModelReady}
              controls={controls}
              onBusy={setBusy}
              onCaptioning={setWriting}
            />
          </section>
        </div>
      </main>

      <RenderRail items={kept} onSaved={props.onStatus} onForget={forget} />
    </div>
  );
}
