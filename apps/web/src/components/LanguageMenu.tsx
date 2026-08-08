/**
 * The globe in the corner.
 *
 * ## Why a menu and not a `select`
 *
 * A native `select` would be fewer lines and would inherit the platform's own dropdown,
 * which is a real argument. It loses on the one thing that matters here: the closed state.
 * A `select` shows the *chosen* language's name in the page's own font stack, so a Korean
 * reader looking for their language sees a control that says `English` and has to open it
 * to find out whether it can do anything else. A globe plus a two-letter code says "this
 * is where language lives" without being read at all.
 *
 * Every entry is written in its own language — `Deutsch`, not `German`. A reader who
 * cannot yet read the interface is exactly the reader this menu is for, and asking them
 * to recognise the English name of their own language defeats it.
 *
 * The dismissal behaviour is the same as the provider popover and the format menu:
 * outside mousedown or Escape closes it. Three popovers with three different rules would
 * be three things to learn.
 *
 * @packageDocumentation
 */

import { useEffect, useRef, useState } from 'react';
import { LANGUAGES, useI18n } from '../lib/i18n.js';

export function LanguageMenu(): React.JSX.Element {
  const { lang, setLang, t } = useI18n();
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);

  const current = LANGUAGES.find((entry) => entry.code === lang) ?? LANGUAGES[0];

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
    <div className="lang" ref={host}>
      <button
        type="button"
        className={`lang-button${open ? ' selected' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('lang.aria')}
        title={t('lang.title')}
        onClick={() => setOpen((current_) => !current_)}
      >
        <Globe />
        <span className="mono lang-code">{current.short}</span>
        <span className="caret-down">▾</span>
      </button>

      {open ? (
        <div className="menu lang-menu" role="menu">
          {LANGUAGES.map((entry) => (
            <button
              type="button"
              key={entry.code}
              role="menuitem"
              lang={entry.code}
              className={`menu-item${entry.code === lang ? ' selected' : ''}`}
              onClick={() => {
                setLang(entry.code);
                setOpen(false);
              }}
            >
              {entry.label}
              <span>{entry.code === lang ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The globe, inline.
 *
 * Drawn rather than set as the 🌐 emoji: the emoji renders as a different picture at a
 * different weight on every platform this runs on, and next to a monospace code it comes
 * out either cartoonish or invisible depending on the machine. `currentColor` makes it
 * follow the button's own hover and focus states for free.
 */
function Globe(): React.JSX.Element {
  return (
    <svg className="globe" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <circle cx="8" cy="8" r="6.1" />
        <path d="M1.9 8h12.2" />
        <ellipse cx="8" cy="8" rx="2.7" ry="6.1" />
      </g>
    </svg>
  );
}
