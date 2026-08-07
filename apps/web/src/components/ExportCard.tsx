/**
 * What ships, and what it costs.
 *
 * The order of this panel is an argument. The **JavaScript** is first and is the only
 * thing with a copy button of its own, because it is the deliverable — a few hundred
 * bytes with no assets and no dependencies. The **budget bar** is second, because the
 * one number that decides whether a recipe is usable is how big it came out. Audio is
 * not here at all: it is one entry in the download menu upstairs, filed with the other
 * inspection formats, and a playground whose Export panel leads with "download WAV"
 * teaches the wrong mental model of the tool.
 *
 * The node and buffer counts are next to the size for a specific reason: when a recipe
 * is over budget, the cause is almost always a procedural buffer generator — those are
 * a fixed cost per distinct buffer, and they are exactly what a fourth layer of
 * filtered noise adds. Seeing `11 nodes · 3 buffers` beside `1.4 kB` is the difference
 * between "shorten something" and "share a noise source between two layers".
 *
 * @packageDocumentation
 */

import { useState } from 'react';
import type { CodegenResult } from '@txt2sfx/core';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { copy } from '../lib/download.js';
import { bytes as fmtBytes } from '../lib/format.js';

export interface ExportCardProps {
  readonly code: CodegenResult | null;
  readonly source: string;
  readonly peak: number | null;
  readonly seed: number;
  readonly onCompare: () => void;
}

export function ExportCard({ code, source, peak, seed, onCompare }: ExportCardProps): React.JSX.Element {
  const [note, setNote] = useState<string | null>(null);

  const say = (message: string): void => {
    setNote(message);
    window.setTimeout(() => setNote((current) => (current === message ? null : current)), 1400);
  };

  const budget = GLOBAL_LIMITS.maxExportBytes;
  const used = code?.bytes ?? 0;
  const share = Math.min(100, Math.round((used / budget) * 100));
  const over = code !== null && !code.withinBudget;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="mono panel-title">EXPORT</span>
        <div className="spacer" />
        {note === null ? null : <span className="mono faint">{note}</span>}
        <button
          type="button"
          disabled={code === null}
          onClick={() => code !== null && void copy(code.code, 'the JavaScript').then(say)}
        >
          Copy JS
        </button>
        <button type="button" onClick={() => void copy(source, 'the soundline').then(say)}>
          Copy soundline
        </button>
      </div>

      <div className="panel-body">
        {code === null ? (
          <p className="teach">The recipe does not compile, so there is nothing to size yet.</p>
        ) : (
          <>
            <div className="budget">
              <div className="budget-track">
                <div className={`budget-fill${over ? ' over' : ''}`} style={{ width: `${String(share)}%` }} />
              </div>
              <span className="mono faint">
                {fmtBytes(used)} of {fmtBytes(budget)}
              </span>
            </div>

            <div className="facts mono">
              <span>{code.ir.nodes.length} nodes</span>
              <span>{code.ir.buffers.length} buffers</span>
              <span>peak {peak === null ? '—' : peak.toFixed(3)}</span>
              <span>seed {seed}</span>
            </div>

            <pre className="code-block">{code.code}</pre>
          </>
        )}

        <button type="button" className="wide" onClick={onCompare}>
          Compare A / B ↑
        </button>
      </div>
    </div>
  );
}
