/**
 * A split button: download the last thing chosen, or choose again.
 *
 * The shape is deliberate. Exporting the same format twenty times in a row is the
 * normal case while iterating on one sound, and a menu that must be opened for each of
 * them is twenty extra clicks; a plain button with no menu means the one time you want
 * the JavaScript instead of an MP3 you have to go looking for a different control. The
 * split solves both: the wide half repeats, the narrow half chooses, and the current
 * choice is printed on the wide half so it never has to be remembered.
 *
 * What the menu offers is argued out in `lib/download.ts` — including why the caller
 * passes the list rather than the menu reading a global one, and why the choice outlives
 * the tab. Two of the six entries — MP3 and M4A — have to be *encoded*, which takes long
 * enough to notice on a two-second sound and long enough to click twice on a slow
 * machine. So the button reports that it is working and refuses a second press while it
 * is: a download that silently produces two files is a worse outcome than one that takes
 * a moment.
 *
 * @packageDocumentation
 */

import { useEffect, useRef, useState } from 'react';
import { FORMATS, formatById, type Format } from '../lib/download.js';
import { useI18n } from '../lib/i18n.js';

export interface FormatMenuProps {
  readonly formatId: string;
  readonly onFormat: (id: string) => void;
  /** May be async — the menu awaits it so the button can show that it is encoding. */
  readonly onDownload: (format: Format) => Promise<unknown> | void;
  readonly disabled?: boolean;
  /** Extra class for the hue variants — the model view's copy is amber. */
  readonly className?: string;
  /** What this menu offers; defaults to everything. The Model tab passes audio only. */
  readonly formats?: readonly Format[];
}

export function FormatMenu({
  formatId,
  onFormat,
  onDownload,
  disabled = false,
  className = '',
  formats = FORMATS,
}: FormatMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  const format = formatById(formatId, formats);

  /* The assignment on the way *in* is the load-bearing half. Without it, React's
     development double-invoke (mount → cleanup → mount) leaves `alive` false for the rest
     of the component's life, and the button sticks on "Encoding…" forever even though the
     file saved. A `useRef` initialiser only runs once; the effect body runs on every
     mount, which is what makes this correct rather than merely working. */
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = (chosen: Format): void => {
    if (busy) return;
    const pending = onDownload(chosen);
    if (pending === undefined) return;
    /* Only the encoded formats can take long enough to be worth saying so. A WAV is
       written synchronously and a flash of "Encoding…" on it would be noise. */
    if (chosen.slow === true) setBusy(true);
    void Promise.resolve(pending).finally(() => {
      if (alive.current) setBusy(false);
    });
  };

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (host.current !== null && !host.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className={`split${className === '' ? '' : ` ${className}`}`} ref={host}>
      <div className="split-body">
        <button
          type="button"
          className="split-main"
          disabled={disabled || busy}
          title={t('format.downloadTitle', { label: format.label })}
          onClick={() => run(format)}
        >
          {busy ? t('format.encoding') : t('format.download')}
          <span className="mono split-format">{format.short}</span>
        </button>
        <button
          type="button"
          className="split-toggle"
          disabled={disabled || busy}
          aria-expanded={open}
          aria-label={t('format.chooseAria')}
          onClick={() => setOpen((current) => !current)}
        >
          ▾
        </button>
      </div>

      {open ? (
        <div className="menu" role="menu">
          {formats.map((entry) => (
            <button
              type="button"
              key={entry.id}
              role="menuitem"
              /* Against the *resolved* format, not the prop: a choice remembered from a
                 menu that offers more than this one falls back, and the tick has to
                 agree with what the wide half says it will download. */
              className={`menu-item${entry.id === format.id ? ' selected' : ''}`}
              onClick={() => {
                onFormat(entry.id);
                setOpen(false);
              }}
            >
              {entry.label}
              <span>{entry.id === format.id ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
