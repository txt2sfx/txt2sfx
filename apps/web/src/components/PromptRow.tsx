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
 * `lib/agent.ts` is that rule, and everything on this screen reads it — so the gear beside
 * the button, the button's own disabled state and the run cannot disagree.
 *
 * ## Why a gear and not the provider's name
 *
 * `via your agent` was a label pretending to be a control. It sat between the prompt and
 * the button — the widest thing in the row after the text itself — to report a fact that
 * changes maybe twice a week, and the two states rendered at different widths, so the
 * button it preceded moved sideways depending on whether a key was pasted. A door needs
 * to look like a door and stay where it was left.
 *
 * So it is a gear, and it is *after* the run button rather than before it: the row reads
 * prompt → run, and settings are what you reach for when that reading did not work out.
 * The one state worth interrupting for survives — with nothing able to answer, the gear
 * goes amber and carries a dot, because it is then the only thing standing between the
 * prompt and a run. Who answers, when somebody does, is on hover and in the dialog.
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
 * What follows from that is that each tab is blocked by its own missing thing — except
 * the recipe, which is no longer blocked at all. With no agent and no key the press
 * *searches* the bank and the bundled catalog instead of writing anything, and the label
 * changes to `Find in bank` so the button never claims the thing it is not doing. The
 * gear stays amber beside it, because "there is no model" is still the fact.
 *
 * On `Model` the provider and the key are not consulted at all (nothing there goes to a
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
  /**
   * The recipe engine with nothing able to write one: the press searches instead.
   *
   * Not a disabled button any more. The bank is a searchable catalog and fifty presets
   * ship in the build, so a sentence typed here still has an answer — it is simply one
   * that already existed, and the label says which of the two is about to happen. Every
   * other surface of that boundary is listed in `lib/retrieval.ts`.
   */
  const toRetrieval = !toModel && !toSearch && model === null;
  const blocked = prompt.trim() === '' || (toModel ? !modelReady : toSearch ? !searchReady : false);

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
                  : toRetrieval
                    ? 'prompt.runsRetrieve'
                    : 'prompt.runsSoundline',
            )}
          >
            {/* The one exception to "the label is the verb and it does not change": a
                press that searches the catalog must not read `Make sound`, because that
                is the sentence the whole honesty argument is about. */}
            {t(toRetrieval ? 'prompt.find' : 'prompt.make')}
          </button>
        )}

        {/* The door to the one place any of this is configured. After the run button,
            because it is what you reach for when pressing that did not work out — and
            amber with a dot in the one state where pressing it is the next thing to do. */}
        <button
          type="button"
          className={`chip-hue gear${model === null ? ' warn' : ''}`}
          aria-label={t('prompt.settingsAria')}
          title={t(
            model === null
              ? 'prompt.noModelTitle'
              : model === 'agent'
                ? 'prompt.modelTitleAgent'
                : 'prompt.modelTitleGemini',
          )}
          onClick={onOpenSettings}
        >
          <Gear />
          {model === null ? <span className="warn-dot" /> : null}
        </button>
      </form>
    </div>
  );
}

/**
 * A gear, drawn rather than typed.
 *
 * The same argument as `LanguageMenu`'s globe: ⚙ is an emoji on most platforms and comes
 * out either coloured and cartoonish or, on the machines that pick the text presentation,
 * a grey glyph half the weight of everything around it. `currentColor` makes it follow the
 * button's own state instead — including the amber one — for free.
 *
 * Supplied as artwork, so the coordinates are kept exactly as given, flipping transform
 * and all: the outline is filled rather than stroked, and re-deriving it at 16 units to
 * make the numbers prettier would be redrawing somebody's icon by hand.
 */
function Gear(): React.JSX.Element {
  return (
    <svg viewBox="0 0 2000 2000" width="15" height="15" aria-hidden="true" focusable="false">
      <g transform="matrix(.1 0 0 -.1 0 2000)" fill="currentColor" stroke="none">
        <path d="M9220 19989 c-515 -48 -969 -266 -1336 -641 -179 -183 -284 -331 -390 -553 -34 -71 -182 -441 -329 -821 l-267 -692 -839 -476 -839 -476 -717 110 c-395 60 -767 114 -828 121 -135 14 -404 6 -530 -16 -606 -106 -1121 -435 -1442 -920 -84 -126 -712 -1233 -757 -1333 -119 -266 -172 -494 -183 -787 -18 -485 116 -936 396 -1329 31 -43 264 -336 518 -650 l462 -571 1 -956 0 -956 -470 -599 c-259 -329 -495 -636 -525 -681 -251 -377 -368 -798 -352 -1268 7 -191 29 -330 81 -511 37 -128 107 -300 164 -404 86 -156 635 -1114 668 -1167 263 -410 665 -720 1140 -879 267 -89 584 -124 862 -93 53 6 421 60 818 120 l721 109 824 -474 824 -474 273 -704 c285 -737 355 -895 470 -1068 312 -470 824 -807 1387 -915 163 -31 349 -37 1085 -32 785 4 812 6 1030 63 391 103 704 285 1000 583 144 145 232 261 329 431 80 141 93 172 396 954 145 373 267 682 272 687 4 4 376 219 826 478 l818 471 717 -110 c862 -131 890 -134 1102 -127 177 7 297 23 452 63 496 125 960 453 1241 877 87 131 656 1124 732 1277 285 574 286 1278 2 1862 -112 229 -148 277 -915 1223 l-251 310 -1 956 0 956 470 599 c259 329 501 644 537 698 144 217 260 508 307 766 80 445 29 877 -151 1275 -56 123 -660 1186 -760 1337 -166 250 -392 465 -658 625 -133 80 -166 97 -323 159 -238 96 -453 142 -707 151 -206 7 -235 4 -1101 -128 l-721 -109 -824 474 -824 474 -270 695 c-148 383 -287 734 -309 782 -96 213 -228 406 -396 579 -379 391 -830 608 -1360 656 -134 12 -1421 11 -1550 -1z m1517 -1434 c37 -9 110 -37 162 -62 127 -63 248 -180 308 -298 22 -44 183 -448 358 -898 174 -450 332 -845 351 -877 41 -71 119 -157 182 -203 75 -55 2170 -1257 2246 -1290 75 -31 191 -56 269 -57 26 0 446 61 933 135 528 81 914 135 957 135 107 0 201 -24 305 -76 100 -50 209 -142 265 -223 17 -25 170 -288 339 -585 363 -635 362 -634 362 -836 0 -146 -14 -211 -70 -321 -36 -72 -38 -75 -614 -809 -556 -710 -559 -714 -600 -804 -62 -136 -60 -91 -60 -1490 0 -1439 -4 -1354 77 -1514 41 -79 131 -195 583 -754 294 -364 555 -689 578 -722 102 -142 136 -248 136 -421 1 -142 -15 -210 -76 -329 -69 -136 -598 -1057 -639 -1112 -124 -168 -352 -284 -559 -284 -49 0 -389 48 -931 132 -723 112 -872 132 -969 132 -175 0 -207 -13 -677 -283 -1031 -591 -1782 -1026 -1823 -1056 -92 -68 -179 -175 -221 -272 -12 -26 -160 -407 -330 -846 -170 -439 -319 -817 -330 -840 -108 -211 -304 -354 -534 -387 -56 -8 -282 -10 -750 -8 -752 4 -713 1 -875 81 -113 56 -239 179 -294 285 -21 40 -179 438 -352 884 -173 446 -330 841 -350 878 -41 78 -122 172 -192 223 -39 28 -948 554 -1996 1156 -153 87 -257 140 -310 157 -157 50 -150 51 -1139 -100 -492 -76 -919 -136 -957 -136 -225 0 -465 131 -588 322 -65 102 -603 1048 -633 1115 -47 102 -63 192 -56 318 9 158 48 270 140 395 23 30 269 346 548 701 278 355 521 667 538 693 18 26 46 76 62 112 61 134 59 85 59 1480 0 1124 -2 1284 -16 1351 -18 87 -57 179 -104 248 -18 26 -268 339 -556 697 -289 357 -542 673 -563 702 -50 68 -93 155 -116 236 -26 90 -27 280 -2 369 24 90 50 138 385 724 325 569 353 609 489 698 112 73 226 110 353 116 97 4 168 -5 955 -126 468 -72 882 -134 920 -137 96 -8 238 17 329 60 79 37 2186 1232 2252 1277 64 44 158 152 198 228 20 38 173 423 342 857 168 434 317 816 332 849 84 192 271 352 474 404 68 18 119 19 750 20 576 1 687 -1 745 -14z" />
        <path d="M9620 13551 c-488 -63 -837 -167 -1245 -373 -492 -248 -947 -639 -1277 -1098 -312 -434 -528 -952 -617 -1485 -43 -258 -54 -406 -48 -655 8 -329 38 -553 113 -840 187 -711 568 -1319 1134 -1811 372 -323 848 -581 1330 -719 305 -87 566 -127 890 -137 931 -27 1835 311 2515 940 270 250 497 530 662 817 346 600 509 1239 490 1910 -20 674 -211 1284 -580 1852 -427 657 -1083 1169 -1824 1422 -385 132 -694 184 -1128 191 -223 3 -295 1 -415 -14z m641 -1426 c389 -51 703 -177 1014 -405 107 -79 304 -266 385 -365 188 -230 331 -514 410 -810 61 -231 64 -262 65 -525 0 -275 -12 -372 -72 -590 -101 -372 -286 -683 -570 -961 -323 -317 -704 -509 -1158 -585 -157 -26 -562 -27 -685 -1 -251 54 -413 108 -605 202 -229 112 -397 236 -584 431 -397 413 -601 918 -601 1489 0 332 72 640 219 940 131 268 318 503 556 703 302 254 686 421 1090 477 128 18 400 18 536 0z" />
      </g>
    </svg>
  );
}
