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
 * The globe sits past it, in the corner, because language is the one control that has to
 * be findable by someone who cannot read anything else on the page — and the far corner
 * of the top bar is where every other application on their machine has put it.
 *
 * @packageDocumentation
 */

import { LanguageMenu } from './LanguageMenu.js';
import { useI18n } from '../lib/i18n.js';
import type { BridgeStatus } from '../lib/bridge-client.js';

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

      <LanguageMenu />
    </header>
  );
}
