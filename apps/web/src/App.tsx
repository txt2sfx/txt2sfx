/**
 * The playground.
 *
 * One rule organizes the whole component: **the source text is the state**.
 * Sliders rewrite it, the gallery swaps it, and everything else — the parse, the
 * compile, the render, the pictures, the export — is derived from it on every
 * keystroke. Nothing is cached that could disagree with what the editor shows,
 * which is the only way an audition loop stays trustworthy.
 *
 * Not here, on purpose: the prompt bar and the API-key field. Text-to-soundline
 * needs the agent (phase 7) and the validator (phase 3) to be worth using; this
 * app is the local half — edit, hear, tweak, export — and it needs no key at all.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_SEED,
  codegen,
  declaredDurationMs,
  parseWithDiagnostics,
  type CodegenResult,
  type RenderResult,
} from '@txt2sfx/core';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { Compare } from './components/Compare.js';
import { Diagnostics } from './components/Diagnostics.js';
import { Editor } from './components/Editor.js';
import { ExportPanel } from './components/ExportPanel.js';
import { Gallery } from './components/Gallery.js';
import { Sliders } from './components/Sliders.js';
import { Timeline } from './components/Timeline.js';
import { Visualizer } from './components/Visualizer.js';
import { decodeAudioFile, type Reference } from './lib/analysis.js';
import { bundledRecipes, canSave, fetchRecipes, saveRecipe, type Recipe } from './lib/examples.js';
import { playBuffer, playLive, type Playback } from './lib/engine.js';
import { render } from './lib/engine.js';
import { applySlot, collectSlots, type Slot } from './lib/slots.js';

/** How long to wait after the last edit before re-rendering offline. */
const RENDER_DEBOUNCE_MS = 140;

/** How long to wait after the last edit before an auto-play retrigger. */
const AUTOPLAY_DEBOUNCE_MS = 260;

export function App(): React.JSX.Element {
  const [recipes, setRecipes] = useState<readonly Recipe[]>(bundledRecipes);
  const [selected, setSelected] = useState<string>(() => bundledRecipes()[0]?.name ?? '');
  /** Editor buffers, keyed by recipe name. Absent means "as on disk". */
  const [edits, setEdits] = useState<Readonly<Record<string, string>>>({});
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [autoPlay, setAutoPlay] = useState(true);
  const [saveName, setSaveName] = useState(selected);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [rendered, setRendered] = useState<RenderResult | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  /* The reference lives in memory only: it is the user's file, and a playground
     has no business copying it anywhere. It outlives recipe switches on purpose —
     comparing several candidates against one target is the normal workflow. */
  const [reference, setReference] = useState<Reference | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  const playback = useRef<Playback | null>(null);
  const lastPlayed = useRef<string>('');

  /* Ask the dev endpoint what is actually on disk. The bundled snapshot only
     refreshes when the dev server restarts, so a recipe saved in an earlier
     session would otherwise be missing from the gallery. */
  useEffect(() => {
    let cancelled = false;
    void fetchRecipes().then((list) => {
      if (!cancelled && list.length > 0) setRecipes(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onDisk = useMemo(() => new Map(recipes.map((r) => [r.name, r.source])), [recipes]);
  const source = edits[selected] ?? onDisk.get(selected) ?? '';
  const dirty = useMemo(() => Object.keys(edits).filter((name) => edits[name] !== onDisk.get(name)), [edits, onDisk]);

  const parsed = useMemo(() => parseWithDiagnostics(source), [source]);
  const ast = parsed.ast;
  const slots = useMemo(() => (ast === null ? [] : collectSlots(ast)), [ast]);

  /** Codegen can throw on a compile-time contract the parser cannot see. */
  const code = useMemo<CodegenResult | null>(() => {
    if (ast === null) return null;
    try {
      return codegen(ast, { seed });
    } catch {
      return null;
    }
  }, [ast, seed]);

  /* --- rendering ---------------------------------------------------------- */

  useEffect(() => {
    if (ast === null) {
      setRendered(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void render(ast, { seed })
        .then((result) => {
          if (cancelled) return;
          setRendered(result);
          setRenderError(null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setRendered(null);
          setRenderError(String(error));
        });
    }, RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ast, seed]);

  /* --- playback ---------------------------------------------------------- */

  const stop = useCallback(() => {
    playback.current?.stop();
    playback.current = null;
  }, []);

  const play = useCallback(() => {
    if (ast === null) return;
    stop();
    playback.current = playLive(ast, { seed }).playback;
  }, [ast, seed, stop]);

  const loop = useCallback(() => {
    if (rendered === null) return;
    stop();
    playback.current = playBuffer(rendered.buffer, { loop: true });
  }, [rendered, stop]);

  /* Retrigger while a knob moves: the point of the sliders is hearing the
     change, and reaching for Play after every nudge defeats it. */
  useEffect(() => {
    if (!autoPlay || ast === null) return;
    if (lastPlayed.current === '') {
      lastPlayed.current = source;
      return;
    }
    if (lastPlayed.current === source) return;
    const timer = window.setTimeout(() => {
      lastPlayed.current = source;
      play();
    }, AUTOPLAY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [source, autoPlay, ast, play]);

  useEffect(() => stop, [stop]);

  const loadReference = useCallback((file: File) => {
    setReferenceError(null);
    void decodeAudioFile(file)
      .then((buffer) => setReference({ name: file.name, buffer }))
      .catch((error: unknown) => {
        setReference(null);
        setReferenceError(`could not decode ${file.name}: ${String(error)}`);
      });
  }, []);

  const clearReference = useCallback(() => {
    setReference(null);
    setReferenceError(null);
  }, []);

  /* --- editing ----------------------------------------------------------- */

  const setSource = useCallback(
    (next: string) => {
      setEdits((current) => ({ ...current, [selected]: next }));
    },
    [selected],
  );

  const onSlotChange = useCallback(
    (slot: Slot, value: number) => {
      setSource(applySlot(source, slot, value));
    },
    [source, setSource],
  );

  const select = useCallback(
    (name: string) => {
      stop();
      setSelected(name);
      setSaveName(name);
      setSaveStatus(null);
      lastPlayed.current = '';
    },
    [stop],
  );

  const revert = useCallback(() => {
    setEdits((current) => {
      const next = { ...current };
      delete next[selected];
      return next;
    });
    lastPlayed.current = '';
  }, [selected]);

  const save = useCallback(() => {
    const name = saveName.trim();
    /* Renaming into a recipe that already exists overwrites someone else's work.
       Same-name saves — the common case — are never interrupted. */
    if (name !== selected && onDisk.has(name)) {
      const proceed = window.confirm(`examples/${name}.soundline already exists. Overwrite it?`);
      if (!proceed) return;
    }
    void saveRecipe(name, source)
      .then((path) => {
        setRecipes((current) => {
          const without = current.filter((r) => r.name !== name);
          return [...without, { name, source }].sort((a, b) => a.name.localeCompare(b.name));
        });
        /* Only the name that was written becomes clean. Saving under a *different*
           name is "save a copy": the buffer you were editing keeps its edits and
           stays marked dirty, because dropping them here would delete work the
           user never asked to discard. */
        setEdits((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
        setSelected(name);
        setSaveStatus(`saved ${path}`);
      })
      .catch((error: unknown) => setSaveStatus(String(error)));
  }, [saveName, source, selected, onDisk]);

  /* Ctrl/Cmd+Enter plays, Ctrl/Cmd+S saves. Space is off limits — it belongs to
     the textarea, and an editor that swallows spaces is not an editor. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        play();
      } else if (event.key.toLowerCase() === 's' && canSave) {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [play, save]);

  /* --- render ------------------------------------------------------------ */

  const warnings: string[] = [];
  if (rendered?.clipped === true) {
    warnings.push(
      `mix peaks at ${rendered.peak.toFixed(3)}, above the ${String(GLOBAL_LIMITS.maxPeak)} limit — lower a layer's gain rather than normalizing`,
    );
  }
  if (ast !== null && rendered !== null) {
    const declared = declaredDurationMs(ast);
    const actual = rendered.durationMs - 50;
    if (actual > declared * 1.15) {
      warnings.push(`sound runs ~${String(Math.round(actual))}ms but the header declares ${String(Math.round(declared))}ms`);
    }
  }
  if (code !== null && !code.withinBudget) {
    warnings.push(`export is ${String(code.bytes)} B, over the ${String(GLOBAL_LIMITS.maxExportBytes)} B budget`);
  }
  if (renderError !== null) warnings.push(renderError);
  if (referenceError !== null) warnings.push(referenceError);

  const isDirty = dirty.includes(selected);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          txt2sfx <span className="brand-sub">soundline playground</span>
        </div>

        <div className="transport">
          <button type="button" className="primary" onClick={play} disabled={ast === null}>
            ▶ Play
          </button>
          <button type="button" onClick={loop} disabled={rendered === null}>
            ↻ Loop
          </button>
          <button type="button" onClick={stop}>
            ■ Stop
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              name="autoplay"
              checked={autoPlay}
              onChange={(e) => setAutoPlay(e.target.checked)}
            />
            auto
          </label>
          <label className="seed">
            seed
            <input
              type="number"
              name="seed"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.valueAsNumber || 0))}
            />
          </label>
          <button type="button" title="new random seed" onClick={() => setSeed(Math.floor(Math.random() * 0xffff))}>
            rnd
          </button>
        </div>

        <div className="stats">
          {rendered === null ? (
            <span className="stat muted">—</span>
          ) : (
            <>
              <span className={rendered.clipped ? 'stat bad' : 'stat'}>peak {rendered.peak.toFixed(3)}</span>
              <span className="stat">{Math.round(rendered.durationMs)}ms</span>
            </>
          )}
          {code === null ? null : (
            <span className={code.withinBudget ? 'stat' : 'stat warn'}>{code.bytes}B</span>
          )}
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <Gallery recipes={recipes} selected={selected} dirty={dirty} onSelect={select} />
          <div className="sidebar-foot">
            {canSave ? (
              <>
                <input
                  className="save-name"
                  name="recipe-name"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  aria-label="recipe file name"
                />
                <div className="sidebar-buttons">
                  <button type="button" className="primary" onClick={save}>
                    Save
                  </button>
                  <button type="button" onClick={revert} disabled={!isDirty}>
                    Revert
                  </button>
                </div>
                {saveStatus === null ? null : <div className="save-status">{saveStatus}</div>}
              </>
            ) : (
              <div className="hint">Static build — use “Copy soundline”.</div>
            )}
          </div>
        </aside>

        <main className="main">
          <section className="pane">
            <Editor source={source} errors={parsed.errors} onChange={setSource} />
            <Diagnostics errors={parsed.errors} warnings={warnings} />
          </section>

          <section className="pane">
            <Visualizer
              buffer={rendered?.buffer ?? null}
              declaredMs={ast === null ? 0 : declaredDurationMs(ast)}
              maxPeak={GLOBAL_LIMITS.maxPeak}
            />
            <Timeline ast={ast} totalMs={rendered?.durationMs ?? 0} />
          </section>

          <section className="pane">
            <h2>Slots</h2>
            <Sliders slots={slots} layerNames={ast?.layers.map((l) => l.name) ?? []} onChange={onSlotChange} />
          </section>

          <section className="pane">
            <h2>Export</h2>
            <ExportPanel name={selected} source={source} code={code} buffer={rendered?.buffer ?? null} />
          </section>

          <section className="pane pane-wide">
            <h2>Compare with a reference</h2>
            <Compare
              candidateName={selected}
              candidate={rendered?.buffer ?? null}
              reference={reference}
              onLoadReference={loadReference}
              onClearReference={clearReference}
            />
          </section>
        </main>
      </div>
    </div>
  );
}
