/**
 * The playground's half of freesound.org: a search, a preview, and a licence.
 *
 * ## Why a recording is allowed in the building
 *
 * For the reason the diffusion model is: it is a **target**, never the answer. What
 * this project ships is a few hundred bytes of JavaScript; what a library hands back
 * is a megabyte of somebody else's WAV under somebody else's licence. As a deliverable
 * they are not in the same category. As a *reference* the library is the cheapest one
 * there is — the slow step in a session is finding a recording of "a rusty gate
 * opening slowly, then a heavy latch", and here it is a sentence and one request.
 *
 * So everything here ends where a dropped file ends: `App`'s reference, the B side of
 * Compare, `⌖ Fit to reference`, `match reference` on a generate run.
 *
 * ## No proxy, and that was measured before it was designed
 *
 * ```
 * GET  freesound.org/apiv2/search/text/    → Access-Control-Allow-Origin: *
 * OPTIONS (Access-Control-Request-Headers: authorization)
 *                                          → Access-Control-Allow-Headers: …authorization…
 *                                             Access-Control-Max-Age: 86400
 * GET  cdn.freesound.org/previews/…        → Access-Control-Allow-Origin: *, Accept-Ranges
 * ```
 *
 * Both ends send `*`, so the tab talks to the library directly: nothing is proxied
 * through a service, no request happens that the user did not start, and the static
 * build on Pages has the same capability as `pnpm dev`. The preview carrying CORS as
 * well is what makes it *decodable* rather than merely playable — `decodeAudioData`
 * needs the header, an `<audio>` element does not — and decoding is the whole point,
 * because a target that cannot be measured is a target this app has no use for.
 *
 * The key travels in `Authorization: Token …` rather than `?token=`, so it never lands
 * in a URL — not in history, not in a referrer, not in an access log. The cost is a
 * preflight, and `Access-Control-Max-Age: 86400` makes it a daily one.
 *
 * ## What this cannot do
 *
 * **Download the original.** That endpoint is behind OAuth2, which means a redirect
 * and a client secret; a static page has neither and should not pretend to. The
 * preview is a ~128 kbps MP3, which is enough to *judge* a sound and not enough to
 * ship one — so the panel says so, offers the preview, and links to the page where
 * the original is.
 *
 * Written against **Freesound APIv2** as documented on 2026-08-08; the request shape
 * and the field mapping are pinned in `test/freesound.test.ts` with an injected
 * `fetch`, the same way the model providers are.
 *
 * @packageDocumentation
 */

/** What a search returns per sound, after mapping the API's names onto ours. */
export interface FreesoundSound {
  readonly id: number;
  readonly name: string;
  /** The sound's page — where the original, the licence and the author are. */
  readonly url: string;
  readonly seconds: number;
  /** The licence as a URL, exactly as the API states it. See {@link licenseOf}. */
  readonly license: string;
  readonly username: string;
  readonly tags: readonly string[];
  readonly channels: number;
  readonly sampleRate: number;
  readonly bytes: number;
  readonly rating: number;
  readonly downloads: number;
  /** Highest-quality preview, MP3. Empty when the library offered none. */
  readonly preview: string;
}

/** One page of results, and how many there were in total. */
export interface FreesoundPage {
  readonly count: number;
  readonly sounds: readonly FreesoundSound[];
}

/**
 * Why a search did not happen, in the shape the panel can translate.
 *
 * A `code` rather than a sentence: this module has no business deciding what language
 * the reader has chosen, and the panel already has `t()`. The `message` is for the
 * console and for a bug report — it names the status and the library's own `detail`,
 * which is the only text that can explain a refusal this code has never seen.
 */
export type FreesoundFailure = 'key' | 'throttled' | 'network' | 'http';

export class FreesoundError extends Error {
  readonly code: FreesoundFailure;
  readonly status: number;

  constructor(code: FreesoundFailure, message: string, status = 0) {
    super(message);
    this.name = 'FreesoundError';
    this.code = code;
    this.status = status;
  }
}

/** Which licences a search will admit. */
export type LicenceFilter = 'cc0' | 'any';

/** How long a result may be, as the chips offer it. `null` is "any length". */
export type LengthFilter = number | null;

export interface FreesoundSearchOptions {
  /** The user's own API key, from the field or the keystore. Never read from anywhere else. */
  readonly key: string;
  /** English keywords — what `searchQuery` in `@txt2sfx/agent` produces. */
  readonly query: string;
  readonly licence: LicenceFilter;
  /** Upper bound in seconds, or null. There is no lower bound: a 40 ms click is a valid answer. */
  readonly maxSeconds: LengthFilter;
  readonly pageSize?: number;
  readonly signal?: AbortSignal;
  /** Injected in tests; the browser's `fetch` otherwise. */
  readonly fetchImpl?: typeof fetch;
}

const ENDPOINT = 'https://freesound.org/apiv2/search/text/';

/**
 * Fields asked for, by the API's names.
 *
 * Explicit rather than default because the default response carries a dozen fields
 * this app never reads, including `analysis`, and every one of them is bytes over a
 * connection the user is paying attention to.
 */
const FIELDS = [
  'id',
  'name',
  'url',
  'duration',
  'license',
  'username',
  'tags',
  'channels',
  'samplerate',
  'filesize',
  'avg_rating',
  'num_downloads',
  'previews',
].join(',');

/** Default page size. Enough to rank meaningfully, small enough to scan by eye. */
const PAGE_SIZE = 30;

/**
 * The library's own name for the public-domain licence, spelled as the filter wants it.
 *
 * CC0 is the default because it is the only licence that carries no obligation into
 * whatever the sound ends up in. Everything else is offered, labelled, and comes with
 * an attribution line the user can copy — see {@link attributionFor}.
 */
const CC0_FILTER = 'license:"Creative Commons 0"';

/** Search the library. */
export async function searchFreesound(options: FreesoundSearchOptions): Promise<FreesoundPage> {
  const filters: string[] = [];
  if (options.licence === 'cc0') filters.push(CC0_FILTER);
  /* `[* TO n]` rather than `[0 TO n]`: the library's range syntax takes a wildcard for
     an open end, and a literal 0 would exclude nothing while reading as if it did. */
  if (options.maxSeconds !== null) filters.push(`duration:[* TO ${String(options.maxSeconds)}]`);

  const url = new URL(ENDPOINT);
  url.searchParams.set('query', options.query);
  if (filters.length > 0) url.searchParams.set('filter', filters.join(' '));
  url.searchParams.set('fields', FIELDS);
  url.searchParams.set('page_size', String(options.pageSize ?? PAGE_SIZE));
  /* The library's own relevance, deliberately: our reordering is an opinion applied on
     top of it, so asking for `downloads_desc` here would be ranking twice by two rules
     that disagree. */
  url.searchParams.set('sort', 'score');

  const call = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await call(url.toString(), {
      headers: { Authorization: `Token ${options.key}` },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error: unknown) {
    /* An `AbortError` is the user pressing Stop, not a failure to report. */
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new FreesoundError('network', `freesound.org is unreachable: ${String(error)}`);
  }

  if (!response.ok) {
    const detail = await detailOf(response);
    if (response.status === 401 || response.status === 403) {
      throw new FreesoundError('key', `freesound refused the key (${String(response.status)}): ${detail}`, response.status);
    }
    if (response.status === 429) {
      throw new FreesoundError('throttled', `freesound is throttling this key: ${detail}`, 429);
    }
    throw new FreesoundError('http', `freesound answered ${String(response.status)}: ${detail}`, response.status);
  }

  const body: unknown = await response.json();
  return { count: countOf(body), sounds: soundsOf(body) };
}

/** The library's `detail` line, or the status text, or nothing. */
async function detailOf(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const detail = (body as Record<string, unknown> | null)?.['detail'];
    if (typeof detail === 'string') return detail;
  } catch {
    /* A refusal that is not JSON is still a refusal. */
  }
  return response.statusText;
}

function countOf(body: unknown): number {
  const count = (body as Record<string, unknown> | null)?.['count'];
  return typeof count === 'number' ? count : 0;
}

/**
 * Map the API's rows onto {@link FreesoundSound}, dropping anything unusable.
 *
 * Tolerant on purpose. A field this app does not depend on going missing must not
 * empty a search — the row degrades (no rating, no tags) and still plays. Two things
 * are load-bearing and a row without them is dropped: an id, and a preview, because a
 * result with no preview is a row whose every button is dead.
 */
function soundsOf(body: unknown): readonly FreesoundSound[] {
  const results = (body as Record<string, unknown> | null)?.['results'];
  if (!Array.isArray(results)) return [];

  const out: FreesoundSound[] = [];
  for (const row of results as readonly Record<string, unknown>[]) {
    const id = row['id'];
    if (typeof id !== 'number') continue;

    const previews = row['previews'];
    const preview = typeof previews === 'object' && previews !== null
      ? str((previews as Record<string, unknown>)['preview-hq-mp3']) ||
        str((previews as Record<string, unknown>)['preview-lq-mp3'])
      : '';
    if (preview === '') continue;

    out.push({
      id,
      name: str(row['name']) || `sound ${String(id)}`,
      url: str(row['url']) || `https://freesound.org/s/${String(id)}/`,
      seconds: num(row['duration']),
      license: str(row['license']),
      username: str(row['username']),
      tags: Array.isArray(row['tags']) ? (row['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : [],
      channels: num(row['channels']),
      sampleRate: num(row['samplerate']),
      bytes: num(row['filesize']),
      rating: num(row['avg_rating']),
      downloads: num(row['num_downloads']),
      preview,
    });
  }
  return out;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/* ------------------------------------------------------------------------- *
 * Licences
 * ------------------------------------------------------------------------- */

/** A licence, reduced to what a person has to decide about. */
export type Licence = 'cc0' | 'by' | 'by-nc' | 'sampling+' | 'other';

/**
 * Which licence a URL states.
 *
 * Matched on the path rather than on the whole string because the library has served
 * these over both `http` and `https` and with and without a trailing slash, and a
 * licence badge that reads `other` for a CC0 sound is worse than no badge: it sends
 * someone to read a page they did not need to read.
 */
export function licenceOf(url: string): Licence {
  if (url.includes('publicdomain/zero')) return 'cc0';
  if (url.includes('licenses/by-nc')) return 'by-nc';
  if (url.includes('licenses/by')) return 'by';
  /* The library states this one as `licenses/sampling+/1.0/` — the plus is in the
     path, not an encoded space, and it survives `URL` untouched. */
  if (url.includes('sampling+') || url.includes('samplingplus')) return 'sampling+';
  return 'other';
}

/** Whether using this sound puts an obligation on whoever ships it. */
export function needsAttribution(sound: FreesoundSound): boolean {
  return licenceOf(sound.license) !== 'cc0';
}

/**
 * The credit line for a sound, ready to paste into a credits file.
 *
 * Built here rather than in the panel because it is the one string in this feature
 * with a legal meaning, and it has to say the four things a CC-BY notice needs: what,
 * by whom, from where, under which licence. Given for CC0 too — it carries no
 * obligation, but a credits file that lists everything is how a team keeps track of
 * what it did not have to credit.
 */
export function attributionFor(sound: FreesoundSound): string {
  const who = sound.username === '' ? 'unknown' : sound.username;
  const licence = sound.license === '' ? 'see the sound page' : sound.license;
  return `"${sound.name}" by ${who} — ${sound.url} — ${licence}`;
}

/* ------------------------------------------------------------------------- *
 * Fetching one preview
 * ------------------------------------------------------------------------- */

/**
 * Fetch a preview as a `File`, named after the sound.
 *
 * A `File` rather than an `ArrayBuffer` because that is what the reference path
 * already takes — `loadReference(file)` decodes it, names the B side after it and
 * reports a decode failure the same way it does for a file someone dropped. One less
 * road to the same place.
 *
 * The extension is `.mp3` because that is what the preview is; naming it after the
 * original's format would be the same class of lie as a renamed WAV.
 */
export async function fetchPreview(
  sound: FreesoundSound,
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {},
): Promise<File> {
  const call = options.fetchImpl ?? fetch;
  const response = await call(sound.preview, options.signal === undefined ? {} : { signal: options.signal });
  if (!response.ok) {
    throw new FreesoundError('http', `preview for ${String(sound.id)} answered ${String(response.status)}`, response.status);
  }
  const blob = await response.blob();
  return new File([blob], `${safeName(sound.name)}.mp3`, { type: 'audio/mpeg' });
}

/** A library name reduced to something a filesystem accepts, extension dropped. */
export function safeName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, '');
  const clean = base.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '');
  return clean === '' ? 'sound' : clean.slice(0, 60);
}
