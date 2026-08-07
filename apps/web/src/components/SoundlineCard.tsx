/**
 * The recipe, editable, with the validator's verdict attached to it.
 *
 * ## Why the code is still a textarea
 *
 * The design draws this panel as a read-only syntax-coloured block, and for a *share*
 * view that is right. Here it would be wrong, and the reason is the rule the whole app
 * is organised around: **the source text is the state**. Sliders rewrite it, the
 * catalog swaps it, the model produces it, and the render, the pictures, the metrics
 * and the export are all derived from it on every keystroke. Take away the ability to
 * type into it and the sliders become the only way to change a sound — which means a
 * layer cannot be added, an effect cannot be tried, and the argument that a recipe a
 * human wrote and a recipe a model wrote are the same kind of thing stops being
 * demonstrable.
 *
 * So it keeps the design's frame, header and footer, and the block inside is the
 * existing overlay editor: a transparent `textarea` over coloured spans, both in the
 * same monospace metrics. See `components/Editor.tsx`.
 *
 * ## Why the verdict is in the footer and not in a panel
 *
 * Because it is about *this text*, and a diagnostics list two panels away is read as
 * being about the app. One line: the count in the header, the worst issue spelled out
 * below the code with the `hint` the model would have been given — the same words, so
 * a human and a model are being taught the same rule.
 *
 * @packageDocumentation
 */

import type { SoundlineError } from '@txt2sfx/core';
import type { ValidationIssue } from '@txt2sfx/shared';
import { Editor } from './Editor.js';

export interface SoundlineCardProps {
  readonly source: string;
  readonly errors: readonly SoundlineError[];
  readonly issues: readonly ValidationIssue[];
  /** Render-derived complaints: clipping, over budget, longer than declared. */
  readonly warnings: readonly string[];
  readonly onChange: (source: string) => void;
}

export function SoundlineCard({
  source,
  errors,
  issues,
  warnings,
  onChange,
}: SoundlineCardProps): React.JSX.Element {
  const hard = issues.filter((issue) => issue.severity === 'error');
  const soft = issues.filter((issue) => issue.severity !== 'error');

  /* One verdict, and it is the *worst* thing true about the recipe. A footer that
     averaged three severities into "2 notes" would make the reader open all of them to
     find out whether anything is actually broken. */
  const tone =
    errors.length > 0 || hard.length > 0 ? 'bad' : soft.length > 0 || warnings.length > 0 ? 'warn' : 'good';

  const short =
    errors.length > 0
      ? `${String(errors.length)} syntax error${errors.length === 1 ? '' : 's'}`
      : hard.length > 0
        ? `${String(hard.length)} invariant broken`
        : soft.length + warnings.length > 0
          ? `${String(soft.length + warnings.length)} warning${soft.length + warnings.length === 1 ? '' : 's'}`
          : 'validator clean';

  const kind = tone === 'bad' ? 'ERROR' : tone === 'warn' ? 'WARN' : 'OK';

  const detail =
    errors[0] !== undefined
      ? errors[0].message
      : hard[0] !== undefined
        ? `${hard[0].layer === null ? '' : `${hard[0].layer}: `}${hard[0].got} — ${hard[0].hint}`
        : soft[0] !== undefined
          ? `${soft[0].layer === null ? '' : `${soft[0].layer}: `}${soft[0].got} — ${soft[0].hint}`
          : (warnings[0] ??
            'Every decay fits inside the declared duration and the render sits below clipping.');

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="mono panel-title">SOUNDLINE</span>
        <div className="spacer" />
        <span className={`mono ${tone}`}>{short}</span>
      </div>

      <Editor source={source} errors={errors} onChange={onChange} />

      <div className="panel-foot">
        <span className={`mono ${tone}`}>{kind}</span>
        <span className="panel-foot-text">{detail}</span>
      </div>

      {/* Everything past the first, once the first has been read. Collapsed into a
          plain list rather than a second panel: the header already said how many. */}
      {errors.length + issues.length + warnings.length > 1 ? (
        <details className="more">
          <summary className="mono">everything else</summary>
          <ul>
            {errors.slice(1).map((error, index) => (
              <li key={`e${String(index)}`} className="bad">
                {error.message}
              </li>
            ))}
            {[...hard, ...soft].slice(errors.length > 0 ? 0 : 1).map((issue) => (
              <li key={`${issue.rule}-${issue.layer ?? ''}`} className={issue.severity === 'error' ? 'bad' : 'warn'}>
                {issue.rule}: {issue.got} — {issue.hint}
              </li>
            ))}
            {warnings.slice(errors.length + issues.length > 0 ? 0 : 1).map((warning) => (
              <li key={warning} className="warn">
                {warning}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
