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
import { useI18n } from '../lib/i18n.js';

export interface ExportCardProps {
  readonly code: CodegenResult | null;
  readonly source: string;
  readonly peak: number | null;
  readonly seed: number;
  readonly onCompare: () => void;
}

export function ExportCard({ code, source, peak, seed, onCompare }: ExportCardProps): React.JSX.Element {
  const { t } = useI18n();
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
        <span className="mono panel-title">{t('export.title')}</span>
        <div className="spacer" />
        {note === null ? null : <span className="mono faint">{note}</span>}
        <button
          type="button"
          disabled={code === null}
          onClick={() => code !== null && void copy(code.code, t('what.js')).then(say)}
        >
          {t('export.copyJs')}
        </button>
        <button type="button" onClick={() => void copy(source, t('what.soundline')).then(say)}>
          {t('export.copySoundline')}
        </button>
      </div>

      <div className="panel-body">
        {code === null ? (
          <p className="teach">{t('export.noCompile')}</p>
        ) : (
          <>
            <div className="budget">
              <div className="budget-track">
                <div className={`budget-fill${over ? ' over' : ''}`} style={{ width: `${String(share)}%` }} />
              </div>
              <span className="mono faint">
                {t('export.of', { used: fmtBytes(used), budget: fmtBytes(budget) })}
              </span>
            </div>

            <div className="facts mono">
              <span>{t('export.nodes', { count: code.ir.nodes.length })}</span>
              <span>{t('export.buffers', { count: code.ir.buffers.length })}</span>
              <span>{t('export.peak', { value: peak === null ? '—' : peak.toFixed(3) })}</span>
              <span>{t('export.seed', { value: seed })}</span>
            </div>

            <pre className="code-block">{code.code}</pre>
          </>
        )}

        <button type="button" className="wide" onClick={onCompare}>
          {t('export.compare')}
        </button>
      </div>
    </div>
  );
}
