/**
 * The one bar that is always on screen.
 *
 * Three things earn a permanent place, and the third is the interesting one.
 *
 * The brand doubles as *home* — it returns to the gallery, because a logo that is
 * not a link is a piece of furniture. The two screen tabs are the whole navigation:
 * `Sounds` is the catalog and `Studio` is one sound, and there is no third mode
 * because the share screen belongs to a specific recipe and is reached from it.
 *
 * Then the bridge badge. It is here rather than tucked in a settings pane because it
 * answers a question that changes without the user doing anything: *can an agent
 * reach this page right now*. A daemon that died, an MCP client that was restarted,
 * a port that something else took — all invisible until a generate run fails with a
 * confusing message. A dot that is green or amber, and a click that explains which,
 * costs 29 pixels of header and removes a whole class of support question.
 *
 * Then the repository, which is the one thing a visitor cannot find any other way. The
 * page makes a claim — a few hundred bytes of JavaScript instead of an audio file — and
 * the only way to check a claim like that is to read the code that makes it. Two controls
 * rather than one: the mark goes to the source, and `Star` is a separate target because
 * it is a separate intention, and a single link doing both would serve neither.
 *
 * **No star count.** Rendering one means a request to `api.github.com` on load, and
 * "nothing is proxied through a service, no request the user did not start" is a claim
 * this project makes about itself on this very page. A number in the header is not worth
 * spending it on.
 *
 * The globe sits past it, in the corner, because language is the one control that has to
 * be findable by someone who cannot read anything else on the page — and the far corner
 * of the top bar is where every other application on their machine has put it.
 *
 * @packageDocumentation
 */

import { LanguageMenu } from './LanguageMenu.js';
import { useI18n } from '../lib/i18n.js';
import type { BridgeStatus } from '../lib/bridge-client.js';

/** Where the source is. The same string the OG tags in `index.html` point at. */
const REPO_URL = 'https://github.com/txt2sfx/txt2sfx';

/**
 * The GitHub mark, inline.
 *
 * Inline rather than an `<img>` for the reason the favicon in `index.html` is inline: a
 * file request the dev server answers with a 404, and an icon that is missing for the
 * one second the network takes, are both worse than 500 bytes of path data. It also
 * inherits `currentColor`, so it dims with the rest of the bar rather than staying a
 * bright black-and-white logo on a dark header.
 */
function GitHubMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-2.91-.88-2.91-2.9 0-.65.23-1.18.61-1.6-.06-.15-.27-.75.06-1.56 0 0 .5-.16 1.64.61a5.6 5.6 0 0 1 1.49-.2c.51 0 1.02.07 1.49.2 1.14-.78 1.64-.61 1.64-.61.33.81.12 1.41.06 1.56.38.42.61.95.61 1.6 0 2.03-1.13 2.7-2.92 2.9.29.26.55.75.55 1.52 0 1.09-.01 1.98-.01 2.25 0 .21.15.46.55.38A7.99 7.99 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Which screen is showing. `share` is a leaf of `studio`, not a peer. */
export type Screen = 'gallery' | 'studio' | 'share';

export interface HeaderProps {
  readonly screen: Screen;
  readonly onScreen: (screen: Screen) => void;
  readonly bridge: BridgeStatus;
  readonly onOpenBridge: () => void;
}

export function Header({ screen, onScreen, bridge, onOpenBridge }: HeaderProps): React.JSX.Element {
  const { t } = useI18n();
  const live = bridge.state === 'live';
  const agent = bridge.health?.agent;
  const tools = bridge.health?.tools.length ?? 0;

  /* Three states, not two. "The daemon is up but no agent is attached" is the most
     common half-configured state and the one a binary dot would hide — the user has
     done the npx step and not the MCP-config step, and being told `bridge live` would
     send them looking in the wrong place. */
  const tone = !live ? 'bad' : agent?.connected === true ? 'ok' : 'warn';
  const label = !live ? t('bridge.offline') : agent?.connected === true ? t('bridge.attached') : t('bridge.live');
  const meta = !live
    ? t('bridge.notConnected')
    : agent?.connected === true
      ? t('bridge.tools', { client: agent.client ?? 'MCP', count: tools })
      : t('bridge.noAgent');

  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => onScreen('gallery')}>
        txt2sfx
      </button>

      <nav className="segmented" aria-label={t('nav.screenAria')}>
        <button
          type="button"
          className={screen === 'gallery' ? 'selected' : ''}
          aria-current={screen === 'gallery'}
          onClick={() => onScreen('gallery')}
        >
          {t('nav.sounds')}
        </button>
        <button
          type="button"
          className={screen === 'gallery' ? '' : 'selected'}
          aria-current={screen !== 'gallery'}
          onClick={() => onScreen('studio')}
        >
          {t('nav.studio')}
        </button>
      </nav>

      <div className="spacer" />

      <button type="button" className={`pill pill-${tone}`} title={t('bridge.title')} onClick={onOpenBridge}>
        <span className={`dot${live ? ' dot-breathing' : ''}`} />
        <span className="mono">{label}</span>
        <span className="mono faint">{meta}</span>
      </button>

      {/* `noreferrer` alongside `noopener`: the target is a public repository that has no
          business being told which page sent someone, and the pair is one habit rather
          than a judgement call per link. */}
      <div className="repo-group">
        <a className="repo-link" href={REPO_URL} target="_blank" rel="noreferrer noopener" title={t('repo.title')}>
          <GitHubMark />
          <span className="mono">{t('repo.label')}</span>
        </a>
        {/* Deliberately the repository page and not `/stargazers`: starring is a POST no
            URL can perform, so the honest promise is "this takes you where the button
            is", which is what the label says. */}
        <a
          className="repo-star"
          href={REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
          title={t('repo.starTitle')}
        >
          ☆ {t('repo.star')}
        </a>
      </div>

      <LanguageMenu />
    </header>
  );
}
