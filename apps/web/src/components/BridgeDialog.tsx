/**
 * What the bridge badge opens: who answers, why not, and how to fix it.
 *
 * ## Why every model setting is in here
 *
 * Because they are all answers to one question — *who holds a language model for this
 * tab* — and they used to be answered in two places. The prompt row carried a picker, a
 * key field and a model id; this dialog carried the agent that made the picker's `agent`
 * entry work. Someone whose agent was not attached had to notice a small amber dot in the
 * row, open a dialog reached from the *header*, fix the daemon, and come back. Two
 * surfaces, one subject, and the connection between them was a coloured dot.
 *
 * So the row now states the outcome and nothing else, and everything that *decides* that
 * outcome is here: the agent checks, the Gemini key that takes over when there is no
 * agent, and the model id. The headline says which of the two will answer the next press,
 * computed by the same `chooseProvider` the button reads — there is no second copy of the
 * rule that could disagree with the first.
 *
 * What is *not* here any more is `Fit to reference`. It was the one control in this dialog
 * that answered a different question — not who writes the recipe, but what the numbers are
 * aimed at — and a checkbox that only means something once a B side is loaded belongs
 * beside the B side. It is a button in Compare A / B now.
 *
 * ## Why the tabs are the whole dialog and not a step inside it
 *
 * There is exactly one question here — *who holds a model* — and the answers are mutually
 * exclusive: a Gemini key, or one of five ways to attach a coding agent. Those used to be
 * two different shapes on one page, a key section stacked above a client picker that was
 * buried inside step 1 of a setup, so the picker read as "pick your client" when it is
 * really "pick your model". One tab strip over the whole dialog says what it is: six
 * answers to one question, and only the chosen one is on screen.
 *
 * It opens on the answer that is live — Gemini when a key is what would run, the agent
 * setup otherwise, since the reason to be reading this with no key is usually that the
 * agent is not attached yet.
 *
 * ## Why the key is remembered without being asked
 *
 * The checkbox was a question with one sensible answer given three times an hour: nobody
 * pastes a key in order to paste it again after a reload. What made it feel like a
 * decision was not knowing where it goes, so the sentence that used to be a tooltip is
 * now printed under the field — encrypted under a non-extractable key in IndexedDB, on
 * this machine, never in `localStorage` and never through a server of ours. **forget**
 * is the undo, and it is one click, which is what the checkbox was really protecting.
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
 * ## Why a tab per client and not one config blob
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
 * the bridge is broken.
 *
 * There is no longer a `Copy agent prompt` beside them. It copied a paragraph of
 * instructions for an agent that is not attached yet — which is to say, for an agent that
 * cannot be pasted into from this dialog anyway — and it sat in the footer looking like
 * the primary action of a dialog whose primary action is the one command in the tab above
 * it. The same text still ships where it is reachable without a browser:
 * `txt2sfx-bridge doctor` prints it.
 *
 * @packageDocumentation
 */

import { useState } from 'react';
import { GEMINI_DEFAULT_MODEL, GEMINI_KEY_SOURCE, type ProviderKind } from '../lib/agent.js';
import { copy } from '../lib/download.js';
import { canRemember } from '../lib/keystore.js';
import { t, useI18n, type Key } from '../lib/i18n.js';
import type { BridgeStatus } from '../lib/bridge-client.js';
import type { ProviderSettings } from '../lib/useGenerate.js';

export interface BridgeDialogProps {
  readonly status: BridgeStatus;
  readonly onClose: () => void;
  readonly onRecheck: () => Promise<unknown>;
  readonly onUrlChange: (url: string) => void;

  /* --- the model settings, which is all of them --- */

  readonly settings: ProviderSettings;
  readonly onSettingsChange: (settings: ProviderSettings) => void;
  /** Who answers right now, as `chooseProvider` decided. `null` means nobody can. */
  readonly model: ProviderKind | null;
  /** True when a key is stored on this machine, so **forget** appears only when it undoes something. */
  readonly keyStored: boolean;
  readonly onForgetKey: () => void;
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

export function BridgeDialog({
  status,
  onClose,
  onRecheck,
  onUrlChange,
  settings,
  onSettingsChange,
  model,
  keyStored,
  onForgetKey,
}: BridgeDialogProps): React.JSX.Element {
  /* Subscribed for the re-render only. The strings come from the module-level `t`, which
     is also what `clientRecipes` above has to use — it is not a component and cannot hold
     a hook, and having one half of this dialog read a different translator than the other
     is how a language change leaves a stale sentence on screen. */
  useI18n();
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [url, setUrl] = useState(status.url);
  /* Opened on the answer that is live. `'gemini'` only when a key is what would actually
     run: with no key and no agent the reader's problem is almost always the agent, and
     `'claude'` is the shortest path out of that. Read once — retargeting the bridge from
     the tab you are on must not move you to a different one. */
  const [tab, setTab] = useState(model === 'gemini' ? 'gemini' : 'claude');

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
  const recipe = recipes.find((candidate) => candidate.id === tab) ?? recipes[0]!;

  /* The daemon is checked too, and is the first row on screen — it is not in this list
     because its value is an address the reader can edit rather than a fact to report. */
  const checks: readonly { key: Key; label: string; value: string; ok: boolean }[] = [
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
          <span className={`dot ${model === null ? 'dot-bad' : 'dot-ok'}`} />
          <h3>{t('dialog.bridgeTitle')}</h3>
          <div className="spacer" />
          <button type="button" className="icon" onClick={onClose} aria-label={t('dialog.close')}>
            ✕
          </button>
        </div>

        {/* The outcome first, in one sentence, because it is the only thing most people
            open this for: the run they are about to start either has a model or it does
            not. Everything below is why, and what to do about it. */}
        <p className="dialog-lede">
          {t(
            model === 'agent'
              ? 'dialog.answersAgent'
              : model === 'gemini'
                ? 'dialog.answersGemini'
                : 'dialog.answersNobody',
            { client: agent?.client ?? t('dialog.mcpClient'), model: settings.model.trim() || GEMINI_DEFAULT_MODEL },
          )}
        </p>

        {/* One strip over the whole dialog: six answers to "who holds a model", and
            only the chosen one below it. Gemini takes the violet accent because it is
            the one answer that is not a coding agent. */}
        <nav className="segmented small wrap dialog-tabs" aria-label={t('dialog.tabsAria')}>
          <button
            type="button"
            className={tab === 'gemini' ? 'selected violet' : ''}
            aria-current={tab === 'gemini'}
            onClick={() => setTab('gemini')}
          >
            Gemini
          </button>
          {recipes.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={candidate.id === tab ? 'selected cyan' : ''}
              aria-current={candidate.id === tab}
              onClick={() => setTab(candidate.id)}
            >
              {candidate.label}
            </button>
          ))}
        </nav>

        {tab === 'gemini' ? (
          /* `bare`: on this tab the section is the whole page, and rules above and below
             the only thing on screen read as a divider between nothing and nothing. */
          <div className="dialog-section bare">
            <div className="step-title">{t('dialog.keyTitle')}</div>
            <div className="model-fields">
              <label className="field wide">
                {t('dialog.key')}
                <input
                  type="password"
                  name="api-key"
                  /* `off` is advisory and Chrome ignores it on password fields: it offered a
                     saved website password for this box. `new-password` is the hint browsers
                     honour, and an API key is closer to a new secret than to a stored login. */
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={t('dialog.keyPlaceholder')}
                  value={settings.apiKey}
                  onChange={(event) => onSettingsChange({ ...settings, apiKey: event.target.value })}
                />
              </label>
              <label className="field wide">
                {t('dialog.modelId')}
                <input
                  type="text"
                  name="model-id"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={GEMINI_DEFAULT_MODEL}
                  value={settings.model}
                  onChange={(event) => onSettingsChange({ ...settings, model: event.target.value })}
                />
              </label>
            </div>
            <p className="step-note">{t('dialog.keyNote', { source: GEMINI_KEY_SOURCE })}</p>
            {/* Its own line, not appended: the sentence above ends in a bare URL, and
                anything glued to that reads as part of the address. */}
            {model === 'agent' ? <p className="step-note">{t('dialog.keyIdle')}</p> : null}
            {/* Where it is kept, printed rather than tucked into a tooltip on a checkbox
                nobody wanted to tick: the worry the checkbox was answering is "does this
                leave my machine", and that is a sentence, not a decision. */}
            <p className="step-note">
              {canRemember ? t('dialog.keyStorage') : t('dialog.keyStorageNone')}
              {canRemember && keyStored ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      onForgetKey();
                      onSettingsChange({ ...settings, apiKey: '' });
                    }}
                  >
                    {t('dialog.forget')}
                  </button>
                </>
              ) : null}
            </p>
          </div>
        ) : (
          <>
            <p className="dialog-lede">
              {live
                ? t('dialog.bridgeLedeLive')
                : t('dialog.bridgeLedeDead', { host: new URL(status.url).host })}
            </p>

            <div className="checks">
              {/* The address *is* this check's value, so it is edited in place instead of
                  being repeated in a second field at the foot of the dialog — and Re-check
                  sits beside it because it asks exactly this row's question again. */}
              <div className="check check-daemon">
                <span className={`mark ${live ? 'good' : 'bad'}`}>{live ? '✓' : '✕'}</span>
                <span className="check-label">{t('dialog.checkDaemon')}</span>
                <input
                  type="text"
                  className="mono check-url"
                  name="bridge-url"
                  value={url}
                  aria-label={t('dialog.daemonAria')}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setUrl(event.target.value)}
                  onBlur={() => url !== status.url && onUrlChange(url.trim())}
                />
                <button type="button" className="check-action" onClick={recheck} disabled={checking}>
                  {checking ? t('dialog.checking') : t('dialog.recheck')}
                </button>
              </div>
              {checks.map((check) => (
                <div className="check" key={check.key}>
                  <span className={`mark ${check.ok ? 'good' : 'bad'}`}>{check.ok ? '✓' : '✕'}</span>
                  <span className="check-label">{check.label}</span>
                  <span className="mono faint">{check.value}</span>
                </div>
              ))}
            </div>

            {/* Why the first row is a cross, when the row itself now holds an input and
                has no room left to say so. */}
            {live ? null : <p className="step-note bad">{status.error ?? t('dialog.noResponse')}</p>}

            <div className="steps">
              <div className="step">
                <span className="step-n">1</span>
                <div className="step-body">
                  <div className="step-title">{t('dialog.step1')}</div>
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
          </>
        )}

        <div className="dialog-foot">
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
