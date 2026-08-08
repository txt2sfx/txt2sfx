/**
 * The third answer: a recording somebody already made.
 *
 * ## Why a library is in the building
 *
 * The same argument as the Model tab, one step further. What this project ships is a
 * few hundred bytes of JavaScript; a diffusion render and a field recording are both
 * **targets** — the thing you point at and say "closer to that". The Model tab makes
 * one on this machine in thirty seconds of CPU; this tab finds one somebody already
 * recorded, in one request. Neither is a deliverable, and the panel says so out loud
 * rather than growing an export button that would imply otherwise.
 *
 * Everything found here ends where a dropped file ends: the B side of Compare, and
 * from there `⌖ Fit to reference` and `match reference` apply unchanged.
 *
 * ## Why the first control is a sign-in and not a field
 *
 * Because the alternative is not allowed and no longer exists. Freesound's API terms
 * forbid answering for people who are not logged in to Freesound themselves, and what
 * their settings hand out is an *application*, not a per-person key. So the panel asks
 * the user to connect their own account, and the payoff is not only compliance: the
 * download button can then hand over the **original** file, which a pasted key never
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
 * ## Why play is an `<audio>` element and B is not
 *
 * Auditioning wants the first hundred milliseconds now, and a streaming element gives
 * that for free. The B side wants samples, which means the whole file and
 * `decodeAudioData` — one round trip more, spent only on the one sound someone chose.
 * Both roads are open because `cdn.freesound.org` sends `Access-Control-Allow-Origin`,
 * which is measured in `lib/freesound.ts` rather than assumed.
 *
 * @packageDocumentation
 */

import { useEffect, useRef, useState } from 'react';
import { copy, save } from '../lib/download.js';
import {
  attributionFor,
  fetchOriginal,
  licenceOf,
  needsAttribution,
  type FreesoundSound,
  type Licence,
} from '../lib/freesound.js';
import { ms, size } from '../lib/format.js';
import { useI18n, type Key } from '../lib/i18n.js';
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

export interface SearchPanelProps {
  readonly search: LibrarySearch;
  /** Fetch this preview, decode it and make it the B side. Rejects like any fetch. */
  readonly onUseSound: (sound: FreesoundSound) => Promise<void>;
  /** The app's toast — downloads and clipboard writes report through it. */
  readonly onStatus: (message: string) => void;
}

export function SearchPanel({ search, onUseSound, onStatus }: SearchPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [playing, setPlaying] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

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
   * Download the original, with the connected account's token.
   *
   * The token is asked for at the moment of the click rather than held here, because
   * `connection.token()` is what knows whether the 24-hour access token is still good
   * and refreshes it if it is not. A button that holds a copy is a button that breaks
   * the day after a session started.
   */
  const downloadOriginal = (sound: FreesoundSound): void => {
    setPending(sound.id);
    void search.connection
      .token()
      .then(async (token) => {
        if (token === null) throw new Error(t('search.errToken'));
        const file = await fetchOriginal(sound, token);
        save(file, file.name);
        onStatus(t('search.saved', { file: file.name, size: size(file.size) }));
      })
      .catch((error: unknown) => onStatus(String(error instanceof Error ? error.message : error)))
      .finally(() => setPending(null));
  };

  return (
    <div className="library">
      <Connection connection={search.connection} />

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

        {/* Nothing under a refusal. The red box above already says what happened and
            what to do; "describe the sound and press Make sound" underneath it reads as
            advice to do the thing that just failed. */}
        {/* Nothing at all when the bank cannot connect anybody: the block above has
            already said so, and the same sentence twice on one screen reads as a
            rendering bug rather than as emphasis. */}
        {!search.running &&
        search.error === null &&
        search.hits.length === 0 &&
        search.connection.state !== 'unavailable' ? (
          <p className="library-empty">
            {search.connection.state !== 'on'
              ? t('search.needsConnection')
              : search.searched
                ? t('search.nothing')
                : t('search.idle')}
          </p>
        ) : null}

        {search.hits.map(({ sound, note }) => {
          const licence = licenceOf(sound.license);
          return (
            <div className="library-row" key={sound.id}>
              <button
                type="button"
                className={`library-play${playing === sound.id ? ' playing' : ''}`}
                title={playing === sound.id ? t('search.stop') : t('search.play')}
                onClick={() => play(sound)}
              >
                {playing === sound.id ? '❚❚' : '▶'}
              </button>

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
                  {sound.sampleRate > 0 ? ` · ${String(Math.round(sound.sampleRate / 1000))} kHz` : ''}
                  {sound.channels > 0 ? ` · ${sound.channels === 1 ? 'mono' : 'stereo'}` : ''}
                  {sound.downloads > 0 ? ` · ${t('search.downloads', { count: sound.downloads })}` : ''}
                  {note === '' ? '' : ` · ${note}`}
                </div>
              </div>

              <div className="library-acts">
                <button
                  type="button"
                  className="chip chip-amber"
                  disabled={pending === sound.id}
                  title={t('search.useTitle')}
                  onClick={() => use(sound)}
                >
                  → B
                </button>
                <button
                  type="button"
                  className="chip"
                  disabled={pending === sound.id}
                  title={t('search.downloadTitle')}
                  onClick={() => downloadOriginal(sound)}
                >
                  ⤓
                </button>
                <button
                  type="button"
                  className="chip"
                  title={t('search.creditTitle')}
                  onClick={() => void copy(attributionFor(sound), t('search.credit')).then(onStatus)}
                >
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
        })}
      </div>

      <p className="caption">{t('search.caption')}</p>
    </div>
  );
}

/**
 * The account this tab is acting as, in four states.
 *
 * A state machine rather than a button with a disabled attribute, for the reason the
 * Model tab's install screen is one: "this bank cannot connect anybody" and "you have
 * not connected yet" are different problems with different answers, and a greyed-out
 * button says neither. The fourth state, `connecting`, exists because the round trip
 * leaves the page — coming back to a panel that looks untouched is how a user presses
 * connect twice.
 */
function Connection({ connection }: { readonly connection: LibrarySearch['connection'] }): React.JSX.Element {
  const { t } = useI18n();
  const { state } = connection;

  return (
    <div className="library-key">
      {state === 'on' ? (
        <>
          <span className="mono ok">● {t('search.connected')}</span>
          <label className="toggle" title={t('search.rememberTitle')}>
            <input
              type="checkbox"
              name="remember-freesound"
              checked={connection.remember}
              onChange={(event) => connection.setRemember(event.target.checked)}
            />
            {t('search.remember')}
          </label>
          <div className="spacer" />
          <button type="button" className="link" onClick={connection.disconnect}>
            {t('search.disconnect')}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="hue-button"
            disabled={state !== 'off'}
            onClick={connection.connect}
          >
            {state === 'connecting' ? <span className="spinner" aria-hidden="true" /> : null}
            {t('search.connect')}
          </button>
          <p className="caption">
            {state === 'unavailable' ? t('search.noBank') : t('search.connectNote')}{' '}
            <a className="link" href={FREESOUND_URL} target="_blank" rel="noreferrer noopener">
              freesound.org ↗
            </a>
          </p>
        </>
      )}

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
    </div>
  );
}
