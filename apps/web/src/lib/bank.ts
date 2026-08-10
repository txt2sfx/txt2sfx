/**
 * The recipe bank, over HTTP.
 *
 * The gallery reads from two places and the difference matters, so both are kept
 * rather than one replacing the other:
 *
 * - **`examples/`** is the repository's reference set. Under `vite dev` it is
 *   writable (`lib/examples.ts`), which is how a recipe gets *authored*.
 * - **the bank** is the shared, searchable store the agent draws few-shot examples
 *   from and the place a solved sound is *published* to.
 *
 * A bank that is not running is a normal state, not an error: every read here
 * answers with "nothing" instead of rejecting, and the sidebar says the bank is
 * offline. A playground that shows an empty gallery because a fetch failed would
 * be worse than one showing the bundled examples.
 *
 * Writes are the exception. `POST /api/recipes` can reject a recipe for reasons
 * the author can act on — a broken invariant, a missing profile — and every one of
 * those messages was written to be read (see `routes/recipes.ts`). Swallowing them
 * would turn "your `laser` is 40 ms too long" into "save failed".
 *
 * @packageDocumentation
 */

import type { Author, Recipe, RecipeComment, SoundProfile, ValidationIssue } from '@txt2sfx/shared';
import { httpBank, type FetchLike, type RecipeSource } from '@txt2sfx/agent';

/**
 * Where the bank lives when nothing says otherwise.
 *
 * Two answers, and the difference is the whole deployment story. A **development**
 * page talks to loopback, matching the server's own default: a recipe bank on a
 * laptop should not be reachable from the office network because someone ran
 * `pnpm dev`. The **published** page talks to the public bank, because it is a
 * static site with nowhere else to ask — there is no origin behind it to proxy
 * through, which is also why the API is a separate host with CORS wide open.
 *
 * A bank that is not running stays a normal state in both cases: the gallery falls
 * back to its bundled snapshot and says the bank is offline.
 */
export const PUBLIC_BANK_URL = 'https://txt2sfx.pix3.dev';
export const DEFAULT_BANK_URL = import.meta.env.PROD ? PUBLIC_BANK_URL : 'http://127.0.0.1:8787';

/** What `GET /api/health` answers. */
export interface BankHealth {
  readonly recipes: number;
  /** Version of the grammar the bank accepts, e.g. `soundline/v0`. */
  readonly grammar: string;
  /** `github` when writing needs an account, `solo` for a personal bank. */
  readonly auth: 'github' | 'solo';
}

/** What `GET /api/auth/config` answers: whether to draw a sign-in button at all. */
export interface BankAuthConfig {
  readonly mode: 'github' | 'solo';
  readonly signInPath?: string;
  /** How old a provider account must be. Shown *before* the round trip, not after. */
  readonly minAccountAgeDays?: number;
}

/** Who the page is signed in as, and how much it may still write today. */
export interface BankAccount {
  readonly actor: Author;
  /** Likes this account's recipes have collected — what the allowance grows with. */
  readonly standing: number;
  readonly allowances: Readonly<Record<string, { remaining: number; burst: number; perHour: number }>>;
}

/** A listing, plus which of it this viewer has already liked. */
export interface BankListing {
  readonly recipes: readonly Recipe[];
  readonly liked: ReadonlySet<number>;
}

/** A recipe on its way into the bank. */
export interface PublishInput {
  readonly name: string;
  /** The prompt this recipe answers — what retrieval will match against. */
  readonly prompt: string;
  readonly soundline: string;
  /** Measured here, because the server has no audio stack. */
  readonly profile: SoundProfile;
  readonly tags?: readonly string[];
}

/** What a successful publish reports. */
export interface PublishResult {
  readonly recipe: Recipe;
  /** False when an identical (name, soundline) was already stored. */
  readonly created: boolean;
  /** Validator warnings that did not block the write. */
  readonly warnings: readonly ValidationIssue[];
}

/** A rejected publish, carrying the server's own words. */
export class BankError extends Error {
  /** Machine-readable code from the server, e.g. `invalid-soundline`. */
  readonly code: string;
  readonly issues: readonly ValidationIssue[];

  constructor(code: string, message: string, issues: readonly ValidationIssue[] = []) {
    super(message);
    this.name = 'BankError';
    this.code = code;
    this.issues = issues;
  }
}

/**
 * What a listing is narrowed by.
 *
 * The gallery's search box and its category chips, which the server answers rather than
 * the page: `q` goes to the FTS5 index over prompts and tags — text the browser does not
 * have, because a listing carries a hundred recipes and the bank holds all of them.
 * Every field is optional and an absent one is left out of the query string entirely, so
 * an unfiltered listing is byte-for-byte the request it always was.
 */
export interface BankQuery {
  /** Free text. Matched by the server against name, prompt and tags. */
  readonly q?: string;
  /** One of `SOUND_CATEGORIES`. The server answers 400 for anything else. */
  readonly category?: string;
  readonly limit?: number;
}

/** Everything the playground asks of a bank. */
export interface BankClient {
  readonly baseUrl: string;
  /** `null` when the bank cannot be reached — an expected answer, not a failure. */
  health(): Promise<BankHealth | null>;
  /** `null` when the bank cannot be reached. */
  authConfig(): Promise<BankAuthConfig | null>;
  /** Newest-first listing for the gallery. Empty when the bank is unreachable. */
  list(query?: BankQuery): Promise<BankListing>;
  /**
   * One recipe, by id. `null` when it is gone, hidden, or the bank cannot be reached
   * — the caller is a link somebody followed, and three different ways of arriving at
   * an empty playground do not need three different apologies.
   */
  get(id: number, options?: { readonly via?: string }): Promise<Recipe | null>;
  /** @throws {@link BankError} when the bank refuses the recipe. */
  publish(input: PublishInput): Promise<PublishResult>;
  /** Like or unlike. Idempotent both ways. @throws {@link BankError} */
  setLiked(id: number, liked: boolean): Promise<{ rating: number; liked: boolean }>;
  /** A recipe's thread. Empty when the bank is unreachable — comments are not load-bearing. */
  comments(id: number): Promise<readonly RecipeComment[]>;
  /** @throws {@link BankError} carrying the rule that refused it. */
  comment(id: number, body: string, soundline?: string): Promise<RecipeComment>;
  /** Where to send the browser to sign in, coming back to `returnTo`. */
  signInUrl(returnTo: string): string;
  /** Trade a one-time hand-off code for a session. @throws {@link BankError} */
  exchange(code: string): Promise<{ token: string } & BankAccount>;
  /** `null` when there is no session, it expired, or the bank is unreachable. */
  me(): Promise<BankAccount | null>;
  signOut(): Promise<void>;
  /** Few-shot retrieval, for the agent loop. */
  readonly recipes: RecipeSource;
}

/** How many recipes the gallery asks for. The server caps this anyway. */
const LIST_LIMIT = 100;

/** Shape of an error body from the bank. Fields are checked, not trusted. */
interface ErrorBody {
  readonly error?: unknown;
  readonly message?: unknown;
  readonly issues?: unknown;
}

function isRecipe(value: unknown): value is Recipe {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['name'] === 'string' &&
    typeof candidate['soundline'] === 'string' &&
    typeof candidate['id'] === 'number'
  );
}

/** Read the server's explanation, or say plainly that there wasn't one. */
async function bankError(response: Response): Promise<BankError> {
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  const code = typeof body.error === 'string' ? body.error : `http-${String(response.status)}`;
  const message =
    typeof body.message === 'string'
      ? body.message
      : `the bank answered ${String(response.status)} with no explanation`;
  const issues = Array.isArray(body.issues) ? (body.issues as readonly ValidationIssue[]) : [];
  return new BankError(code, message, issues);
}

/** Options of {@link bankClient}. */
export interface BankClientOptions {
  /** Injectable so tests never touch a network. */
  readonly fetch?: FetchLike;
  /**
   * The session token, read at call time.
   *
   * A getter rather than a value because the client is memoized for the lifetime of
   * the tab while the token changes with every sign-in and sign-out — passing the
   * value would rebuild the client, and every effect keyed on it, on each change.
   *
   * The token travels only in an `Authorization` header, never as a cookie: the
   * browser then cannot attach it to a request some other page made, which is what
   * lets this API keep CORS wide open for the agents it exists to serve.
   */
  readonly token?: () => string | null;
}

/**
 * A client for one bank origin.
 *
 * @param baseUrl - Origin, e.g. `http://127.0.0.1:8787`. A trailing slash is fine.
 */
export function bankClient(baseUrl: string, options: BankClientOptions = {}): BankClient {
  const origin = baseUrl.trim().replace(/\/+$/, '');
  const call: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  /** Headers for a write: JSON, plus the session when there is one. */
  const authorized = (extra: Record<string, string> = {}): Record<string, string> => {
    const token = options.token?.() ?? null;
    return { ...extra, ...(token === null || token === '' ? {} : { authorization: `Bearer ${token}` }) };
  };

  return {
    baseUrl: origin,

    async health(): Promise<BankHealth | null> {
      try {
        const response = await call(`${origin}/api/health`, { method: 'GET' });
        if (!response.ok) return null;
        const body = (await response.json()) as { recipes?: unknown; grammar?: unknown; auth?: unknown };
        return {
          recipes: typeof body.recipes === 'number' ? body.recipes : 0,
          grammar: typeof body.grammar === 'string' ? body.grammar : 'unknown',
          auth: body.auth === 'github' ? 'github' : 'solo',
        };
      } catch {
        return null;
      }
    },

    async authConfig(): Promise<BankAuthConfig | null> {
      try {
        const response = await call(`${origin}/api/auth/config`, { method: 'GET' });
        if (!response.ok) return null;
        const body = (await response.json()) as { mode?: unknown; signInPath?: unknown; minAccountAgeDays?: unknown };
        return {
          mode: body.mode === 'github' ? 'github' : 'solo',
          ...(typeof body.signInPath === 'string' ? { signInPath: body.signInPath } : {}),
          ...(typeof body.minAccountAgeDays === 'number' ? { minAccountAgeDays: body.minAccountAgeDays } : {}),
        };
      } catch {
        return null;
      }
    },

    async list(query: BankQuery = {}): Promise<BankListing> {
      try {
        /* Built with `URLSearchParams` rather than by concatenation because `q` is a
           sentence somebody typed: an unescaped `&` in "cats & dogs" would silently
           become a second parameter, and an unescaped `+` a space. Empty and absent
           fields are dropped, so the plain listing sends exactly `?limit=`. */
        const params = new URLSearchParams({ limit: String(query.limit ?? LIST_LIMIT) });
        if (query.q !== undefined && query.q.trim() !== '') params.set('q', query.q.trim());
        if (query.category !== undefined && query.category !== '') params.set('category', query.category);

        /* Signed in or not, this is one request: the answer carries which of the
           listed recipes this account has liked. A heart per card that fills in half
           a second after the grid settles reads as a bug, and a hundred requests to
           avoid that reads as one. */
        const response = await call(`${origin}/api/recipes?${params.toString()}`, {
          method: 'GET',
          headers: authorized(),
        });
        if (!response.ok) return EMPTY_LISTING;
        const body = (await response.json()) as { recipes?: unknown; liked?: unknown };
        return {
          recipes: Array.isArray(body.recipes) ? body.recipes.filter(isRecipe) : [],
          liked: new Set(Array.isArray(body.liked) ? body.liked.filter((id): id is number => typeof id === 'number') : []),
        };
      } catch {
        return EMPTY_LISTING;
      }
    },

    async get(id: number, options: { readonly via?: string } = {}): Promise<Recipe | null> {
      try {
        /* `via` is a marker, not a parameter: the server reads named keys and ignores
           the rest, so it changes no answer and costs no server code. It exists to put
           one word in the access log — this recipe was opened from a link a chat handed
           somebody — because that is the only number that says whether that door is
           used, and it is worth knowing before building anything else for it. */
        const query = options.via === undefined || options.via === '' ? '' : `?via=${encodeURIComponent(options.via)}`;
        const response = await call(`${origin}/api/recipes/${String(id)}${query}`, {
          method: 'GET',
          headers: authorized(),
        });
        if (!response.ok) return null;
        const body: unknown = await response.json();
        return isRecipe(body) ? body : null;
      } catch {
        return null;
      }
    },

    async publish(input: PublishInput): Promise<PublishResult> {
      let response: Response;
      try {
        response = await call(`${origin}/api/recipes`, {
          method: 'POST',
          headers: authorized({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            name: input.name,
            prompt: input.prompt,
            soundline: input.soundline,
            profile: input.profile,
            tags: input.tags ?? [],
          }),
        });
      } catch (error) {
        throw new BankError(
          'unreachable',
          `no bank at ${origin} — start it with \`pnpm --filter @txt2sfx/server dev\` (${String(error)})`,
        );
      }

      if (!response.ok) throw await bankError(response);

      const body = (await response.json()) as { recipe?: unknown; created?: unknown; warnings?: unknown };
      if (!isRecipe(body.recipe)) {
        throw new BankError('bad-response', 'the bank accepted the recipe but answered with something else');
      }
      return {
        recipe: body.recipe,
        created: body.created !== false,
        warnings: Array.isArray(body.warnings) ? (body.warnings as readonly ValidationIssue[]) : [],
      };
    },

    async setLiked(id: number, liked: boolean): Promise<{ rating: number; liked: boolean }> {
      const response = await callOrExplain(`${origin}/api/recipes/${String(id)}/like`, {
        method: liked ? 'PUT' : 'DELETE',
        headers: authorized(),
      });
      const body = (await response.json()) as { rating?: unknown; liked?: unknown };
      return {
        rating: typeof body.rating === 'number' ? body.rating : 0,
        liked: body.liked === true,
      };
    },

    async comments(id: number): Promise<readonly RecipeComment[]> {
      try {
        const response = await call(`${origin}/api/recipes/${String(id)}/comments`, { method: 'GET' });
        if (!response.ok) return [];
        const body = (await response.json()) as { comments?: unknown };
        return Array.isArray(body.comments) ? (body.comments as RecipeComment[]) : [];
      } catch {
        return [];
      }
    },

    async comment(id: number, body: string, soundline?: string): Promise<RecipeComment> {
      const response = await callOrExplain(`${origin}/api/recipes/${String(id)}/comments`, {
        method: 'POST',
        headers: authorized({ 'content-type': 'application/json' }),
        body: JSON.stringify({ body, ...(soundline === undefined ? {} : { soundline }) }),
      });
      return ((await response.json()) as { comment: RecipeComment }).comment;
    },

    signInUrl(returnTo: string): string {
      return `${origin}/api/auth/github/start?return=${encodeURIComponent(returnTo)}`;
    },

    async exchange(code: string): Promise<{ token: string } & BankAccount> {
      const response = await callOrExplain(`${origin}/api/auth/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      return (await response.json()) as { token: string } & BankAccount;
    },

    async me(): Promise<BankAccount | null> {
      const token = options.token?.() ?? null;
      if (token === null || token === '') return null;
      try {
        const response = await call(`${origin}/api/auth/me`, { method: 'GET', headers: authorized() });
        if (!response.ok) return null;
        return (await response.json()) as BankAccount;
      } catch {
        return null;
      }
    },

    async signOut(): Promise<void> {
      /* Best effort. The page forgets the token either way — a sign-out that fails
         because the network is down must not leave someone signed in. */
      try {
        await call(`${origin}/api/auth/signout`, { method: 'POST', headers: authorized() });
      } catch {
        /* ignore */
      }
    },

    /* The agent package already owns retrieval, including the `fallback` flag and
       the decision to answer with nothing when the bank is down. Re-implementing
       it here would be a second copy that eventually disagrees. */
    recipes: httpBank(origin, options.fetch === undefined ? {} : { fetch: options.fetch }),
  };

  /**
   * A request whose failure the caller has to see.
   *
   * Reads answer with "nothing" when the bank is down, because an empty gallery is a
   * survivable state. Writes cannot do that: "you are over your allowance, try again
   * in six minutes" and "your comment contains a link" are the messages that tell
   * somebody what to do, and swallowing them turns both into "it did not work".
   */
  async function callOrExplain(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await call(url, init);
    } catch (error) {
      throw new BankError('unreachable', `no bank at ${origin} (${String(error)})`);
    }
    if (!response.ok) throw await bankError(response);
    return response;
  }
}

/** The answer to a listing nobody could make. Frozen so it cannot be mutated into truth. */
const EMPTY_LISTING: BankListing = { recipes: [], liked: new Set() };
