/**
 * Likes, comments, reports — the part of the bank that is about people.
 *
 * ## A like is a vote in the retrieval ranking
 *
 * `recipes.rating` is not a display counter. Retrieval orders by it, few-shot
 * selection prefers it, and both are what someone else's model sees when it asks the
 * bank what a good recipe looks like. So a like is the community pointing the next
 * generation at better examples, and that is the reason it is worth defending with
 * an account and a rate limit rather than left as an anonymous number.
 *
 * The rows in `likes` are the truth and `rating` is derived from them, recomputed
 * inside the same transaction as every change. A counter incremented in place
 * eventually disagrees with reality — a delete here, a ban there — and nothing ever
 * notices.
 *
 * ## Comments carry no links, and that is the whole comment-spam defence
 *
 * Comment spam is an economic activity and the payload is always a link. Refusing
 * links removes the payoff completely, and costs almost nothing: the only thing
 * anyone here needs to point at is another recipe, and `#12` does that better than a
 * URL because the playground can render it as something you can press and hear.
 *
 * It is stated as a refusal with a reason rather than a silent strip. Text that
 * quietly loses part of itself is worse than text that was not accepted: the author
 * cannot tell what happened, and neither can anyone reading the result.
 *
 * ## A comment may be a sound
 *
 * `soundline` is optional, and when it is there it has already been parsed,
 * validated and rendered by the route — the same treatment a published recipe gets.
 * It is stored here rather than in `recipes` on purpose: a counter-proposal is not a
 * bank entry. It must not be retrieved as few-shot material, and it must not compete
 * for the unique fingerprint that keeps the bank free of duplicates.
 *
 * @packageDocumentation
 */

import type { Author, RecipeComment } from '@txt2sfx/shared';
import type { Database } from './schema.js';

/* ------------------------------------------------------------------------- *
 * Comment text
 * ------------------------------------------------------------------------- */

/** Longest comment. Long enough for a paragraph of critique, short enough to read. */
export const MAX_COMMENT_CHARS = 500;

/**
 * Hosts and schemes that make a comment a delivery vehicle.
 *
 * Three patterns rather than one clever one, because each has a different false
 * positive to avoid. `://` and a leading `www.` are unambiguous. A bare domain is
 * only treated as a link when its suffix is one of the ones people actually use to
 * sell things — otherwise `sword-clash.wav`, `attack.ms` and `e.g.` would all be
 * refused, and a rule that refuses ordinary sentences gets removed within a week.
 */
const LINK_PATTERNS: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /(^|\s)www\.[a-z0-9-]/i,
  /\b[a-z0-9][a-z0-9-]*\.(com|net|org|io|dev|ru|xyz|top|shop|info|biz|link|click|site|online|store|app)\b/i,
];

/** Why a comment was refused, phrased as something the author can act on. */
export interface CommentRejection {
  readonly rule: string;
  readonly message: string;
}

/**
 * Check a comment body against the rules, before anything is stored.
 *
 * Returns `null` when the text is fine. Pure and exported so the rules can be tested
 * without a database and stated once — the route only reports what this decides.
 *
 * @param body - As written.
 * @param hasSound - Whether the comment carries a soundline. An empty body is fine
 *   then: "here, listen" is a complete thought when the sound is attached.
 */
export function checkComment(body: string, hasSound: boolean): CommentRejection | null {
  const text = body.trim();
  if (text === '' && !hasSound) {
    return {
      rule: 'comment.empty',
      message: 'Write something, or attach a soundline — an empty comment is not a reply.',
    };
  }
  if (text.length > MAX_COMMENT_CHARS) {
    return {
      rule: 'comment.too-long',
      message: `A comment is at most ${String(MAX_COMMENT_CHARS)} characters; this one is ${String(text.length)}. If it needs more room, it probably wants to be a recipe.`,
    };
  }
  if (LINK_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      rule: 'comment.no-links',
      message:
        'Comments cannot contain links. Refer to another recipe by its id — "#12" — and the playground will turn it into something you can hear.',
    };
  }
  return null;
}

/** The body as it will be stored: trimmed, with line endings normalized. */
export function normalizeComment(body: string): string {
  return body.replace(/\r\n/g, '\n').trim();
}

/* ------------------------------------------------------------------------- *
 * Rows
 * ------------------------------------------------------------------------- */

interface CommentRow {
  readonly id: number;
  readonly recipe_id: number;
  readonly actor_id: number;
  readonly body: string;
  readonly soundline: string | null;
  readonly hidden: number;
  readonly created_at: string;
  readonly login: string;
  readonly avatar_url: string;
}

function toComment(row: CommentRow): RecipeComment {
  const author: Author = { id: row.actor_id, login: row.login, avatarUrl: row.avatar_url };
  return {
    id: row.id,
    recipeId: row.recipe_id,
    author,
    body: row.body,
    createdAt: row.created_at,
    ...(row.soundline === null || row.soundline === '' ? {} : { soundline: row.soundline }),
  };
}

/* ------------------------------------------------------------------------- *
 * Store
 * ------------------------------------------------------------------------- */

/** What a report is filed against. */
export type ReportTarget = 'recipe' | 'comment';

/** Likes, comments and reports over one database. */
export interface SocialStore {
  /** Idempotent. Returns the recipe's like count afterwards. */
  like(recipeId: number, actorId: number): number;
  /** Idempotent. Returns the recipe's like count afterwards. */
  unlike(recipeId: number, actorId: number): number;
  /** Whether this actor has liked this recipe. */
  hasLiked(recipeId: number, actorId: number): boolean;
  /** Which of these recipes this actor has liked. For rendering a gallery at once. */
  likedAmong(actorId: number, recipeIds: readonly number[]): Set<number>;
  /** Recompute `recipes.rating` from the rows. Returns the count. */
  recount(recipeId: number): number;

  addComment(input: {
    recipeId: number;
    actorId: number;
    body: string;
    soundline?: string;
  }): RecipeComment;
  comments(recipeId: number, limit?: number): RecipeComment[];
  getComment(id: number): RecipeComment | undefined;
  setCommentHidden(id: number, hidden: boolean): boolean;
  /** How many comments this actor has written, ever. For moderation display. */
  commentCount(actorId: number): number;

  /** Idempotent per (target, actor). Returns how many distinct people reported it. */
  report(target: ReportTarget, targetId: number, actorId: number, reason: string): number;
  /** Everything reported and not yet hidden, most-reported first. */
  openReports(limit?: number): ReportSummary[];
}

/** A reported thing, with the reasons people gave. */
export interface ReportSummary {
  readonly target: ReportTarget;
  readonly targetId: number;
  readonly count: number;
  readonly reasons: readonly string[];
  readonly lastAt: string;
}

/** Default page of comments. A thread longer than this wants its own screen. */
export const COMMENT_PAGE = 50;

export function socialStore(db: Database): SocialStore {
  const SELECT_COMMENT = `
    SELECT comments.*, actors.login AS login, actors.avatar_url AS avatar_url
    FROM comments JOIN actors ON actors.id = comments.actor_id
  `;

  const recount = (recipeId: number): number => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE recipe_id = ?').get(recipeId) as unknown as {
      n: number;
    };
    const count = Number(row.n);
    db.prepare('UPDATE recipes SET rating = ? WHERE id = ?').run(count, recipeId);
    return count;
  };

  /* One transaction per change, so `likes` and `rating` cannot be observed
     disagreeing — the read that would see it is the one right behind the write. */
  const inTransaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    like(recipeId: number, actorId: number): number {
      return inTransaction(() => {
        db.prepare('INSERT OR IGNORE INTO likes (recipe_id, actor_id, created_at) VALUES (?, ?, ?)').run(
          recipeId,
          actorId,
          new Date().toISOString(),
        );
        return recount(recipeId);
      });
    },

    unlike(recipeId: number, actorId: number): number {
      return inTransaction(() => {
        db.prepare('DELETE FROM likes WHERE recipe_id = ? AND actor_id = ?').run(recipeId, actorId);
        return recount(recipeId);
      });
    },

    hasLiked(recipeId: number, actorId: number): boolean {
      return (
        db.prepare('SELECT 1 AS found FROM likes WHERE recipe_id = ? AND actor_id = ?').get(recipeId, actorId) !==
        undefined
      );
    },

    likedAmong(actorId: number, recipeIds: readonly number[]): Set<number> {
      if (recipeIds.length === 0) return new Set();
      /* The ids are numbers this server produced and re-checked as integers at the
         boundary, but they are still interpolated only as placeholders — the values
         are bound. A prepared statement cannot take a list any other way. */
      const holes = recipeIds.map(() => '?').join(', ');
      const rows = db
        .prepare(`SELECT recipe_id FROM likes WHERE actor_id = ? AND recipe_id IN (${holes})`)
        .all(actorId, ...recipeIds) as unknown as { recipe_id: number }[];
      return new Set(rows.map((row) => Number(row.recipe_id)));
    },

    recount,

    addComment(input): RecipeComment {
      const result = db
        .prepare(
          `INSERT INTO comments (recipe_id, actor_id, body, soundline, hidden, created_at)
           VALUES (?, ?, ?, ?, 0, ?)`,
        )
        .run(
          input.recipeId,
          input.actorId,
          normalizeComment(input.body),
          input.soundline ?? null,
          new Date().toISOString(),
        );
      const row = db.prepare(`${SELECT_COMMENT} WHERE comments.id = ?`).get(Number(result.lastInsertRowid)) as
        | unknown
        | undefined;
      if (row === undefined) throw new Error('insert lost a comment');
      return toComment(row as CommentRow);
    },

    comments(recipeId: number, limit = COMMENT_PAGE): RecipeComment[] {
      const rows = db
        .prepare(`${SELECT_COMMENT} WHERE comments.recipe_id = ? AND comments.hidden = 0 ORDER BY comments.id LIMIT ?`)
        .all(recipeId, Math.max(1, Math.min(COMMENT_PAGE, Math.trunc(limit)))) as unknown as CommentRow[];
      return rows.map(toComment);
    },

    getComment(id: number): RecipeComment | undefined {
      const row = db.prepare(`${SELECT_COMMENT} WHERE comments.id = ?`).get(id) as unknown | undefined;
      return row === undefined ? undefined : toComment(row as CommentRow);
    },

    setCommentHidden(id: number, hidden: boolean): boolean {
      return db.prepare('UPDATE comments SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id).changes > 0;
    },

    commentCount(actorId: number): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE actor_id = ?').get(actorId) as unknown as {
        n: number;
      };
      return Number(row.n);
    },

    report(target: ReportTarget, targetId: number, actorId: number, reason: string): number {
      db.prepare(
        `INSERT INTO reports (target_kind, target_id, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(target_kind, target_id, actor_id) DO UPDATE SET reason = excluded.reason`,
      ).run(target, targetId, actorId, reason.slice(0, MAX_COMMENT_CHARS), new Date().toISOString());
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM reports WHERE target_kind = ? AND target_id = ?')
        .get(target, targetId) as unknown as { n: number };
      return Number(row.n);
    },

    openReports(limit = 50): ReportSummary[] {
      const rows = db
        .prepare(
          `SELECT target_kind, target_id, COUNT(*) AS n, MAX(created_at) AS last_at,
                  GROUP_CONCAT(reason, ' | ') AS reasons
           FROM reports
           GROUP BY target_kind, target_id
           ORDER BY n DESC, last_at DESC
           LIMIT ?`,
        )
        .all(Math.max(1, Math.trunc(limit))) as unknown as {
        target_kind: string;
        target_id: number;
        n: number;
        last_at: string;
        reasons: string | null;
      }[];
      return rows.map((row) => ({
        target: row.target_kind as ReportTarget,
        targetId: Number(row.target_id),
        count: Number(row.n),
        reasons: (row.reasons ?? '').split(' | ').filter((reason) => reason !== ''),
        lastAt: row.last_at,
      }));
    },
  };
}
