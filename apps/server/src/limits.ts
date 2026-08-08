/**
 * How much a person may write, and how that allowance is earned.
 *
 * ## Why a bucket and not a counter
 *
 * A counter per calendar day has two failure modes and this has neither: it lets
 * someone spend a whole day's allowance in one second (a flood is exactly that), and
 * it resets on a boundary everyone can see, so the flood happens twice in two
 * minutes at midnight. A token bucket spends at the same rate it refills, which is
 * the property actually wanted — "twenty a day" should mean "not twenty at once".
 *
 * Tokens are stored as a float and refilled continuously from the elapsed time. That
 * is the whole implementation: no timer, no sweep, no background job. A bucket that
 * is never touched again costs one row.
 *
 * ## The allowance is earned, and that is the social design
 *
 * A new account gets few writes. An account whose recipes other people liked gets
 * more, up to a ceiling. This is not gamification: the scarce resource here is
 * attention on a small bank, and the person who has already put something in it that
 * others found worth keeping is exactly the person whose next write should not be
 * rationed. It also makes bulk-account spam pointless twice over — a fresh account is
 * both age-gated and on the smallest allowance, and buying standing means making
 * sounds people like.
 *
 * The formula is deliberately flat and legible rather than tuned. It has never been
 * measured against real traffic, because there is none yet; when there is, the place
 * to change it is {@link allowanceFor} and the reason belongs in the comment.
 *
 * @packageDocumentation
 */

import type { Database } from './schema.js';

/** The kinds of write that are rationed separately. */
export type BucketKind = 'recipe' | 'comment' | 'like' | 'report';

/** A bucket's shape: how many at once, and how fast it refills. */
export interface Allowance {
  /** Most that can be spent back-to-back. */
  readonly burst: number;
  /** Tokens per hour. */
  readonly perHour: number;
}

/**
 * The base allowances, for an account with no standing.
 *
 * Read them as "a good first day": five sounds is more than anyone publishes in one
 * sitting — each one is a generation, a fit and a listen — and twenty comments is
 * more conversation than a bank this size has in a week. They are not meant to be
 * felt by a person acting in good faith, only by a script.
 */
const BASE: Readonly<Record<BucketKind, Allowance>> = {
  recipe: { burst: 5, perHour: 1 },
  comment: { burst: 10, perHour: 3 },
  /* Likes are cheap to give and the honest pattern is bursty — someone opens the
     gallery and works through it — so the burst is large and the refill slow. */
  like: { burst: 60, perHour: 20 },
  /* A report is a request for a human's attention. Someone with a real complaint
     files one or two; someone filing thirty is the problem, not the reporter. */
  report: { burst: 5, perHour: 1 },
};

/**
 * Standing: how many likes this account's recipes have collected.
 *
 * Likes *received*, not given — otherwise the way to earn an allowance would be to
 * press a button sixty times.
 */
export function standingOf(db: Database, actorId: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(rating), 0) AS n FROM recipes WHERE author_id = ? AND hidden = 0')
    .get(actorId) as unknown as { n: number };
  return Number(row.n);
}

/**
 * Allowance for an account at a given standing.
 *
 * Doubling at ten likes and tripling at fifty, and no further. A ceiling matters: an
 * account with standing that later goes bad should not also have the largest
 * megaphone, and the numbers above are already generous for one person.
 */
export function allowanceFor(kind: BucketKind, standing: number): Allowance {
  const base = BASE[kind];
  const multiplier = standing >= 50 ? 3 : standing >= 10 ? 2 : 1;
  return { burst: base.burst * multiplier, perHour: base.perHour * multiplier };
}

/** What happened when a write asked for a token. */
export interface LimitDecision {
  readonly allowed: boolean;
  /** Whole tokens left after this decision. */
  readonly remaining: number;
  /** Seconds until one token is available. Zero when the write was allowed. */
  readonly retryAfterSeconds: number;
}

/** The rate limiter. */
export interface Limiter {
  /** Spend one token, or report how long to wait. */
  spend(actorId: number, kind: BucketKind, now?: Date): LimitDecision;
  /**
   * Put a token back.
   *
   * For writes that turned out not to be writes: publishing a recipe the bank
   * already had is idempotent by fingerprint and stores nothing, so charging for it
   * would let a retry storm eat an honest author's allowance.
   */
  refund(actorId: number, kind: BucketKind, now?: Date): void;
  /** Tokens currently available, without spending one. */
  peek(actorId: number, kind: BucketKind, now?: Date): number;
}

export function limiter(db: Database): Limiter {
  const read = (
    actorId: number,
    kind: BucketKind,
    now: Date,
  ): { tokens: number; allowance: Allowance } => {
    const allowance = allowanceFor(kind, standingOf(db, actorId));
    const row = db.prepare('SELECT tokens, updated_at FROM buckets WHERE actor_id = ? AND bucket = ?').get(
      actorId,
      kind,
    ) as unknown as { tokens: number; updated_at: string } | undefined;

    if (row === undefined) return { tokens: allowance.burst, allowance };

    const elapsedHours = Math.max(0, (now.getTime() - Date.parse(row.updated_at)) / 3_600_000);
    const refilled = Math.min(allowance.burst, Number(row.tokens) + elapsedHours * allowance.perHour);
    return { tokens: refilled, allowance };
  };

  const write = (actorId: number, kind: BucketKind, tokens: number, now: Date): void => {
    db.prepare(
      `INSERT INTO buckets (actor_id, bucket, tokens, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(actor_id, bucket) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
    ).run(actorId, kind, tokens, now.toISOString());
  };

  return {
    spend(actorId: number, kind: BucketKind, now = new Date()): LimitDecision {
      const { tokens, allowance } = read(actorId, kind, now);
      if (tokens < 1) {
        const seconds = Math.ceil(((1 - tokens) / allowance.perHour) * 3600);
        /* Written back even on refusal: otherwise the refill clock keeps running
           from the last *successful* write and a refused caller accrues tokens for
           free while hammering. */
        write(actorId, kind, tokens, now);
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, seconds) };
      }
      const left = tokens - 1;
      write(actorId, kind, left, now);
      return { allowed: true, remaining: Math.floor(left), retryAfterSeconds: 0 };
    },

    refund(actorId: number, kind: BucketKind, now = new Date()): void {
      const { tokens, allowance } = read(actorId, kind, now);
      write(actorId, kind, Math.min(allowance.burst, tokens + 1), now);
    },

    peek(actorId: number, kind: BucketKind, now = new Date()): number {
      return Math.floor(read(actorId, kind, now).tokens);
    },
  };
}
