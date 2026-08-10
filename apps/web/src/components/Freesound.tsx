/**
 * The third answer: a recording somebody already made.
 *
 * ## Why a library is in the building
 *
 * The same argument as the AI Render screen, one step further. What this project ships
 * is a few hundred bytes of JavaScript; a diffusion render and a field recording are
 * both **targets** — the thing you point at and say "closer to that". The render screen
 * makes one on this machine in thirty seconds of CPU; this finds one somebody already
 * recorded, in one request. Neither is a deliverable, and the block says so out loud
 * rather than growing an export button that would imply otherwise.
 *
 * Everything found here ends where a dropped file ends: the B side of Compare, and
 * from there `⌖ Fit to reference` and `match reference` apply unchanged.
 *
 * ## Why this is two exports and not one panel
 *
 * Because the two halves answer to different owners now. The search runs on the
 * **gallery**, under the catalog and against the same box — somebody looking for a door
 * slam wants both answers to that one question, and asking it twice in two places was
 * the arrangement that made the library feel like a separate application. So
 * {@link FreesoundResults} is the answer block, and {@link FreesoundButton} is the
 * account, which belongs beside the search box rather than on top of the results: it is
 * a property of the session, not of this query.
 *
 * ## Why the account control is a sign-in and not a field
 *
 * Because the alternative is not allowed and no longer exists. Freesound's API terms
 * forbid answering for people who are not logged in to Freesound themselves, and what
 * their settings hand out is an *application*, not a per-person key. So the button asks
 * the user to connect their own account, and the payoff is not only compliance: the
 * download menu can then hand over the **original** file, which a pasted key never
 * could — that endpoint is OAuth2-only.
 *
 * ## What each control is for
 *
 * The **licence chip is not a preference**, it is the difference between a sound you
 * can use and a sound that puts an obligation on whatever ships it. CC0 is the default
 * for that reason, "all licences" is one click away, and every row that carries an
 * obligation says so on its badge and hands over a credit line ready to paste. That is
 * also the honest reason this tab exists at all next to the bench work: a corpus
 * filtered to CC0 is a corpus this project can publish results against.
 *
 * The **length chip** is the one filter that changes what the ranking sees. A request
 * for a door slam and a 47-second door *ambience* are both "about doors" to a text
 * index, and no amount of reordering fixes a page that is all ambience — so duration
 * filters in the query, where it is a fact, rather than in the ranking, where it would
 * be a judgement.
 *
 * Changing either re-runs the search and spends no model call: the words and the
 * ranking notes are kept and reapplied by id. See `lib/useSearch.ts`.
 *
 * ## Why every row draws a waveform, and how it affords to
 *
 * Because the list is answering *which of these is the sound*, and thirty names in a
 * column answer that badly: `door_slam_heavy.wav` and `door ambience` differ in one
 * respect that matters — one is a hit and the other is a bed — and that difference is
 * visible in a hundred pixels of envelope before anything is played. It is the same
 * argument the gallery card makes, so it uses the same renderer.
 *
 * The affording is the interesting half. Drawing means decoding, decoding means
 * fetching the whole preview, and thirty of those at once on a search is megabytes
 * nobody asked for. So a row asks for its waveform only when it is **on screen**
 * (`IntersectionObserver`), at most {@link DECODE_LIMIT} at a time, once per sound and
 * never again — a failed decode is remembered as a failure rather than retried
 * forever. Until then the row shows a `ghostBars` placeholder, which is a shape and not
 * a claim: it is derived from the id, so it is stable, and it is dimmed, so it does not
 * read as a measurement.
 *
 * ## Why play is an `<audio>` element and B is not
 *
 * Auditioning wants the first hundred milliseconds now, and a streaming element gives
 * that for free. The B side wants samples, which means the whole file and
 * `decodeAudioData` — one round trip more, spent only on the one sound someone chose.
 * Both roads are open because `cdn.freesound.org` sends `Access-Control-Allow-Origin`,
 * which is measured in `lib/freesound.ts` rather than assumed.
 *
 * ## Why the format menu keeps its own choice here
 *
 * The block owns the whole download — fetch, decode, encode, name — so unlike the
 * recipe's and the model's menus there is nothing for the screen above to hold. The
 * choice still outlives the screen, because it lives in `lib/download.ts`'s per-scope
 * memory, and it starts on **Original**: re-encoding a stranger's recording before
 * anybody asked is a quality loss taken on their behalf.
 *
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bars } from './Bars.js';
import { FormatMenu } from './FormatMenu.js';
import { decodeAudioFile } from '../lib/analysis.js';
import {
  LIBRARY_FORMATS,
  copy,
  download,
  loadFormat,
  save,
  saveFormat,
  type Format,
} from '../lib/download.js';
import {
  attributionFor,
  fetchOriginal,
  fetchPreview,
  licenceOf,
  needsAttribution,
  safeName,
  type FreesoundSound,
  type Licence,
} from '../lib/freesound.js';
import { ms, size } from '../lib/format.js';
import { useI18n, type Key } from '../lib/i18n.js';
import { bars, ghostBars } from '../lib/layers.js';
import type { LibrarySearch } from '../lib/useSearch.js';

/** Where somebody reads what they just agreed to connect to. */
const FREESOUND_URL = 'https://freesound.org/';

/**
 * Licence names, untranslated on purpose.
 *
 * `CC0` and `CC-BY` are the names of the instruments themselves — the same three
 * characters in every language, and the strings a lawyer, a credits file and a store
 * submission form all expect. Translating them would invent a name for a licence.
 */
const LICENCE_LABEL: Readonly<Record<Licence, string>> = {
  cc0: 'CC0',
  by: 'CC-BY',
  'by-nc': 'CC-BY-NC',
  'sampling+': 'Sampling+',
  other: '?',
};

/** Length chips, in seconds. `null` is "any". */
const LENGTHS: readonly (number | null)[] = [null, 1, 3, 10];

/** What the panel says when the library refuses. One sentence per failure. */
const FAILURE: Readonly<Record<string, Key>> = {
  token: 'search.errToken',
  throttled: 'search.errThrottled',
  network: 'search.errNetwork',
  http: 'search.errHttp',
};

/** Bars in a row's waveform. Enough to tell a hit from a bed at 96 pixels wide. */
const BAR_COUNT = 44;

/** How many previews may be decoding at once. Two keeps a scroll responsive. */
const DECODE_LIMIT = 2;

/** The green the rest of the tab is drawn in — `HUE.library`, as a canvas needs it. */
const WAVE_COLOR = 'oklch(0.78 0.11 150)';

export interface FreesoundResultsProps {
  readonly search: LibrarySearch;
  /** Fetch this preview, decode it and make it the B side. Rejects like any fetch. */
  readonly onUseSound: (sound: FreesoundSound) => Promise<void>;
  /** The app's toast — downloads and clipboard writes report through it. */
  readonly onStatus: (message: string) => void;
}

export function FreesoundResults({ search, onUseSound, onStatus }: FreesoundResultsProps): React.JSX.Element {
  const { t } = useI18n();
  const [playing, setPlaying] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [formatId, setFormatId] = useState(() => loadFormat('library'));
  const audio = useRef<HTMLAudioElement | null>(null);
  const waves = useWaveforms();

  /* One element, reused. A tab full of `Audio` objects that were never stopped keeps
     every one of them buffering. */
  useEffect(() => {
    return () => {
      audio.current?.pause();
      audio.current = null;
    };
  }, []);

  const play = (sound: FreesoundSound): void => {
    audio.current?.pause();
    if (playing === sound.id) {
      setPlaying(null);
      return;
    }
    const element = new Audio(sound.preview);
    element.onended = () => setPlaying(null);
    element.onerror = () => {
      setPlaying(null);
      onStatus(t('search.playFail', { name: sound.name }));
    };
    audio.current = element;
    setPlaying(sound.id);
    void element.play().catch(() => setPlaying(null));
  };

  const use = (sound: FreesoundSound): void => {
    setPending(sound.id);
    void onUseSound(sound)
      .catch((error: unknown) => onStatus(String(error instanceof Error ? error.message : error)))
      .finally(() => setPending(null));
  };

  /**
   * Save a recording in the chosen format.
   *
   * Always from the **original**, never from the preview: the preview is a 128 kbps
   * MP3 made for auditioning, and transcoding it to WAV would produce a large file
   * with a small file's information in it. `Original` therefore costs one fetch and
   * nothing else; every other entry costs a decode and an encode on top.
   *
   * The token is asked for at the moment of the click rather than held, because
   * `connection.token()` is what knows whether the 24-hour access token is still good
   * and refreshes it if it is not.
   */
  const saveSound = async (sound: FreesoundSound, format: Format): Promise<void> => {
    setPending(sound.id);
    try {
      const token = await search.connection.token();
      if (token === null) throw new Error(t('search.errToken'));
      const original = await fetchOriginal(sound, token);

      if (format.id === 'original') {
        save(original, original.name);
        onStatus(t('search.saved', { file: original.name, size: size(original.size) }));
        return;
      }

      let buffer: AudioBuffer;
      try {
        buffer = await decodeAudioFile(original);
      } catch {
        /* The browser could not read the uploader's format — an obscure AIFF variant,
           a 32-bit float WAV. Handing over the bytes we do have beats failing, and
           saying which file arrived beats a silent substitution. */
        save(original, original.name);
        onStatus(t('search.savedOriginalInstead', { file: original.name }));
        return;
      }

      onStatus(await download({ name: safeName(sound.name), source: '', code: null, buffer }, format));
    } catch (error: unknown) {
      onStatus(String(error instanceof Error ? error.message : error));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="library">
      <div className="library-controls mono">
        <div className="chips">
          {(['cc0', 'any'] as const).map((id) => (
            <button
              type="button"
              key={id}
              className={`chip chip-green${search.licence === id ? ' selected' : ''}`}
              title={t(id === 'cc0' ? 'search.cc0Title' : 'search.anyLicenceTitle')}
              onClick={() => {
                if (search.licence === id) return;
                search.setLicence(id);
                search.refine();
              }}
            >
              {t(id === 'cc0' ? 'search.cc0' : 'search.anyLicence')}
            </button>
          ))}
        </div>

        <div className="chips">
          {LENGTHS.map((seconds) => (
            <button
              type="button"
              key={String(seconds)}
              className={`chip${search.maxSeconds === seconds ? ' selected' : ''}`}
              onClick={() => {
                if (search.maxSeconds === seconds) return;
                search.setMaxSeconds(seconds);
                search.refine();
              }}
            >
              {seconds === null ? t('search.anyLength') : t('search.under', { seconds })}
            </button>
          ))}
        </div>

        <div className="spacer" />

        {search.words === null ? null : (
          <span className="faint">
            {t('search.searchedFor')} <span className="library-words">{search.words}</span>
            {search.rewritten ? ` · ${t('search.rewritten')}` : ''}
            {search.searched ? ` · ${t('search.found', { count: search.total, shown: search.hits.length })}` : ''}
          </span>
        )}
      </div>

      {search.error === null ? null : (
        <div className="library-error">
          <p>{t(FAILURE[search.error.code] ?? 'search.errHttp')}</p>
          <p className="mono faint">{search.error.detail}</p>
        </div>
      )}

      <div className="library-list">
        {search.running && search.hits.length === 0 ? <p className="library-empty">{t('search.searching')}</p> : null}

        {/* Only the two states this block can be in. "Not connected" is not one of them
            any more: the screen above does not render the block at all until an account
            is connected, and the button that connects one is beside the search box. */}
        {!search.running && search.error === null && search.hits.length === 0 ? (
          <p className="library-empty">{t(search.searched ? 'search.nothing' : 'search.idle')}</p>
        ) : null}

        {search.hits.map(({ sound, note }) => (
          <Row
            key={sound.id}
            sound={sound}
            note={note}
            wave={waves.of(sound.id)}
            onVisible={waves.request}
            playing={playing === sound.id}
            busy={pending === sound.id}
            formatId={formatId}
            onFormat={(id) => {
              setFormatId(id);
              saveFormat('library', id);
            }}
            onPlay={() => play(sound)}
            onUse={() => use(sound)}
            onSave={(format) => saveSound(sound, format)}
            onCredit={() => void copy(attributionFor(sound), t('search.credit')).then(onStatus)}
          />
        ))}
      </div>

      <p className="caption">{t('search.caption')}</p>
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * One result
 * ------------------------------------------------------------------------- */

interface RowProps {
  readonly sound: FreesoundSound;
  readonly note: string;
  /** Measured heights, or null while nothing has been decoded for this sound yet. */
  readonly wave: Float32Array | null;
  readonly onVisible: (sound: FreesoundSound) => void;
  readonly playing: boolean;
  readonly busy: boolean;
  readonly formatId: string;
  readonly onFormat: (id: string) => void;
  readonly onPlay: () => void;
  readonly onUse: () => void;
  readonly onSave: (format: Format) => Promise<void>;
  readonly onCredit: () => void;
}

function Row(props: RowProps): React.JSX.Element {
  const { t } = useI18n();
  const { sound, wave } = props;
  const host = useRef<HTMLDivElement | null>(null);
  const licence = licenceOf(sound.license);

  /* Ask for the waveform the first time this row is on screen, and stop watching. The
     alternative — decoding the whole page up front — is several megabytes fetched for
     rows nobody scrolled to. */
  useEffect(() => {
    const element = host.current;
    if (element === null || wave !== null) return;
    if (typeof IntersectionObserver === 'undefined') {
      props.onVisible(sound);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          props.onVisible(sound);
          observer.disconnect();
        }
      },
      /* A little ahead of the scroll, so a row is drawn by the time it arrives rather
         than filling in under the eye. */
      { rootMargin: '200px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
    /* `onVisible` is stable and `sound` is identified by its id; re-running this on
       every render would build an observer per frame. */
  }, [sound.id, wave === null]);

  return (
    <div className="library-row" ref={host}>
      <button
        type="button"
        className={`library-play${props.playing ? ' playing' : ''}`}
        title={props.playing ? t('search.stop') : t('search.play')}
        onClick={props.onPlay}
      >
        {props.playing ? '❚❚' : '▶'}
      </button>

      <Bars
        values={wave ?? ghostBars(String(sound.id), BAR_COUNT)}
        muted={wave === null}
        playing={props.playing}
        durationMs={sound.seconds * 1000}
        className="library-wave"
        color={WAVE_COLOR}
      />

      <div className="library-main">
        <div className="library-head">
          <span className="library-name">{sound.name}</span>
          <a
            className={`lic lic-${licence === 'cc0' ? 'free' : 'bound'}`}
            href={sound.license === '' ? sound.url : sound.license}
            target="_blank"
            rel="noreferrer noopener"
            title={t(needsAttribution(sound) ? 'search.licenceBound' : 'search.licenceFree')}
          >
            {LICENCE_LABEL[licence]}
          </a>
        </div>
        <div className="library-meta mono faint">
          {ms(sound.seconds * 1000)} · {sound.username}
          {sound.format === '' ? '' : ` · ${sound.format}`}
          {sound.sampleRate > 0 ? ` · ${String(Math.round(sound.sampleRate / 1000))} kHz` : ''}
          {sound.channels > 0 ? ` · ${sound.channels === 1 ? 'mono' : 'stereo'}` : ''}
          {note(props.note)}
        </div>
      </div>

      <div className="library-acts">
        <button
          type="button"
          className="chip chip-amber"
          disabled={props.busy}
          title={t('search.useTitle')}
          onClick={props.onUse}
        >
          → B
        </button>
        <FormatMenu
          formatId={props.formatId}
          onFormat={props.onFormat}
          onDownload={props.onSave}
          disabled={props.busy}
          className="green compact"
          formats={LIBRARY_FORMATS}
        />
        <button type="button" className="chip" title={t('search.creditTitle')} onClick={props.onCredit}>
          ©
        </button>
        <a
          className="chip"
          href={sound.url}
          target="_blank"
          rel="noreferrer noopener"
          title={t('search.pageTitle')}
        >
          ↗
        </a>
      </div>
    </div>
  );
}

/** The ranking model's reason, when it had one. */
function note(text: string): string {
  return text === '' ? '' : ` · ${text}`;
}

/* ------------------------------------------------------------------------- *
 * Waveforms
 * ------------------------------------------------------------------------- */

/** Heights per sound, decoded on demand and kept for the life of the panel. */
interface Waveforms {
  of: (id: number) => Float32Array | null;
  request: (sound: FreesoundSound) => void;
}

/**
 * Decode previews into bar heights, a couple at a time, once each.
 *
 * The queue is the whole point. A search returns thirty rows; a naive effect per row
 * would open thirty connections and decode thirty MP3s the moment the list rendered,
 * which is both slower and ruder than doing two at a time as they scroll into view.
 * Failures are recorded rather than retried: a preview that will not decode will not
 * decode on the fourth attempt either, and the ghost placeholder is a perfectly good
 * answer for the row.
 */
function useWaveforms(): Waveforms {
  const [ready, setReady] = useState<ReadonlyMap<number, Float32Array>>(() => new Map());
  const seen = useRef(new Set<number>());
  const queue = useRef<FreesoundSound[]>([]);
  const active = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const pump = useCallback((): void => {
    while (active.current < DECODE_LIMIT) {
      const next = queue.current.shift();
      if (next === undefined) return;
      active.current += 1;
      void fetchPreview(next)
        .then(decodeAudioFile)
        .then((buffer) => {
          if (!alive.current) return;
          const values = bars(buffer, BAR_COUNT);
          setReady((current) => new Map(current).set(next.id, values));
        })
        .catch(() => {
          /* Left out of `ready`, so the row keeps its placeholder. `seen` already holds
             the id, so nothing asks again. */
        })
        .finally(() => {
          active.current -= 1;
          if (alive.current) pump();
        });
    }
  }, []);

  const request = useCallback(
    (sound: FreesoundSound): void => {
      if (seen.current.has(sound.id)) return;
      seen.current.add(sound.id);
      queue.current.push(sound);
      pump();
    },
    [pump],
  );

  const of = useCallback((id: number): Float32Array | null => ready.get(id) ?? null, [ready]);

  return { of, request };
}

/* ------------------------------------------------------------------------- *
 * The account
 * ------------------------------------------------------------------------- */

/**
 * The account this tab is acting as, as one control beside the search box.
 *
 * A state machine rather than a button with a disabled attribute, for the reason the
 * render screen's install view is one: "this bank cannot connect anybody" and "you have
 * not connected yet" are different problems with different answers, and a greyed-out
 * button says neither. The fourth state, `connecting`, exists because the round trip
 * leaves the page — coming back to a control that looks untouched is how a user presses
 * connect twice.
 *
 * Connected, it stops being a button and becomes a *statement* with an undo on it:
 * `● freesound.org connected · disconnect`. That is the whole reason the sentence about
 * where the tokens are kept survives the move to the hero — it is now a tooltip rather
 * than a paragraph, but a control that quietly holds an OAuth grant has to say so
 * somewhere the user can find it, and the two links here are the only places.
 */
export function FreesoundButton({
  connection,
}: {
  readonly connection: LibrarySearch['connection'];
}): React.JSX.Element {
  const { t } = useI18n();
  const { state } = connection;

  if (state === 'on') {
    return (
      <div className="fs-connected mono" title={t('search.connectedNote')}>
        <span className="ok">● {t('search.connected')}</span>
        <button type="button" className="link" onClick={connection.disconnect}>
          {t('search.disconnect')}
        </button>
      </div>
    );
  }

  return (
    <div className="fs-connect">
      <button
        type="button"
        className="fs-button"
        disabled={state !== 'off'}
        title={t(state === 'unavailable' ? 'search.noBank' : 'search.connectNote')}
        onClick={connection.connect}
      >
        {state === 'connecting' ? <span className="spinner" aria-hidden="true" /> : null}
        {t('search.connect')}
        {/* An arrow, not the magnifier this button used to carry. The label no longer
            promises a search, and the press leaves the page for freesound's own consent
            screen — which is the one thing about it worth warning somebody about before
            they click. */}
        {state === 'connecting' ? null : <span aria-hidden="true">↗</span>}
      </button>

      {/* The label promises an account, not a search box — which is honest, and leaves
          "why does searching a public library need an account at all?" unanswered right
          where it is asked. The mark answers it on hover and on focus: it is an OAuth
          grant, the password is typed on freesound.org and never here, and what it buys
          is searching the library beside the catalog. It is a link rather than a button
          because a control whose click does nothing is worse than one that goes where
          the tooltip points. */}
      <a
        className="fs-help"
        href={FREESOUND_URL}
        target="_blank"
        rel="noreferrer noopener"
        title={t('search.connectHelp')}
        aria-label={t('search.connectHelp')}
      >
        ?
      </a>

      {/* The code the round trip came back with, as a sentence. `cancelled` is the one
          people will actually see — they pressed Cancel on freesound's own page — and it
          is not a failure, so it must not read like one. Anything else keeps its raw
          code beside the sentence, because that is what a bug report needs. */}
      {connection.error === null ? null : (
        <p className={connection.error === 'cancelled' ? 'caption' : 'mono bad'}>
          {connection.error === 'cancelled'
            ? t('search.connCancelled')
            : `${t('search.connFailed')} (${connection.error})`}
        </p>
      )}

      {state === 'unavailable' ? (
        <p className="caption">
          <a className="link" href={FREESOUND_URL} target="_blank" rel="noreferrer noopener">
            freesound.org ↗
          </a>
        </p>
      ) : null}
    </div>
  );
}
