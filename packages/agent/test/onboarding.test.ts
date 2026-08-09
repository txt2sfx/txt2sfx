/**
 * The two paste-in prompts, pinned where they carry a claim that can go stale.
 *
 * Almost nothing here is about wording. A prompt is prose and prose should be free to
 * change; what is pinned is the handful of sentences that stop being true the moment
 * something else in the repository moves — an endpoint, a link format, a promise about
 * what the reader is allowed to do. Each of those failures is silent: the prompt still
 * reads well, the model still answers, and the answer is wrong somewhere the author
 * will never see.
 */

import { describe, expect, it } from 'vitest';
import { bridgeOnboardingPrompt, chatOnboardingPrompt } from '../src/index.js';

describe('the chat prompt', () => {
  const prompt = chatOnboardingPrompt();

  /* The endpoints it names are the contract with `apps/server`. A rename there that
     misses this file leaves a prompt that sends every chat to a 404 — and a 404 that
     the model will cheerfully summarise as "the bank has nothing like that". */
  it('names the search endpoint, the contract and the link format', () => {
    expect(prompt).toContain('https://txt2sfx.pix3.dev/api/retrieve?prompt=');
    expect(prompt).toContain('https://txt2sfx.pix3.dev/api/llms.txt');
    expect(prompt).toContain('https://txt2sfx.github.io/#recipe=<id>');
  });

  /* The marker is the entire measurement for this channel: no marker, no way to tell a
     chat's search from the playground's own few-shot retrieval in the access log, and
     therefore no way to answer "is this door used" before building more of it. */
  it('carries the via=chat marker on the search it asks for', () => {
    expect(prompt).toContain('&via=chat');
  });

  /* Three refusals, and each one is a failure mode this channel has by construction:
     a chat that claims a sound fits has no ear; a chat that fetches a fragment link
     gets the app shell and invents the rest; a chat asked for a key sends the user
     looking for one that does not exist. */
  it('forbids claiming a sound is right, fetching a fragment, and asking for a key', () => {
    expect(prompt).toMatch(/never tell me a sound is right/i);
    expect(prompt).toMatch(/do not fetch it/i);
    expect(prompt).toMatch(/never ask me for one/i);
  });

  /* Designing is the footnote, not the job. If this ordering inverts, the channel stops
     being "the bank, from your chat" and becomes "plausible Web Audio with our name on
     it" — which is the thing the reader could already get without us. */
  it('puts search before the grammar, and says an unheard sound is unheard', () => {
    expect(prompt.indexOf('/api/retrieve')).toBeLessThan(prompt.indexOf('/api/llms.txt'));
    expect(prompt).toMatch(/heard by nobody/i);
  });

  /* A self-hosted bank is the case this is parameterised for; a hard-coded origin
     surviving in the middle of the text would point somebody's private instance at
     ours. */
  it('follows a bank and a playground that are somewhere else', () => {
    const custom = chatOnboardingPrompt({
      bankUrl: 'http://127.0.0.1:8787/',
      playgroundUrl: 'http://localhost:5173',
    });
    expect(custom).toContain('http://127.0.0.1:8787/api/retrieve?prompt=');
    expect(custom).toContain('http://localhost:5173/#recipe=<id>');
    expect(custom).not.toContain('txt2sfx.pix3.dev');
    expect(custom).not.toContain('txt2sfx.github.io');
  });

  /* It is going into a chat box. A fenced block pasted into a fenced block is how
     instructions arrive mangled — the same rule the bridge prompt is written to. */
  it('is plain text with no code fences', () => {
    expect(prompt).not.toContain('```');
  });
});

describe('the bridge prompt', () => {
  /* The two prompts address clients with nothing in common, and the split is only worth
     having if it stays a split: a chat told to run `npx` is stuck, and an agent told it
     may not design has been handed a validator and a renderer for nothing. */
  it('asks for the opposite of what the chat prompt asks for', () => {
    const bridge = bridgeOnboardingPrompt();
    expect(bridge).toContain('sfx_contract');
    expect(bridge).toContain('npx');
    expect(chatOnboardingPrompt()).not.toContain('npx');
    expect(chatOnboardingPrompt()).not.toContain('sfx_');
  });
});
