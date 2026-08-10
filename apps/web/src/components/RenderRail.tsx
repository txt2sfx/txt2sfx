/**
 * The renders this browser kept, down the right-hand side of the AI Render screen.
 *
 * ## Why the screen grew a rail after arguing it did not need one
 *
 * `styles.css` used to say it plainly: no catalog of diffusion renders, because a target
 * is used once. That was true of the *reference* workflow — render, `→ Compare`, fit —
 * and false of everything else. A render is thirty to sixty seconds of local CPU plus a
 * model call for the caption, it is never written to disk, and the second press of Render
 * destroyed the first. Anybody comparing four variants of a door was holding three of
 * them in their head.
 *
 * So the rail is the memory that was missing, and it sits on the **right** rather than
 * where the studio's is. The studio's rail is a *source*: you pick from it and the screen
 * follows. This one is an *output*: things arrive in it because of what the screen just
 * did, and putting the results on the left, in the position the eye reads first, would
 * make the newest render look like the subject of the screen instead of the prompt.
 *
 * ## What a row says, and what it does not
 *
 * The name a model gave it, how long it is, and the first words of the caption it answers
 * — dimmer, because the name is the identifier and the caption is the evidence behind it.
 * Play auditions without changing what is on screen; Download hands over the bytes the
 * bridge returned, unchanged and at a known size, because re-encoding a render on the way
 * out would be a second lossy pass over a lossy file for no reason at all.
 *
 * There is deliberately no "open" — a render is not a recipe and there is nothing to open
 * it *into*. What it can become is B, and that is `→ Compare` in the panel, on the render
 * that is currently loaded.
 *
 * @packageDocumentation
 */

import { useEffect, useRef, useState } from 'react';
import { save, sizeLabel } from '../lib/download.js';
import { ms } from '../lib/format.js';
import { useI18n } from '../lib/i18n.js';
import type { KeptRender } from '../lib/renders.js';

export interface RenderRailProps {
  readonly items: readonly KeptRender[];
  /** Told when a row's Download was pressed, so the screen can report it in the toast. */
  readonly onSaved?: (message: string) => void;
  readonly onForget: (id: string) => void;
}

export function RenderRail({ items, onSaved, onForget }: RenderRailProps): React.JSX.Element {
  const { t } = useI18n();
  /* One `<audio>` for the whole list rather than one per row: forty elements each holding
     an object URL is forty live blobs, and only one of them can be sounding anyway. */
  const player = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  /* The object URL outlives the play, so it is revoked when another row starts and when
     the screen goes away — a leaked blob URL keeps the whole file alive in memory. */
  useEffect(
    () => () => {
      player.current?.pause();
      if (url.current !== null) URL.revokeObjectURL(url.current);
    },
    [],
  );

  const play = (entry: KeptRender): void => {
    player.current?.pause();
    if (url.current !== null) URL.revokeObjectURL(url.current);
    url.current = null;

    if (playing === entry.id) {
      setPlaying(null);
      return;
    }

    const next = URL.createObjectURL(entry.blob);
    url.current = next;
    const audio = new Audio(next);
    audio.onended = () => setPlaying(null);
    player.current = audio;
    setPlaying(entry.id);
    void audio.play().catch(() => setPlaying(null));
  };

  const download = (entry: KeptRender): void => {
    const filename = `${entry.file === '' ? 'sfx_render' : entry.file}.${entry.extension}`;
    save(entry.blob, filename);
    onSaved?.(t('dl.savedSize', { file: filename, size: sizeLabel(entry.bytes) }));
  };

  return (
    <aside className="render-rail">
      <div className="render-rail-head">
        <span className="render-rail-title">{t('renders.title')}</span>
        <span className="faint mono">{items.length === 0 ? '' : String(items.length)}</span>
      </div>

      {items.length === 0 ? (
        <p className="render-rail-empty">{t('renders.empty')}</p>
      ) : (
        <ul className="render-rail-list">
          {items.map((entry) => (
            <li className="render-row" key={entry.id}>
              <button
                type="button"
                className={`render-play${playing === entry.id ? ' playing' : ''}`}
                title={t(playing === entry.id ? 'card.stop' : 'card.play')}
                onClick={() => play(entry)}
              >
                {playing === entry.id ? '❚❚' : '▶'}
              </button>

              <div className="render-row-body">
                <div className="render-row-top">
                  <span className="render-name" title={entry.title}>
                    {entry.title === '' ? t('renders.unnamed') : entry.title}
                  </span>
                  <span className="mono render-meta">{ms(entry.durationMs)}</span>
                </div>
                {/* The caption, dimmer than the name: it is what the name was made from,
                    and the answer to "which of these four doors is this one". */}
                <span className="render-prompt" title={entry.prompt}>
                  {entry.prompt}
                </span>
              </div>

              <button
                type="button"
                className="render-act"
                title={t('renders.downloadTitle', {
                  file: `${entry.file}.${entry.extension}`,
                  size: sizeLabel(entry.bytes),
                })}
                onClick={() => download(entry)}
              >
                ⤓
              </button>
              <button
                type="button"
                className="render-act"
                title={t('renders.forget')}
                onClick={() => onForget(entry.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
