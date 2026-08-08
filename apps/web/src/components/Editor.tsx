/**
 * The soundline editor: a textarea with a coloured layer painted behind it.
 *
 * Not CodeMirror, and not a compromise either — the language is line-oriented and
 * a few hundred characters long, so a transparent textarea over a `<pre>` gives
 * real colouring and real error underlining for none of the weight, and keeps
 * native editing behaviour (undo, IME, selection, spellcheck-off) intact.
 *
 * The two layers must agree character for character, which is the entire reason
 * the font, padding and `white-space` live in one CSS class shared by both, and
 * why both scroll offsets are mirrored on every scroll event.
 *
 * @packageDocumentation
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import type { SoundlineError } from '@txt2sfx/core';
import { highlight } from '../lib/highlight.js';
import { useI18n } from '../lib/i18n.js';

export interface EditorProps {
  readonly source: string;
  readonly errors: readonly SoundlineError[];
  readonly onChange: (next: string) => void;
}

export function Editor({ source, errors, onChange }: EditorProps): React.JSX.Element {
  const { t } = useI18n();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const overlay = useRef<HTMLPreElement>(null);

  const spans = useMemo(() => highlight(source, errors.map((e) => e.loc)), [source, errors]);

  /* Slider edits change the text under the cursor; re-sync after every paint so
     the overlay never lags the textarea by a frame. */
  useLayoutEffect(() => {
    const ta = textarea.current;
    const pre = overlay.current;
    if (ta === null || pre === null) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  }, [source]);

  return (
    <div className="editor">
      <pre className="editor-layer editor-overlay" ref={overlay} aria-hidden="true">
        {spans.map((span, i) => (
          <span key={i} className={span.cls === '' ? undefined : span.cls}>
            {span.text}
          </span>
        ))}
        {'\n'}
      </pre>
      <textarea
        className="editor-layer editor-input"
        ref={textarea}
        name="soundline"
        value={source}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={t('editor.aria')}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          const pre = overlay.current;
          if (pre === null) return;
          pre.scrollTop = event.currentTarget.scrollTop;
          pre.scrollLeft = event.currentTarget.scrollLeft;
        }}
      />
    </div>
  );
}
