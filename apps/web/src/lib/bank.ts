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

import type { Recipe, SoundProfile, ValidationIssue } from '@txt2sfx/shared';
import { httpBank, type FetchLike, type RecipeSource } from '@txt2sfx/agent';

/**
 * Where the bank lives when nothing says otherwise.
 *
 * Loopback, matching the server's own default (`apps/server/src/index.ts`): a
 * recipe bank on a laptop should not be reachable from the office network because
 * someone ran `pnpm dev`.
 */
export const DEFAULT_BANK_URL = 'http://127.0.0.1:8787';

/** What `GET /api/health` answers. */
export interface BankHealth {
  readonly recipes: number;
  /** Version of the grammar the bank accepts, e.g. `soundline/v0`. */
  readonly grammar: string;
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

/** Everything the playground asks of a bank. */
export interface BankClient {
  readonly baseUrl: string;
  /** `null` when the bank cannot be reached — an expected answer, not a failure. */
  health(): Promise<BankHealth | null>;
  /** Newest-first listing for the gallery. Empty when the bank is unreachable. */
  list(limit?: number): Promise<readonly Recipe[]>;
  /** @throws {@link BankError} when the bank refuses the recipe. */
  publish(input: PublishInput): Promise<PublishResult>;
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

/**
 * A client for one bank origin.
 *
 * @param baseUrl - Origin, e.g. `http://127.0.0.1:8787`. A trailing slash is fine.
 * @param options - `fetch` is injectable so tests never touch a network.
 */
export function bankClient(baseUrl: string, options: { fetch?: FetchLike } = {}): BankClient {
  const origin = baseUrl.trim().replace(/\/+$/, '');
  const call: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  return {
    baseUrl: origin,

    async health(): Promise<BankHealth | null> {
      try {
        const response = await call(`${origin}/api/health`, { method: 'GET' });
        if (!response.ok) return null;
        const body = (await response.json()) as { recipes?: unknown; grammar?: unknown };
        return {
          recipes: typeof body.recipes === 'number' ? body.recipes : 0,
          grammar: typeof body.grammar === 'string' ? body.grammar : 'unknown',
        };
      } catch {
        return null;
      }
    },

    async list(limit = LIST_LIMIT): Promise<readonly Recipe[]> {
      try {
        const response = await call(`${origin}/api/recipes?limit=${String(limit)}`, { method: 'GET' });
        if (!response.ok) return [];
        const body = (await response.json()) as { recipes?: unknown };
        return Array.isArray(body.recipes) ? body.recipes.filter(isRecipe) : [];
      } catch {
        return [];
      }
    },

    async publish(input: PublishInput): Promise<PublishResult> {
      let response: Response;
      try {
        response = await call(`${origin}/api/recipes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
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

    /* The agent package already owns retrieval, including the `fallback` flag and
       the decision to answer with nothing when the bank is down. Re-implementing
       it here would be a second copy that eventually disagrees. */
    recipes: httpBank(origin, options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
}
