/**
 * The prompt, the model, and the key — in one row and one popover.
 *
 * ## Why the provider controls hide
 *
 * The old panel put five controls in a line: provider, model id, key, remember, match
 * reference. Every one of them earns its place and none of them is touched twice in an
 * hour. Meanwhile the *prompt* is edited constantly, and burying it among its own
 * settings made the primary action the smallest thing in the panel.
 *
 * So the row is the prompt and the button, and the settings live behind a chip that
 * names the current provider. The chip is not a hamburger: it always says which model
 * will answer, which is the one piece of that state a person needs to see without
 * clicking — the difference between `mock` and `gemini` is the difference between a
 * free local answer and a paid remote one, and finding that out by pressing Generate
 * is not acceptable.
 *
 * ## The key
 *
 * Unchanged in substance from the old panel, because the reasoning was right: a
 * `password` input, React state, handed to the provider factory when a run starts and
 * held nowhere else — no module cache, and the providers never read an environment. By
 * default closing the tab forgets it.
 *
 * **Remember** is opt-in per provider and encrypts before storing: AES-GCM under a
 * non-extractable `CryptoKey` in IndexedDB, never `localStorage` (see `lib/keystore.ts`
 * for what that does and does not protect against). It is a checkbox rather than a
 * default because it is the user's credential and the trade is theirs, and there is a
 * Forget button beside it because a security feature you cannot undo is a trap.
 *
 * @packageDocumentation
 */

import { useEffect, useRef, useState } from 'react';
import { needsKey, providerOptions, type ProviderKind } from '../lib/agent.js';
import { canRemember } from '../lib/keystore.js';
import { HUE } from '../lib/design.js';
import type { ProviderSettings } from '../lib/useGenerate.js';

/** Which of the three studio views is showing, so the row can take its hue. */
export type StudioView = 'sound' | 'model' | 'compare';

export interface PromptRowProps {
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  readonly settings: ProviderSettings;
  readonly onSettingsChange: (settings: ProviderSettings) => void;
  readonly storedKeys: readonly string[];
  readonly onForgetKey: (kind: ProviderKind) => void;
  readonly onLoadKey: (kind: ProviderKind) => Promise<string | null>;
  readonly hasReference: boolean;
  /** True when the bridge daemon has an agent attached — `agent` is useless without one. */
  readonly agentReady: boolean;
  readonly running: boolean;
  readonly stopping: boolean;
  readonly view: StudioView;
  readonly onRun: () => void;
  readonly onStop: () => void;
}

export function PromptRow({
  prompt,
  onPromptChange,
  settings,
  onSettingsChange,
  storedKeys,
  onForgetKey,
  onLoadKey,
  hasReference,
  agentReady,
  running,
  stopping,
  view,
  onRun,
  onStop,
}: PromptRowProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const popover = useRef<HTMLDivElement | null>(null);

  const options = providerOptions(import.meta.env.DEV);
  const option = options.find((entry) => entry.kind === settings.kind);
  const wantsKey = option?.needsKey === true;
  const blocked = prompt.trim() === '' || (wantsKey && settings.apiKey.trim() === '');

  /* Fill the field from storage when the provider changes to one that has a key. Never
     overwrites something already typed — a key in the box is the user's most recent
     intent, and a stored one is history. */
  useEffect(() => {
    if (!needsKey(settings.kind)) return;
    if (!storedKeys.includes(settings.kind)) return;
    let cancelled = false;
    void onLoadKey(settings.kind).then((secret) => {
      if (cancelled || secret === null) return;
      onSettingsChange({ ...settings, apiKey: settings.apiKey === '' ? secret : settings.apiKey, remember: true });
    });
    return () => {
      cancelled = true;
    };
    /* Deliberately keyed on the provider only: re-running this on every keystroke in the
       key field would fight the user for the field. */
  }, [settings.kind, storedKeys]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (popover.current !== null && !popover.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  const hue = view === 'model' ? HUE.model : view === 'compare' ? HUE.compare : HUE.recipe;

  return (
    <div className="prompt-row" style={{ ['--hue' as string]: String(hue) }}>
      <form
        className="input-shell hue"
        onSubmit={(event) => {
          event.preventDefault();
          if (!running && !blocked) onRun();
        }}
      >
        <span className="mono caret">&gt;</span>
        <input
          type="text"
          name="prompt"
          className="mono"
          value={prompt}
          placeholder="a heavy metal door slamming shut in a corridor"
          aria-label="describe the sound"
          onChange={(event) => onPromptChange(event.target.value)}
        />

        <div className="provider" ref={popover}>
          <button
            type="button"
            className={`chip-hue${open ? ' selected' : ''}`}
            aria-expanded={open}
            title="which model answers, and with which key"
            onClick={() => setOpen((current) => !current)}
          >
            {settings.kind}
            {settings.kind === 'agent' && !agentReady ? <span className="warn-dot" title="no agent attached" /> : null}
            <span className="caret-down">▾</span>
          </button>

          {open ? (
            <div className="popover">
              <label className="field">
                model
                <select
                  name="provider"
                  value={settings.kind}
                  onChange={(event) =>
                    onSettingsChange({ ...settings, kind: event.target.value as ProviderKind, apiKey: '' })
                  }
                >
                  {options.map((entry) => (
                    <option key={entry.kind} value={entry.kind}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>

              {wantsKey ? (
                <>
                  <label className="field">
                    model id
                    <input
                      type="text"
                      name="model-id"
                      value={settings.model}
                      placeholder={option?.defaultModel ?? 'default'}
                      aria-label="model id"
                      onChange={(event) => onSettingsChange({ ...settings, model: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    key
                    <input
                      type="password"
                      name="api-key"
                      value={settings.apiKey}
                      /* `off` is advisory and Chrome ignores it on password fields: it
                         offered a saved website password for this box. `new-password` is
                         the hint browsers honour, and an API key is closer to a new
                         secret than to a stored login anyway. */
                      autoComplete="new-password"
                      placeholder={`your ${settings.kind} key — this tab only`}
                      aria-label={`${settings.kind} API key`}
                      onChange={(event) => onSettingsChange({ ...settings, apiKey: event.target.value })}
                    />
                  </label>
                  {canRemember ? (
                    <label
                      className="toggle"
                      title="Encrypted with a non-extractable key in IndexedDB — not localStorage. Any script on this origin could still use it: see lib/keystore.ts."
                    >
                      <input
                        type="checkbox"
                        name="remember-key"
                        checked={settings.remember}
                        onChange={(event) => onSettingsChange({ ...settings, remember: event.target.checked })}
                      />
                      remember this key
                      {storedKeys.includes(settings.kind) ? (
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            onForgetKey(settings.kind);
                            onSettingsChange({ ...settings, apiKey: '', remember: false });
                          }}
                        >
                          forget
                        </button>
                      ) : null}
                    </label>
                  ) : null}
                </>
              ) : null}

              <label className="toggle" title={hasReference ? '' : 'load a reference in Compare A / B first'}>
                <input
                  type="checkbox"
                  name="match-reference"
                  checked={settings.matchReference && hasReference}
                  disabled={!hasReference}
                  onChange={(event) => onSettingsChange({ ...settings, matchReference: event.target.checked })}
                />
                fit the numbers to the reference
              </label>

              <p className="popover-note">{note(settings.kind, option?.keySource, agentReady)}</p>
            </div>
          ) : null}
        </div>

        {running ? (
          <button type="button" className="hue-button" onClick={onStop} disabled={stopping}>
            {stopping ? 'stopping…' : 'Stop'}
          </button>
        ) : (
          <button type="submit" className="hue-button" disabled={blocked}>
            Regenerate
          </button>
        )}
      </form>
    </div>
  );
}

/** One sentence about where the request goes. The most load-bearing text in the panel. */
function note(kind: ProviderKind, keySource: string | undefined, agentReady: boolean): string {
  switch (kind) {
    case 'mock':
      return 'answers from the recipes in the catalog — no network, no key, and the validator, render, optimizer and export all still run';
    case 'agent':
      return agentReady
        ? 'the request goes to your coding agent over the local bridge — no key, and nothing leaves this machine'
        : 'no agent is attached to the bridge yet — open the badge in the header for the two commands';
    case 'bridge':
      return 'the request waits for window.txt2sfx.reply(id, text) in devtools — no network';
    default:
      return `the key lives in this tab only and goes nowhere but ${kind}${keySource === undefined ? '' : ` · get one at ${keySource}`}`;
  }
}
