/**
 * The prompt, and the one button that answers it.
 *
 * ## Why there is nothing else in this row any more
 *
 * The row used to carry a chip that opened five controls: provider, model id, key,
 * remember, match reference. The argument for putting them behind a chip was right —
 * the prompt is edited constantly and its settings are touched twice an hour — but it
 * stopped one step short. A control nobody touches twice an hour does not belong in the
 * row *at all*, not even folded up, because the chip still had to be read on every
 * glance to find out what would happen when the button was pressed.
 *
 * What replaced it is a decision instead of a question. An attached coding agent answers
 * if there is one; otherwise the user's Gemini key; otherwise nothing happens and the row
 * says so before the button is pressed rather than after. `chooseProvider` in
 * `lib/agent.ts` is that rule, and everything on this screen reads it — so the label
 * beside the button, the button's own disabled state and the run cannot disagree.
 *
 * The label is not a picker. It is one word naming who will answer, and clicking it opens
 * the model dialog — the same dialog the header badge opens, because there is now exactly
 * one place where any of this is configured.
 *
 * ## One button, whichever engine the tab is about
 *
 * The row sits above the tabs and stays put across all four, so the sentence in it is
 * the one thing every engine is asked. Pressing it therefore runs *the tab you are
 * looking at*: the loop on `Soundline`, the diffusion model on `Model`, the library
 * search on `Search`. The alternative — one button that always meant the recipe — put
 * the model's own Render button a scroll away from the prompt it renders, and left the
 * row's accent hue saying `Model` while the button meant something else. The label is
 * `Make sound` for the same reason: it is the one verb that is true of every engine,
 * where `Regenerate` described only the loop.
 *
 * What follows from that is that each tab is blocked by its own missing thing. On
 * `Model` the provider and the key are not consulted at all (nothing there goes to a
 * vendor — the render happens on this machine through the bridge), so what blocks the
 * button is the model not being installed. On `Search` it is the library key, which is
 * a different credential living in a different field: the provider key is optional
 * there, because a search with no model still searches, it just does not get its query
 * rewritten or its results reordered. `Compare A / B` has no engine of its own and
 * keeps the recipe's.
 *
 * The button also grows a spinner while a run is in flight. It is the smallest honest
 * signal there is: the stage list below says *what* is happening once a run reports
 * something, and until it does — a model render is ~30 s before its first line — the
 * only thing on screen that can say "yes, it started" is the control that was pressed.
 *
 * @packageDocumentation
 */

import type { ProviderKind } from '../lib/agent.js';
import { HUE } from '../lib/design.js';
import { useI18n } from '../lib/i18n.js';

/** Which of the four studio views is showing, so the row can take its hue. */
export type StudioView = 'sound' | 'model' | 'compare' | 'search';

export interface PromptRowProps {
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  /** Who will answer this prompt, as `chooseProvider` decided. `null` blocks the run. */
  readonly model: ProviderKind | null;
  /** Opens the model dialog — where the key, the model id and the agent setup live. */
  readonly onOpenSettings: () => void;
  readonly running: boolean;
  readonly stopping: boolean;
  readonly view: StudioView;
  /** Whether the diffusion model is installed — what gates the button on the Model tab. */
  readonly modelReady: boolean;
  /** Whether the library has a key — what gates the button on the Search tab. */
  readonly searchReady: boolean;
  /** Runs whichever engine `view` is about; the screen decides which. */
  readonly onRun: () => void;
  readonly onStop: () => void;
}

export function PromptRow({
  prompt,
  onPromptChange,
  model,
  onOpenSettings,
  running,
  stopping,
  view,
  modelReady,
  searchReady,
  onRun,
  onStop,
}: PromptRowProps): React.JSX.Element {
  const { t } = useI18n();

  /* Which engine this press means. Model and Search have one of their own; Compare has
     no engine and regenerating from it is regenerating the recipe. */
  const toModel = view === 'model';
  const toSearch = view === 'search';
  const blocked =
    prompt.trim() === '' || (toModel ? !modelReady : toSearch ? !searchReady : model === null);

  const hue =
    view === 'model'
      ? HUE.model
      : view === 'compare'
        ? HUE.compare
        : view === 'search'
          ? HUE.library
          : HUE.recipe;

  return (
    <div className="prompt-row" style={{ ['--hue' as string]: String(hue) }}>
      <form
        className="input-shell hue"
        onSubmit={(event) => {
          event.preventDefault();
          if (!running && !blocked) onRun();
        }}
      >
        <span className="mono caret">&gt;</span>
        <input
          type="text"
          name="prompt"
          className="mono"
          value={prompt}
          placeholder={t('prompt.placeholder')}
          aria-label={t('prompt.describeAria')}
          onChange={(event) => onPromptChange(event.target.value)}
        />

        {/* Not a picker: one word saying who answers, and a door to the one place it is
            configured. Kept in the row because "which model is about to be spent" is the
            single piece of that state nobody should have to open a dialog to learn. */}
        <button
          type="button"
          className={`chip-hue${model === null ? ' warn' : ''}`}
          title={t(model === null ? 'prompt.noModelTitle' : 'prompt.modelTitle')}
          onClick={onOpenSettings}
        >
          {model === null ? (
            <>
              <span className="warn-dot" />
              {t('prompt.noModel')}
            </>
          ) : (
            t(model === 'agent' ? 'prompt.viaAgent' : 'prompt.viaGemini')
          )}
        </button>

        {running ? (
          <button type="button" className="hue-button" onClick={onStop} disabled={stopping}>
            <span className="spinner" aria-hidden="true" />
            {stopping ? t('prompt.stopping') : t('prompt.stop')}
          </button>
        ) : (
          <button
            type="submit"
            className="hue-button"
            disabled={blocked}
            /* Which engine will answer, in the tooltip rather than in the label: the
               label is the verb and it does not change, and a button whose text moves
               under the cursor as tabs are switched is harder to aim at than one whose
               meaning is stated on hover. */
            title={t(
              toModel
                ? modelReady
                  ? 'prompt.runsModel'
                  : 'prompt.modelMissing'
                : toSearch
                  ? searchReady
                    ? 'prompt.runsSearch'
                    : 'prompt.searchMissing'
                  : model === null
                    ? 'prompt.noModelTitle'
                    : 'prompt.runsSoundline',
            )}
          >
            {t('prompt.make')}
          </button>
        )}
      </form>
    </div>
  );
}
