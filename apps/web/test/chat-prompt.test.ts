/**
 * `/chat.txt`, which is the whole install for the one client that installs nothing.
 *
 * The failure this guards is quiet in the worst way: the playground builds, the page
 * loads, every test passes, and the one URL a person pasted into their chat answers
 * 404 — which the model reports as "I could not find instructions", if it reports
 * anything at all. Nothing else in this repository would notice.
 *
 * The plugin is exercised through its hooks rather than through a real build: a build
 * takes seconds and would be testing Vite, not this.
 */

import { describe, expect, it } from 'vitest';
import { CHAT_PROMPT_PATH, chatPrompt } from '../plugins/chat-prompt.js';

/** What the plugin would put in the bundle, by calling its hook with a recorder. */
function emitted(plugin: ReturnType<typeof chatPrompt>): { fileName: string; source: string } {
  const files: { fileName: string; source: string }[] = [];
  const hook = plugin.generateBundle;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (fn === undefined) throw new Error('the plugin emits nothing');
  fn.call(
    { emitFile: (file: { fileName?: string; source?: unknown }) => files.push({ fileName: file.fileName ?? '', source: String(file.source) }) } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return files[0]!;
}

/** Drive the dev-server middleware for one URL, and report what it answered. */
function served(plugin: ReturnType<typeof chatPrompt>, url: string): { body: string | null; passed: boolean } {
  const stack: ((req: unknown, res: unknown, next: () => void) => void)[] = [];
  const hook = plugin.configureServer;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (fn === undefined) throw new Error('the plugin serves nothing');
  fn.call({} as never, { middlewares: { use: (handler: never) => stack.push(handler) } } as never);

  let body: string | null = null;
  let passed = false;
  const headers: Record<string, string> = {};
  stack[0]!(
    { url },
    { setHeader: (name: string, value: string) => (headers[name] = value), end: (text: string) => (body = text) },
    () => (passed = true),
  );
  if (body !== null) expect(headers['content-type']).toBe('text/plain; charset=utf-8');
  return { body, passed };
}

describe('the chat prompt file', () => {
  it('lands at the root of the site, where the pasted URL points', () => {
    expect(CHAT_PROMPT_PATH).toBe('chat.txt');
    expect(emitted(chatPrompt()).fileName).toBe('chat.txt');
  });

  /* Generated from `chatOnboardingPrompt`, never a copy: a second copy of these
     instructions is the one that goes stale, silently, the next time an endpoint
     moves. Two lines the model acts on are enough to prove which one shipped. */
  it('is the prompt itself, not a summary of it', () => {
    const { source } = emitted(chatPrompt());
    expect(source).toContain('/api/retrieve?prompt=');
    expect(source).toContain('&via=chat');
    expect(source.endsWith('\n')).toBe(true);
  });

  /* Named URLs point outward even here. A developer serving this locally is not the
     audience — the chat that reads it is somewhere else entirely, and a loopback
     address in these instructions is one the model cannot reach. */
  it('names the public bank even when it is a developer serving it', () => {
    expect(emitted(chatPrompt()).source).toContain('https://txt2sfx.pix3.dev');
  });

  it('answers on the dev server, query string and all, and passes everything else on', () => {
    const plugin = chatPrompt();
    expect(served(plugin, '/chat.txt').body).toContain('/api/retrieve');
    expect(served(plugin, '/chat.txt?utm_source=somewhere').body).toContain('/api/retrieve');
    const other = served(plugin, '/index.html');
    expect(other.body).toBeNull();
    expect(other.passed).toBe(true);
  });
});
