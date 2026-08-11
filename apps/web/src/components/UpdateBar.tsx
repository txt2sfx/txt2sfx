/**
 * "A newer version is installed" — the one piece of interface the offline cache needs.
 *
 * It sits where the toast sits, and shares its look on purpose: both are the page telling
 * you something without taking the screen away from what you were doing. The difference is
 * that a toast is dismissed by reading it, and this one is a choice, so it carries a
 * button and does not vanish on its own.
 *
 * ## Why it can be ignored indefinitely
 *
 * There is no countdown and no second, louder prompt. The reader is the only one who knows
 * whether the recipe on screen is worth more than the update — `lib/updates.ts` lists what
 * a reload costs — and a bar that nags is a bar people learn to press without reading. It
 * stays until it is taken, and a browser that is closed with it still showing offers it
 * again on the next visit, because the worker is still waiting.
 *
 * @packageDocumentation
 */

import { useI18n } from '../lib/i18n.js';
import { useUpdate } from '../lib/updates.js';

export function UpdateBar(): React.JSX.Element | null {
  const { t } = useI18n();
  const update = useUpdate();

  if (!update.ready) return null;

  return (
    /* `role="status"` rather than `alert`: this is not urgent and interrupting a screen
       reader mid-sentence to say a cache is stale would be the wrong kind of loud. */
    <div className="toast update" role="status">
      <span>{t('update.ready')}</span>
      <button type="button" onClick={update.apply}>
        {t('update.apply')}
      </button>
    </div>
  );
}
