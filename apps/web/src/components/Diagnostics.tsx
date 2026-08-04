/**
 * Parser errors, shown the way the parser already phrases them.
 *
 * `SoundlineError` was built for two readers — a human and the LLM in the agent
 * loop — so it already carries a location, a detail and often an imperative hint.
 * The panel adds nothing but layout: inventing friendlier wording here would put
 * a second, drifting copy of every message in the codebase.
 *
 * @packageDocumentation
 */

import type { SoundlineError } from '@txt2sfx/core';

export interface DiagnosticsProps {
  readonly errors: readonly SoundlineError[];
  /** Sound-wide notes that are not parse errors, e.g. a clipped mix. */
  readonly warnings: readonly string[];
}

export function Diagnostics({ errors, warnings }: DiagnosticsProps): React.JSX.Element | null {
  if (errors.length === 0 && warnings.length === 0) return null;

  return (
    <div className="diagnostics">
      {errors.map((error, i) => (
        <div className="diag diag-error" key={`e${String(i)}`}>
          <span className="diag-where">
            {error.loc.line}:{error.loc.column}
          </span>
          <span className="diag-body">
            {error.detail}
            {error.hint === undefined ? null : <em className="diag-hint"> — {error.hint}</em>}
          </span>
          <code className="diag-code">{error.code}</code>
        </div>
      ))}
      {warnings.map((warning, i) => (
        <div className="diag diag-warn" key={`w${String(i)}`}>
          <span className="diag-where">!</span>
          <span className="diag-body">{warning}</span>
        </div>
      ))}
    </div>
  );
}
