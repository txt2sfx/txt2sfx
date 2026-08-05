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

import type { ValidationIssue } from '@txt2sfx/shared';
import type { SoundlineError } from '@txt2sfx/core';

export interface DiagnosticsProps {
  readonly errors: readonly SoundlineError[];
  /**
   * Physical invariants, from the same validator the agent loop runs.
   *
   * Kept apart from `warnings` so severity survives: an `error` here is a recipe
   * `POST /api/recipes` would refuse and the agent loop would send back, and
   * showing it in the same colour as "your export is over budget" would misprice
   * it.
   */
  readonly issues?: readonly ValidationIssue[];
  /** Sound-wide notes that are not parse errors, e.g. a clipped mix. */
  readonly warnings: readonly string[];
}

export function Diagnostics({ errors, issues = [], warnings }: DiagnosticsProps): React.JSX.Element | null {
  if (errors.length === 0 && issues.length === 0 && warnings.length === 0) return null;

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
      {issues.map((issue, i) => (
        <div className={issue.severity === 'error' ? 'diag diag-error' : 'diag diag-warn'} key={`i${String(i)}`}>
          <span className="diag-where">{issue.loc === undefined ? issue.severity : `${issue.loc.line}:${issue.loc.column}`}</span>
          <span className="diag-body">
            {issue.layer === null ? '' : `layer '${issue.layer}': `}
            {issue.got} (expected {issue.expected})
            <em className="diag-hint"> — {issue.hint}</em>
          </span>
          <code className="diag-code">{issue.rule}</code>
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
