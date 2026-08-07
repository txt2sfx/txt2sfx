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

/** One entry per tab, shortest honest path first. */
function clientRecipes(port: string): readonly ClientRecipe[] {
  const argv = `npx ${bridgeArgs(port).join(' ')}`;
  return [
    {
      id: 'claude',
      label: 'Claude Code',
      code: `claude mcp add txt2sfx -- ${argv}`,
      note: 'That is the whole install — no daemon to start first. Add `-s user` after `add` to have it in every project. Restart Claude Code afterwards: it reads its server list at startup.',
    },
    {
      id: 'codex',
      label: 'Codex',
      code: `codex mcp add txt2sfx -- ${argv}`,
      note: 'Writes [mcp_servers.txt2sfx] into ~/.codex/config.toml and starts the bridge on first use. Restart codex afterwards.',
    },
    {
      id: 'opencode',
      label: 'opencode',
      file: 'opencode.json — in the project, or ~/.config/opencode/',
      code: JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: { txt2sfx: { type: 'local', command: ['npx', ...bridgeArgs(port)], enabled: true } },
        },
        null,
        2,
      ),
      note: 'opencode has no add command, so the file is the interface — and its key is `mcp` with type "local", not `mcpServers`. Restart opencode afterwards.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      file: '~/.cursor/mcp.json — or .cursor/mcp.json for one project',
      code: mcpConfig(port),
      note: 'Settings → MCP → New MCP server writes the same file. Reload the window afterwards.',
    },
    {
      id: 'other',
      label: 'Other',
      code: mcpConfig(port),
      note: 'Claude Desktop, Windsurf, Zed and most other clients take this shape; only the path to the file differs. Anything that speaks MCP over stdio can run it.',
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
        aria-label={`copy ${what}`}
        title={`Copy ${what}`}
        onClick={() => void copy(code, what).then(onCopied)}
      >
        ⧉
      </button>
    </div>
  );
}

export function BridgeDialog({ status, onClose, onRecheck, onUrlChange }: BridgeDialogProps): React.JSX.Element {
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

  const checks: readonly { label: string; value: string; ok: boolean }[] = [
    {
      label: 'Bridge daemon',
      value: live ? new URL(status.url).host : (status.error ?? 'no response'),
      ok: live,
    },
    {
      label: 'Wire protocol',
      value: health === null ? '—' : `v${String(health.protocol)} · bridge ${health.version}`,
      ok: live,
    },
    {
      label: 'Agent attached',
      value:
        agent?.connected === true
          ? `${agent.client ?? 'MCP client'}${agent.sampling ? ' · sampling' : ''}`
          : live
            ? 'register the MCP server below'
            : '—',
      ok: agent?.connected === true,
    },
    {
      label: 'Renderer',
      value:
        health === null
          ? '—'
          : health.renderer === 'playground'
            ? 'this tab · 44.1 kHz'
            : health.renderer === 'native'
              ? 'node-web-audio-api'
              : 'none — validate only',
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
        aria-label="local agent bridge"
      >
        <div className="dialog-head">
          <span className={`dot ${live ? 'dot-ok' : 'dot-bad'}`} />
          <h3>Local agent bridge</h3>
          <div className="spacer" />
          <button type="button" className="icon" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>

        <p className="dialog-lede">
          {live
            ? 'The bridge runs on your machine and lets a coding agent design, render, audition and export sounds here — with no API key, because the agent already has a model. It can also answer this playground’s own Generate button.'
            : `Nothing is listening on ${new URL(status.url).host}. Register the server below and your client starts the bridge itself — in either direction.`}
        </p>

        <div className="checks">
          {checks.map((check) => (
            <div className="check" key={check.label}>
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
              <div className="step-title">Point your agent at the bridge</div>
              <nav className="segmented small wrap" aria-label="agent">
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
              <CodeBlock code={recipe.code} what={`the ${recipe.label} setup`} onCopied={say} />
              <div className="step-note">{recipe.note}</div>
            </div>
          </div>

          <div className="step">
            <span className="step-n">2</span>
            <div className="step-body">
              <div className="step-title">Ask the agent to introduce itself</div>
              <CodeBlock
                code={'call sfx_contract, then design a "wet bubble pop" and audition it'}
                what="the first ask"
                onCopied={say}
              />
              <div className="step-note">
                sfx_contract hands over the whole grammar in one call. No API key is involved anywhere: your agent is
                the model.
              </div>
            </div>
          </div>
        </div>

        <div className="dialog-foot">
          <button
            type="button"
            className="primary"
            onClick={() => void copy(agentPrompt(), 'the agent prompt').then(say)}
            title="Paste it into your agent — it registers the server itself and makes the first sound"
          >
            Copy agent prompt
          </button>
          <button type="button" onClick={recheck} disabled={checking}>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
          <label className="field">
            daemon
            <input
              type="text"
              name="bridge-url"
              value={url}
              aria-label="bridge daemon URL"
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
