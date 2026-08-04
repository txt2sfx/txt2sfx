/**
 * Export: the exported JavaScript, the soundline, and a WAV.
 *
 * Order matters here. The product of txt2sfx is the code, so the code is what the
 * panel shows by default and what the first button copies; the WAV is offered
 * last and labelled as a reference, because a playground that leads with
 * "download audio" quietly teaches the wrong mental model of the tool.
 *
 * @packageDocumentation
 */

import { useState } from 'react';
import { encodeWav, type CodegenResult } from '@txt2sfx/core';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';

export interface ExportPanelProps {
  readonly name: string;
  readonly source: string;
  readonly code: CodegenResult | null;
  readonly buffer: AudioBuffer | null;
}

export function ExportPanel({ name, source, code, buffer }: ExportPanelProps): React.JSX.Element {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (what: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied((current) => (current === what ? null : current)), 1200);
    });
  };

  const downloadWav = (): void => {
    if (buffer === null) return;
    const bytes = encodeWav(buffer, { bitDepth: 16 });
    // A fresh ArrayBuffer: `bytes.buffer` may be a view into a larger allocation.
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.wav`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const label = (what: string, fallback: string): string => (copied === what ? 'copied' : fallback);

  return (
    <div className="export">
      <div className="export-buttons">
        <button type="button" disabled={code === null} onClick={() => code !== null && copy('js', code.code)}>
          {label('js', 'Copy JS')}
        </button>
        <button type="button" onClick={() => copy('soundline', source)}>
          {label('soundline', 'Copy soundline')}
        </button>
        <button type="button" disabled={buffer === null} onClick={downloadWav}>
          Download WAV
        </button>
      </div>

      {code === null ? null : (
        <>
          <div className={code.withinBudget ? 'export-size ok' : 'export-size over'}>
            {code.bytes} B of {GLOBAL_LIMITS.maxExportBytes} B budget · {code.ir.nodes.length} nodes ·{' '}
            {code.ir.buffers.length} buffers
          </div>
          <pre className="export-code">{code.code}</pre>
        </>
      )}
    </div>
  );
}
