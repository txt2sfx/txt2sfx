/**
 * Two ways to offer the same download menu.
 *
 * {@link FormatMenu} is a **split button**: download the last thing chosen, or choose
 * again. The shape is deliberate. Exporting the same format twenty times in a row is the
 * normal case while iterating on one sound, and a menu that must be opened for each of
 * them is twenty extra clicks; a plain button with no menu means the one time you want
 * the JavaScript instead of an MP3 you have to go looking for a different control. The
 * split solves both: the wide half repeats, the narrow half chooses, and the current
 * choice is printed on the wide half so it never has to be remembered.
 *
 * {@link DownloadMenu} is the same menu with **no remembered choice and no wide half** —
 * one glyph that opens the list, where picking an entry downloads it. That is the right
 * shape on a gallery card and the wrong one in the studio, for the reason the split
 * exists: nobody exports the same card twenty times, so the repeat half would be a
 * button whose action is invisible state, on a surface with no room to print it.
 *
 * What either menu offers is argued out in `lib/download.ts` — including why the caller
 * passes the list rather than the menu reading a global one, and why the choice outlives
 * the tab. Two of the six entries — MP3 and M4A — have to be *encoded*, which takes long
 * enough to notice on a two-second sound and long enough to click twice on a slow
 * machine. So the button reports that it is working and refuses a second press while it
 * is: a download that silently produces two files is a worse outcome than one that takes
 * a moment.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IconDownload } from './Icons.js';
import { FORMATS, estimateBytes, formatById, sizeLabel, type Format } from '../lib/download.js';
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
  /**
   * What is about to be encoded, so the menu can say what each entry will weigh.
   *
   * Optional, and absent on a gallery card on purpose: nothing there is rendered yet, and
   * rendering forty cards to print forty file sizes is the exact cost the card's own
   * download avoids. See `estimateBytes` for why the numbers can be trusted.
   */
  readonly buffer?: AudioBuffer | null;
}

/**
 * Fire a download and report whether it is still going.
 *
 * Shared by both shapes because the trap in it is not obvious: the promise has to be
 * awaited to know when an encode finished, and the component can be gone by then.
 */
function useRunner(onDownload: (format: Format) => Promise<unknown> | void): {
  readonly busy: boolean;
  readonly run: (chosen: Format) => void;
} {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

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

  return { busy, run };
}

/** What an entry will weigh, or an empty string where that cannot be known yet. */
function sizeOf(format: Format, buffer: AudioBuffer | null): string {
  const bytes = estimateBytes(format, buffer);
  return bytes === null ? '' : sizeLabel(bytes);
}

/** Close an open menu on a click outside it or on Escape. */
function useDismiss(open: boolean, host: React.RefObject<HTMLDivElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (host.current !== null && !host.current.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [open, host, close]);
}

export function FormatMenu({
  formatId,
  onFormat,
  onDownload,
  disabled = false,
  className = '',
  formats = FORMATS,
  buffer = null,
}: FormatMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const { busy, run } = useRunner(onDownload);
  const format = formatById(formatId, formats);
  const bytes = estimateBytes(format, buffer);

  useDismiss(
    open,
    host,
    useCallback(() => setOpen(false), []),
  );

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
          {/* What it will weigh, before the click rather than in the toast after: the
              formats on offer differ by an order of magnitude, and that difference is the
              whole reason to pick one. */}
          {bytes === null ? null : <span className="mono split-size">{sizeLabel(bytes)}</span>}
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
              <span className="menu-right mono">
                {sizeOf(entry, buffer)}
                {entry.id === format.id ? ' ✓' : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface DownloadMenuProps {
  /** May be async — the glyph awaits it so it can show that it is encoding. */
  readonly onDownload: (format: Format) => Promise<unknown> | void;
  readonly disabled?: boolean;
  readonly formats?: readonly Format[];
  /** What the glyph says on hover; the caller names the thing being downloaded. */
  readonly title?: string;
  readonly className?: string;
  /**
   * Told whenever the menu opens or closes.
   *
   * The card that hosts this is `overflow: hidden` — it has to be, its corners are
   * rounded and its waveform is drawn to the edge — so the popover has to be let out
   * for as long as it is showing, and only the host can do that to itself.
   */
  readonly onOpenChange?: (open: boolean) => void;
}

/**
 * A glyph that opens the format list, where picking an entry downloads it.
 *
 * No remembered choice, deliberately: see the header. Every entry is an action, so there
 * is no tick and no state the button has to print.
 */
export function DownloadMenu({
  onDownload,
  disabled = false,
  formats = FORMATS,
  title,
  className = '',
  onOpenChange,
}: DownloadMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const { busy, run } = useRunner(onDownload);

  const change = useCallback(
    (next: boolean): void => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useDismiss(
    open,
    host,
    useCallback(() => change(false), [change]),
  );

  return (
    <div className={`icon-menu${className === '' ? '' : ` ${className}`}`} ref={host}>
      <button
        type="button"
        className="icon-download"
        disabled={disabled || busy}
        aria-expanded={open}
        aria-label={t('format.chooseAria')}
        title={busy ? t('format.encoding') : (title ?? t('format.download'))}
        onClick={() => change(!open)}
      >
        {busy ? '⋯' : <IconDownload size={14} />}
      </button>

      {open ? (
        <div className="menu menu-up" role="menu">
          {formats.map((entry) => (
            <button
              type="button"
              key={entry.id}
              role="menuitem"
              className="menu-item"
              /* Closed before the download rather than after it: an MP3 takes long enough
                 to encode that a menu still standing open reads as a press that missed. */
              onClick={() => {
                change(false);
                run(entry);
              }}
            >
              {entry.label}
              <span className="mono faint">{entry.short}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
