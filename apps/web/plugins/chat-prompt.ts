/**
 * `/chat.txt` — the instructions an ordinary chat reads to reach this project.
 *
 * ## Why a build artefact and not a file in `public/`
 *
 * The text is `chatOnboardingPrompt()` in `@txt2sfx/agent`, which is where the
 * bridge's paste-in prompt already lives, and it names the bank URL, the search
 * endpoint and the shape of a playground link. A second copy checked into
 * `public/` would be the copy that goes stale — silently, because nothing fails
 * when a served text file disagrees with the code it describes. Emitting it puts
 * the file one function away from the endpoints it documents.
 *
 * ## Why it is served at all
 *
 * The whole channel is a paste, and every character of that paste is friction
 * measured against "just write me a beep in Web Audio", which the model can do
 * with no fetch at all. Serving the instructions turns the paste into one line
 * naming a URL, and gives a chat opened next year today's text rather than a
 * snapshot of it.
 *
 * `text/plain` rather than anything cleverer: a fetch tool that pipes HTML
 * through a converter mangles what it reads, and this file is instructions.
 *
 * Unlike `plugins/metrika.ts` this has no `apply` — it belongs in the dev server
 * too, because the one thing worth checking by hand is that the URL answers.
 *
 * @packageDocumentation
 */

import type { Plugin } from 'vite';
/* The source, not the package: `@txt2sfx/agent` resolves to `dist/`, and a config
   file that cannot load until someone has run `pnpm build` breaks `pnpm dev` on a
   fresh clone. The alias in `vite.config.ts` applies to the app's bundle, never to
   the config that declares it. */
import { chatOnboardingPrompt, type ChatOnboardingOptions } from '../../../packages/agent/src/onboarding.js';

/** Where the emitted file lands, relative to the site root. */
export const CHAT_PROMPT_PATH = 'chat.txt';

/**
 * Emit `/chat.txt` into the build, and answer it during `vite dev`.
 *
 * @param options Overrides for the URLs the prompt names. Defaults are the public
 *   bank and the published playground — a chat is never on this machine, so a
 *   loopback URL in this file would be useless to the model that reads it, even
 *   when a developer is the one serving it.
 */
export function chatPrompt(options: ChatOnboardingOptions = {}): Plugin {
  const body = (): string => `${chatOnboardingPrompt(options)}\n`;
  return {
    name: 'txt2sfx:chat-prompt',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: CHAT_PROMPT_PATH, source: body() });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        /* The query string is not part of the match: a URL pasted into a chat
           collects tracking parameters on the way, and a 404 there would look
           like the project is gone. */
        const path = (request.url ?? '').split('?')[0] ?? '';
        if (path !== `/${CHAT_PROMPT_PATH}`) {
          next();
          return;
        }
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end(body());
      });
    },
  };
}
