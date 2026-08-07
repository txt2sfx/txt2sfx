/**
 * What the loop did, in one line or in all of them.
 *
 * ## Why this survived a redesign that had no place for it
 *
 * The new layout has no log panel, and matching it exactly would have meant replacing
 * the stage list with a spinner. That would delete the only place where the pipeline
 * explains itself — and the pipeline explaining itself *is* the product. "The validator
 * rejected a 400 ms pop, the render found clipping, the optimizer moved eleven numbers
 * and the model was asked again once" is the argument for doing any of this; a spinner
 * says "wait" and takes the credit for none of it.
 *
 * So it is a strip rather than a panel: one line while a run is in flight — the live
 * stage, which is the only line anyone reads at that moment — and the full history
 * behind a disclosure that is open by default *during* a run and collapsed after it,
 * leaving the verdict. Nothing is thrown away and nothing is in the way.
 *
 * ## The verdict is not a status
 *
 * `accepted` and `not accepted — stalled` are different outcomes with different next
 * actions, and both are useful. So is the distance, and so is whether the model got
 * any few-shot examples or was answering from nothing — a run with zero examples that
 * produced a poor recipe is a retrieval problem, not a model problem, and those look
 * identical if the count is not shown.
 *
 * @packageDocumentation
 */

import { useEffect, useState } from 'react';
import type { GenerateResult } from '@txt2sfx/agent';
import { FitPreview } from './FitPreview.js';

export interface RunStripProps {
  readonly running: boolean;
  readonly log: readonly string[];
  readonly progress: string | null;
  readonly best: { readonly source: string; readonly distance: number } | null;
  readonly result: GenerateResult | null;
  readonly error: string | null;
  readonly hadTarget: boolean;
  readonly seed: number;
  /** Keep the fit's current leader and end the run. */
  readonly onTake: () => void;
}

export function RunStrip({
  running,
  log,
  progress,
  best,
  result,
  error,
  hadTarget,
  seed,
  onTake,
}: RunStripProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);

  /* Open while it runs, closed when it stops. Not a one-way door: a user who collapses
     it mid-run keeps it collapsed, because the effect only fires on the transition. */
  useEffect(() => {
    setOpen(running);
  }, [running]);

  if (log.length === 0 && result === null && error === null) return null;

  const last = progress ?? log[log.length - 1] ?? '';
  const warnings = result === null ? [] : result.issues.filter((issue) => issue.severity !== 'error');

  return (
    <div className={`run${running ? ' running' : ''}`}>
      <button type="button" className="run-head" onClick={() => setOpen((current) => !current)}>
        <span className={`run-dot${running ? ' spinning' : ''}`} />
        <span className="mono run-line">
          {result === null || running ? (
            last
          ) : (
            <span className={result.accepted ? 'good' : 'bad'}>
              {result.accepted ? 'accepted' : `not accepted — ${result.outcome}`}
              {result.distance === undefined
                ? ''
                : ` · distance ${result.distance.toFixed(3)}${hadTarget ? ' to reference' : ''}`}
              {result.examples.length === 0
                ? ' · no few-shot examples'
                : ` · ${String(result.examples.length)} example(s)${result.fallbackExamples ? ' (fallback, unrelated)' : ''}`}
            </span>
          )}
        </span>
        <div className="spacer" />
        <span className="mono faint">{open ? 'hide' : `${String(log.length)} steps`}</span>
      </button>

      {open ? (
        <div className="run-log">
          {log.map((line, index) => (
            <div className="run-log-line" key={`${String(index)}-${line}`}>
              {line}
            </div>
          ))}
          {progress === null ? null : <div className="run-log-line live">{progress}</div>}
          {error === null ? null : <div className="run-log-line bad">✗ {error}</div>}
          {result?.message === undefined ? null : <div className="run-note">{result.message}</div>}
          {warnings.map((issue) => (
            <div className="run-note" key={`${issue.rule}-${issue.layer ?? ''}`}>
              {issue.rule}: {issue.got} — {issue.hint}
            </div>
          ))}
        </div>
      ) : null}

      {/* Outside the log on purpose: the log is a scrolling column with a ceiling, and a
          picture that has to be scrolled into view is a picture nobody sees. A fit is a
          minute of one number moving, and the number cannot be listened to — the leader
          can. */}
      {best === null || !running ? null : <FitPreview source={best.source} seed={seed} onTake={onTake} />}
    </div>
  );
}
