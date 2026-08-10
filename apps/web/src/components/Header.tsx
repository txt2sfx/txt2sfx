/**
 * The one bar that is always on screen.
 *
 * Three things earn a permanent place, and the third is the interesting one.
 *
 * The brand doubles as *home* — it returns to the gallery, because a logo that is
 * not a link is a piece of furniture. The screen tabs are the whole navigation, and
 * each names a different *subject*: `Sounds` is the catalog, `Studio` is one sound,
 * `AI Render` is that sound as a diffusion model would have made it, `NeurosLoop` is
 * eight bars of one. The share screen has no tab on purpose — it belongs to a specific
 * recipe and is reached from it, so a tab for it would mean nothing until something
 * else had been chosen.
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

import { IconGitHub, IconStar } from './Icons.js';
import { LanguageMenu } from './LanguageMenu.js';
import { useI18n, type Key } from '../lib/i18n.js';
import type { BridgeStatus } from '../lib/bridge-client.js';

/** Where the source is. The same string the OG tags in `index.html` point at. */
const REPO_URL = 'https://github.com/txt2sfx/txt2sfx';

/** Which screen is showing. `share` is a leaf of `studio`, not a peer. */
export type Screen = 'gallery' | 'studio' | 'render' | 'share' | 'loop';

/**
 * The tabs, in the order the work goes.
 *
 * `share` is deliberately absent: it belongs to one recipe and is reached from it, so a
 * tab for it would be a tab that means nothing until something else has been selected.
 * `loop` is a peer of the other two rather than a leaf of the studio — it is a different
 * kind of subject (eight bars, not one hit) with a different set of controls, and the
 * argument for that split is in `screens/Loop.tsx`.
 *
 * `render` sits directly after `studio` because it is the studio's question answered a
 * different way — the same prompt, rendered by a diffusion model, as a target to aim at.
 * It was a tab *inside* the studio and is one out here for the reason `screens/Render.tsx`
 * gives: it is not a view of the recipe, and it is a multi-gigabyte install that deserves
 * to be findable rather than discovered on somebody else's fourth tab.
 */
const TABS: readonly { readonly screen: Screen; readonly label: Key }[] = [
  { screen: 'gallery', label: 'nav.sounds' },
  { screen: 'studio', label: 'nav.studio' },
  { screen: 'render', label: 'nav.render' },
  { screen: 'loop', label: 'nav.loop' },
];

export interface HeaderProps {
  readonly screen: Screen;
  readonly onScreen: (screen: Screen) => void;
  readonly bridge: BridgeStatus;
  readonly onOpenBridge: () => void;
  /**
   * The account control, passed in rather than built here.
   *
   * It needs the bank client, the session and the sign-in flow, and none of those are
   * things a header should know about. Handing it in as a node keeps this file about
   * the bar and keeps the one stateful control next to the state it reads.
   */
  readonly account?: React.ReactNode;
}

export function Header({ screen, onScreen, bridge, onOpenBridge, account }: HeaderProps): React.JSX.Element {
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
        {TABS.map((tab) => {
          /* `share` lights the Studio tab: it is that screen's leaf, and a navigation
             bar with nothing selected reads as a bug. */
          const active = tab.screen === 'studio' ? screen === 'studio' || screen === 'share' : screen === tab.screen;
          return (
            <button
              type="button"
              key={tab.screen}
              className={active ? 'selected' : ''}
              aria-current={active}
              onClick={() => onScreen(tab.screen)}
            >
              {t(tab.label)}
            </button>
          );
        })}
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
          <IconGitHub />
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
          <IconStar size={12} /> {t('repo.star')}
        </a>
      </div>

      {account}

      <LanguageMenu />
    </header>
  );
}
