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
 * ## One button, whichever engine the tab is about
 *
 * The row sits above the tabs and stays put across all three, so the sentence in it is
 * the one thing both engines are asked. Pressing it therefore runs *the tab you are
 * looking at*: the loop on `Soundline`, the diffusion model on `Model`. The alternative —
 * one button that always meant the recipe — put the model's own Render button a scroll
 * away from the prompt it renders, and left the row's accent hue saying `Model` while the
 * button meant something else. The label is `Make sound` for the same reason: it is the
 * one verb that is true of both engines, where `Regenerate` described only the loop.
 *
 * What follows from that: on `Model` the provider and the key are not consulted at all
 * (nothing here goes to a vendor — the render happens on this machine through the
 * bridge), so what blocks the button there is the model not being installed yet, not an
 * empty key field. `Compare A / B` has no engine of its own and keeps the recipe's.
 *
 * The button also grows a spinner while a run is in flight. It is the smallest honest
 * signal there is: the stage list below says *what* is happening once a run reports
 * something, and until it does — a model render is ~30 s before its first line — the
 * only thing on screen that can say "yes, it started" is the control that was pressed.
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
import { useI18n, type Key } from '../lib/i18n.js';
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
  /** Whether the diffusion model is installed — what gates the button on the Model tab. */
  readonly modelReady: boolean;
  /** Runs whichever engine `view` is about; the screen decides which. */
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
  modelReady,
  onRun,
  onStop,
}: PromptRowProps): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const popover = useRef<HTMLDivElement | null>(null);

  const options = providerOptions(import.meta.env.DEV);
  const option = options.find((entry) => entry.kind === settings.kind);
  const wantsKey = option?.needsKey === true;
  /* Which engine this press means. Only the Model tab has one of its own; Compare has
     no engine and regenerating from it is regenerating the recipe. */
  const toModel = view === 'model';
  const blocked =
    prompt.trim() === '' || (toModel ? !modelReady : wantsKey && settings.apiKey.trim() === '');

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
          placeholder={t('prompt.placeholder')}
          aria-label={t('prompt.describeAria')}
          onChange={(event) => onPromptChange(event.target.value)}
        />

        <div className="provider" ref={popover}>
          <button
            type="button"
            className={`chip-hue${open ? ' selected' : ''}`}
            aria-expanded={open}
            title={t('prompt.providerTitle')}
            onClick={() => setOpen((current) => !current)}
          >
            {settings.kind}
            {settings.kind === 'agent' && !agentReady ? (
              <span className="warn-dot" title={t('prompt.noAgentDot')} />
            ) : null}
            <span className="caret-down">▾</span>
          </button>

          {open ? (
            <div className="popover">
              <label className="field">
                {t('prompt.model')}
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
                    {t('prompt.modelId')}
                    <input
                      type="text"
                      name="model-id"
                      value={settings.model}
                      placeholder={option?.defaultModel ?? 'default'}
                      aria-label={t('prompt.modelIdAria')}
                      onChange={(event) => onSettingsChange({ ...settings, model: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    {t('prompt.key')}
                    <input
                      type="password"
                      name="api-key"
                      value={settings.apiKey}
                      /* `off` is advisory and Chrome ignores it on password fields: it
                         offered a saved website password for this box. `new-password` is
                         the hint browsers honour, and an API key is closer to a new
                         secret than to a stored login anyway. */
                      autoComplete="new-password"
                      placeholder={t('prompt.keyPlaceholder', { provider: settings.kind })}
                      aria-label={t('prompt.keyAria', { provider: settings.kind })}
                      onChange={(event) => onSettingsChange({ ...settings, apiKey: event.target.value })}
                    />
                  </label>
                  {canRemember ? (
                    <label className="toggle" title={t('prompt.rememberTitle')}>
                      <input
                        type="checkbox"
                        name="remember-key"
                        checked={settings.remember}
                        onChange={(event) => onSettingsChange({ ...settings, remember: event.target.checked })}
                      />
                      {t('prompt.remember')}
                      {storedKeys.includes(settings.kind) ? (
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            onForgetKey(settings.kind);
                            onSettingsChange({ ...settings, apiKey: '', remember: false });
                          }}
                        >
                          {t('prompt.forget')}
                        </button>
                      ) : null}
                    </label>
                  ) : null}
                </>
              ) : null}

              <label className="toggle" title={hasReference ? '' : t('prompt.matchTitle')}>
                <input
                  type="checkbox"
                  name="match-reference"
                  checked={settings.matchReference && hasReference}
                  disabled={!hasReference}
                  onChange={(event) => onSettingsChange({ ...settings, matchReference: event.target.checked })}
                />
                {t('prompt.match')}
              </label>

              <p className="popover-note">{note(t, settings.kind, option?.keySource, agentReady)}</p>
            </div>
          ) : null}
        </div>

        {running ? (
          <button type="button" className="hue-button" onClick={onStop} disabled={stopping}>
            <span className="spinner" aria-hidden="true" />
            {stopping ? t('prompt.stopping') : t('prompt.stop')}
          </button>
        ) : (
          <button
            type="submit"
            className="hue-button"
            disabled={blocked}
            /* Which engine will answer, in the tooltip rather than in the label: the
               label is the verb and it does not change, and a button whose text moves
               under the cursor as tabs are switched is harder to aim at than one whose
               meaning is stated on hover. */
            title={t(toModel ? (modelReady ? 'prompt.runsModel' : 'prompt.modelMissing') : 'prompt.runsSoundline')}
          >
            {t('prompt.make')}
          </button>
        )}
      </form>
    </div>
  );
}

/**
 * One sentence about where the request goes. The most load-bearing text in the panel.
 *
 * Takes the translator rather than reading the store directly, so it re-runs with the
 * component that renders it instead of going stale on a language change.
 */
function note(
  t: (key: Key, params?: Readonly<Record<string, string | number>>) => string,
  kind: ProviderKind,
  keySource: string | undefined,
  agentReady: boolean,
): string {
  switch (kind) {
    case 'mock':
      return t('prompt.noteMock');
    case 'agent':
      return agentReady ? t('prompt.noteAgentReady') : t('prompt.noteAgentMissing');
    case 'bridge':
      return t('prompt.noteBridge');
    default:
      return (
        t('prompt.noteKey', { provider: kind }) +
        (keySource === undefined ? '' : t('prompt.noteKeySource', { url: keySource }))
      );
  }
}
