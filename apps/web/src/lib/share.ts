/**
 * A link that plays a sound, with nothing behind it.
 *
 * ## Why the recipe travels in the URL
 *
 * The obvious design for a share link is an id and a server that resolves it. This
 * project cannot use that design and should not want to: there is no service, the
 * whole argument is that a sound is a few hundred bytes of text, and a few hundred
 * bytes fit in a fragment. So the link *is* the recipe — base64url in the hash,
 * which never leaves the browser and is never sent to any origin, including
 * whichever one is serving the page.
 *
 * That gives three properties worth more than a short URL: the link works from a
 * static build on any host, it cannot rot because nothing has to stay up to resolve
 * it, and it discloses nothing to us because we never see it.
 *
 * The cost is length — a four-layer explosion makes a link around 900 characters,
 * which is fine in a chat message and awkward in a tweet. Stated plainly in the UI
 * rather than papered over with a shortener that would reintroduce the server.
 *
 * ## Why the recipient does not need a key
 *
 * They are not generating anything. The page parses the recipe, compiles it and
 * plays it, which is the same code path as the editor and needs no model, no bank
 * and no network.
 *
 * ## The second form, and why it is not a retreat
 *
 * `#recipe=<id>` names a recipe the bank already holds ({@link bankLink}). It gives
 * up the property above — it rots if the bank goes — and buys a link short enough
 * to be composed by something that is not a browser. Both stay: the id form is for
 * a sound that is already public, the payload form for one that exists nowhere
 * else, and nothing that has only ever lived in a tab can use the id form anyway.
 *
 * Both live in the fragment, so both are unfetchable by anything but a browser.
 * That is a feature for the payload — it discloses nothing to us — and a trap for
 * the id form, because a model handed one back cannot read it. The prompt in
 * `packages/agent/src/onboarding.ts` says so in as many words.
 *
 * @packageDocumentation
 */

/**
 * Where the published playground answers.
 *
 * Needed because {@link bankLink} has a caller that is not a browser tab handing a
 * link to a person in the same room: an outside model composing a link for somebody
 * it cannot see. `window.location.origin` is right for the first and useless for the
 * second — a chat told to hand out `http://localhost:5173/#recipe=12` has sent its
 * user nowhere.
 */
export const PUBLIC_SITE_URL = 'https://txt2sfx.github.io/';

/** What a share link carries. */
export interface SharedRecipe {
  readonly source: string;
  readonly name: string;
  readonly prompt: string;
}

/** UTF-8 safe base64url. `btoa` alone rejects anything non-Latin-1. */
function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * The link for a recipe.
 *
 * The name and the prompt ride along because a sound arriving with neither is a
 * waveform with no claim attached, and the claim — "this is what a rusty gate
 * sounds like" — is the interesting part.
 */
export function shareLink(recipe: SharedRecipe, origin = window.location.origin + window.location.pathname): string {
  const payload = encode(JSON.stringify({ s: recipe.source, n: recipe.name, p: recipe.prompt }));
  return `${origin}#play=${payload}`;
}

/**
 * Read a shared recipe out of the current URL, if there is one.
 *
 * Tolerant by design: a truncated link — the normal outcome of a chat client
 * wrapping a long URL — must produce `null` and an ordinary playground, not a
 * broken page.
 */
export function sharedFromLocation(hash = window.location.hash): SharedRecipe | null {
  const match = /[#&]play=([A-Za-z0-9\-_]+)/.exec(hash);
  if (match?.[1] === undefined) return null;
  try {
    const parsed = JSON.parse(decode(match[1])) as { s?: unknown; n?: unknown; p?: unknown };
    if (typeof parsed.s !== 'string' || parsed.s.trim() === '') return null;
    return {
      source: parsed.s,
      name: typeof parsed.n === 'string' && parsed.n !== '' ? parsed.n : 'shared',
      prompt: typeof parsed.p === 'string' ? parsed.p : '',
    };
  } catch {
    return null;
  }
}

/**
 * The other link: a recipe that is already in the bank, named by its id.
 *
 * ## Why this exists next to {@link shareLink} rather than instead of it
 *
 * They answer different questions. A share link is self-contained and cannot rot,
 * which is exactly right for a sound that exists nowhere but the sender's tab. This
 * one is nine characters instead of nine hundred, at the cost of needing the bank
 * to be up — which is a fair trade only because the recipe it names *came from* the
 * bank, so the dependency was already there.
 *
 * The reason it was worth adding is the one caller who cannot use the other: a chat
 * with a fetch button, handing a person a link to something it found. Composing a
 * `#play=` link means base64-encoding a recipe by hand, in a token stream, with no
 * way to check the result — and a corrupted payload does not fail loudly, it just
 * decodes to nothing and opens an empty playground.
 */
export function bankLink(id: number, origin = PUBLIC_SITE_URL): string {
  return `${origin.replace(/\/+$/, '')}/#recipe=${String(id)}`;
}

/**
 * Read a bank id out of the current URL, if there is one.
 *
 * Tolerant for the same reason {@link sharedFromLocation} is, plus one of its own:
 * this id is typed and re-typed by models and people, so anything that is not a
 * positive integer must produce an ordinary playground rather than a request for
 * recipe `NaN`.
 */
export function bankRefFromLocation(hash = window.location.hash): number | null {
  /* Anchored at both ends: unanchored, `#recipe=1.5` would match its leading `1` and
     open a different sound than the link named — the one failure here that is worse
     than doing nothing, because it looks like it worked. */
  const match = /[#&]recipe=(\d+)(?:&|$)/.exec(hash);
  if (match?.[1] === undefined) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Drop the payload from the address bar without reloading or adding history. */
export function clearShareFromLocation(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
