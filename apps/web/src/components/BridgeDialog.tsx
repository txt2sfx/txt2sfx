/**
 * What the bridge badge opens: a diagnosis, then the fix.
 *
 * ## Why this is a checklist and not a paragraph
 *
 * Getting an agent attached is four independent things — a daemon on a port, an MCP
 * client that has been told about it, a client that has actually restarted, and
 * somewhere for audio to come out — and any one of them can be the missing one. A
 * paragraph of setup instructions makes the user re-read all four to find out which.
 * A row per check, each with the value it actually observed, turns the same
 * information into a single glance. Every value here comes from `GET /health` and the
 * live socket; none of it is inferred from whether the modal is open.
 *
 * ## Why one command and not two
 *
 * The obvious instruction is "start the bridge, then register it", and it is one step
 * too long: a client that launches `txt2sfx-bridge --stdio` gets a process that opens
 * the port itself, so the daemon is already running by the time the badge is looked at.
 * Registering *is* the install. `npx txt2sfx-bridge` by hand is worth showing only to
 * someone who wants a bridge outliving the client, which is not the person reading this
 * dialog for the first time.
 *
 * ## Why a picker and not one config blob
 *
 * The generic `mcpServers` JSON is correct everywhere and the shortest path nowhere:
 * two of the four clients people actually use install a server with a single shell
 * command, and the other two want the file in a specific place under a specific key —
 * `mcp` with `type: "local"` for opencode, `mcpServers` for Cursor. Showing the union
 * of all of that at once means every reader skips past three quarters of it hoping the
 * remaining quarter is theirs. One tab, one answer, and `Other` still carries the
 * canonical shape for everyone else.
 *
 * The port is woven into every recipe rather than hardcoded: a user who moved the
 * bridge with `--port` is exactly the user who cannot afford instructions that quietly
 * say 4455.
 *
 * ## Why every block has its own copy button
 *
 * These blocks are not illustrations — each one is meant to end up in a terminal or a
 * config file verbatim, and a mis-transcribed `--stdio` fails in a way that looks like
 * the bridge is broken. `Copy agent prompt` in the footer is the same idea one level
 * up: pasted into Claude Code or Codex it does the registering itself, and carries the
 * loopback-HTTP route for the agent that cannot restart to pick a config up. Its text
 * is `bridgeOnboardingPrompt` from `@txt2sfx/agent`, the same string
 * `txt2sfx-bridge doctor` prints, so instructions cannot differ by where they were
 * copied from.
 *
 * @packageDocumentation
 */

import { useState } from 'react';
import { bridgeOnboardingPrompt } from '@txt2sfx/agent';
import { copy } from '../lib/download.js';
import { t, useI18n, type Key } from '../lib/i18n.js';
import type { BridgeStatus } from '../lib/bridge-client.js';

export interface BridgeDialogProps {
  readonly status: BridgeStatus;
  readonly onClose: () => void;
  readonly onRecheck: () => Promise<unknown>;
  readonly onUrlChange: (url: string) => void;
}

/** How one client is told about the bridge. */
interface ClientRecipe {
  readonly id: string;
  readonly label: string;
  /** Where the config belongs, when the client has no command to do it. */
  readonly file?: string;
  /** The thing to copy: a shell command, or the config to paste into `file`. */
  readonly code: string;
  readonly note: string;
  /**
   * A second block, for the one client that can also be driven the other way
   * round. Optional because it is not a fallback and not an alternative to the
   * command above — it is the reverse direction, and only Claude Code has it.
   */
  readonly extra?: {
    readonly title: string;
    readonly code: string;
    readonly note: string;
    /** What the copy button says it copied — the title reads badly in that sentence. */
    readonly what: string;
  };
}

/**
 * The argv the client will run. `--port` appears only when it is not the default,
 * because an argument that repeats a default is one more thing to get wrong.
 */
function bridgeArgs(port: string): readonly string[] {
  return ['-y', 'txt2sfx-bridge', '--stdio', ...(port === '4455' ? [] : ['--port', port])];
}

/** The canonical `mcpServers` shape — Cursor, Claude Desktop, Windsurf, Zed, most others. */
function mcpConfig(port: string): string {
  return JSON.stringify(
    { mcpServers: { txt2sfx: { command: 'npx', args: bridgeArgs(port) } } },
    null,
    2,
  );
}

/**
 * One entry per tab, shortest honest path first.
 *
 * The client names and every `code` block stay untranslated by construction: they are a
 * product name and a command the reader has to type verbatim. Only the `note` — the
 * sentence explaining what the command did and what to restart — goes through the
 * dictionary, and that is the sentence that decides whether the setup succeeds.
 */
function clientRecipes(port: string): readonly ClientRecipe[] {
  const argv = `npx ${bridgeArgs(port).join(' ')}`;
  return [
    {
      id: 'claude',
      label: 'Claude Code',
      code: `claude mcp add txt2sfx -- ${argv}`,
      note: t('dialog.noteClaude'),
      /* The command above points Claude Code at the tools; this one points the
         tab at Claude Code. Same daemon, opposite direction — and it is the
         only setup here that needs no MCP client and no restart, which is why
         it earns a block of its own rather than a sentence in the note. */
      extra: {
        title: t('dialog.claudeModel'),
        code: `npx -y txt2sfx-bridge claude${port === '4455' ? '' : ` --port ${port}`}`,
        note: t('dialog.claudeModelNote'),
        what: t('dialog.claudeModelWhat'),
      },
    },
    {
      id: 'codex',
      label: 'Codex',
      code: `codex mcp add txt2sfx -- ${argv}`,
      note: t('dialog.noteCodex'),
    },
    {
      id: 'opencode',
      label: 'opencode',
      file: t('dialog.fileOpencode'),
      code: JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: { txt2sfx: { type: 'local', command: ['npx', ...bridgeArgs(port)], enabled: true } },
        },
        null,
        2,
      ),
      note: t('dialog.noteOpencode'),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      file: t('dialog.fileCursor'),
      code: mcpConfig(port),
      note: t('dialog.noteCursor'),
    },
    {
      id: 'other',
      label: 'Other',
      code: mcpConfig(port),
      note: t('dialog.noteOther'),
    },
  ];
}

/** A block meant to leave this dialog verbatim, so it carries the button to do that. */
function CodeBlock({
  code,
  what,
  onCopied,
}: {
  readonly code: string;
  readonly what: string;
  readonly onCopied: (message: string) => void;
}): React.JSX.Element {
  return (
    <div className="code">
      <pre>{code}</pre>
      <button
        type="button"
        className="copy"
        aria-label={t('dialog.copyWhat', { what })}
        title={t('dialog.copyWhat', { what })}
        onClick={() => void copy(code, what).then(onCopied)}
      >
        ⧉
      </button>
    </div>
  );
}

export function BridgeDialog({ status, onClose, onRecheck, onUrlChange }: BridgeDialogProps): React.JSX.Element {
  /* Subscribed for the re-render only. The strings come from the module-level `t`, which
     is also what `clientRecipes` above has to use — it is not a component and cannot hold
     a hook, and having one half of this dialog read a different translator than the other
     is how a language change leaves a stale sentence on screen. */
  useI18n();
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [url, setUrl] = useState(status.url);
  const [client, setClient] = useState('claude');

  const live = status.state === 'live';
  const health = status.health;
  const agent = health?.agent;
  const port = (() => {
    try {
      return new URL(status.url).port || '4455';
    } catch {
      return '4455';
    }
  })();

  const recipes = clientRecipes(port);
  const recipe = recipes.find((candidate) => candidate.id === client) ?? recipes[0]!;

  /* Built at click time from the port the user is actually pointing at, so a
     bridge moved with --port does not hand out instructions for 4455. */
  const agentPrompt = (): string =>
    bridgeOnboardingPrompt({ port: Number(port), playgroundUrl: window.location.origin });

  const checks: readonly { key: Key; label: string; value: string; ok: boolean }[] = [
    {
      key: 'dialog.checkDaemon',
      label: t('dialog.checkDaemon'),
      value: live ? new URL(status.url).host : (status.error ?? t('dialog.noResponse')),
      ok: live,
    },
    {
      key: 'dialog.checkProtocol',
      label: t('dialog.checkProtocol'),
      value: health === null ? '—' : `v${String(health.protocol)} · bridge ${health.version}`,
      ok: live,
    },
    {
      key: 'dialog.checkAgent',
      label: t('dialog.checkAgent'),
      value:
        agent?.connected === true
          ? `${agent.client ?? t('dialog.mcpClient')}${agent.sampling ? ' · sampling' : ''}`
          : live
            ? t('dialog.registerBelow')
            : '—',
      ok: agent?.connected === true,
    },
    {
      key: 'dialog.checkRenderer',
      label: t('dialog.checkRenderer'),
      value:
        health === null
          ? '—'
          : health.renderer === 'playground'
            ? t('dialog.thisTab')
            : health.renderer === 'native'
              ? 'node-web-audio-api'
              : t('dialog.rendererNone'),
      ok: health !== null && health.renderer !== 'none',
    },
  ];

  const recheck = (): void => {
    setChecking(true);
    void onRecheck().finally(() => setChecking(false));
  };

  const say = (message: string): void => {
    setNote(message);
    window.setTimeout(() => setNote((current) => (current === message ? null : current)), 1600);
  };

  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <div
        className="dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('dialog.bridgeAria')}
      >
        <div className="dialog-head">
          <span className={`dot ${live ? 'dot-ok' : 'dot-bad'}`} />
          <h3>{t('dialog.bridgeTitle')}</h3>
          <div className="spacer" />
          <button type="button" className="icon" onClick={onClose} aria-label={t('dialog.close')}>
            ✕
          </button>
        </div>

        <p className="dialog-lede">
          {live
            ? t('dialog.bridgeLedeLive')
            : t('dialog.bridgeLedeDead', { host: new URL(status.url).host })}
        </p>

        <div className="checks">
          {checks.map((check) => (
            <div className="check" key={check.key}>
              <span className={`mark ${check.ok ? 'good' : 'bad'}`}>{check.ok ? '✓' : '✕'}</span>
              <span className="check-label">{check.label}</span>
              <span className="mono faint">{check.value}</span>
            </div>
          ))}
        </div>

        <div className="steps">
          <div className="step">
            <span className="step-n">1</span>
            <div className="step-body">
              <div className="step-title">{t('dialog.step1')}</div>
              <nav className="segmented small wrap" aria-label={t('dialog.agentAria')}>
                {recipes.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={candidate.id === client ? 'selected cyan' : ''}
                    aria-current={candidate.id === client}
                    onClick={() => setClient(candidate.id)}
                  >
                    {candidate.label}
                  </button>
                ))}
              </nav>
              {recipe.file === undefined ? null : <div className="step-file mono">{recipe.file}</div>}
              <CodeBlock code={recipe.code} what={t('dialog.setupOf', { client: recipe.label })} onCopied={say} />
              <div className="step-note">{recipe.note}</div>
              {recipe.extra === undefined ? null : (
                <>
                  <div className="step-title">{recipe.extra.title}</div>
                  <CodeBlock code={recipe.extra.code} what={recipe.extra.what} onCopied={say} />
                  <div className="step-note">{recipe.extra.note}</div>
                </>
              )}
            </div>
          </div>

          <div className="step">
            <span className="step-n">2</span>
            <div className="step-body">
              <div className="step-title">{t('dialog.step2')}</div>
              {/* Not translated: it is a prompt, and the agent reading it was configured
                  in English by the command one step above. */}
              <CodeBlock
                code={'call sfx_contract, then design a "wet bubble pop" and audition it'}
                what={t('dialog.firstAsk')}
                onCopied={say}
              />
              <div className="step-note">{t('dialog.step2note')}</div>
            </div>
          </div>
        </div>

        <div className="dialog-foot">
          <button
            type="button"
            className="primary"
            onClick={() => void copy(agentPrompt(), t('dialog.agentPrompt')).then(say)}
            title={t('dialog.copyPromptTitle')}
          >
            {t('dialog.copyPrompt')}
          </button>
          <button type="button" onClick={recheck} disabled={checking}>
            {checking ? t('dialog.checking') : t('dialog.recheck')}
          </button>
          <label className="field">
            {t('dialog.daemon')}
            <input
              type="text"
              name="bridge-url"
              value={url}
              aria-label={t('dialog.daemonAria')}
              onChange={(event) => setUrl(event.target.value)}
              onBlur={() => url !== status.url && onUrlChange(url.trim())}
            />
          </label>
          <div className="spacer" />
          {note === null ? (
            <a className="mono faint" href="https://www.npmjs.com/package/txt2sfx-bridge" target="_blank" rel="noreferrer">
              docs/BRIDGE.md
            </a>
          ) : (
            <span className="mono faint">{note}</span>
          )}
        </div>
      </div>
    </div>
  );
}
