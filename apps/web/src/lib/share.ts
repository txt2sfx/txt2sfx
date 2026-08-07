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
 * @packageDocumentation
 */

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

/** Drop the payload from the address bar without reloading or adding history. */
export function clearShareFromLocation(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
