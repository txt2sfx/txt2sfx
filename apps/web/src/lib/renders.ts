/**
 * The diffusion renders this browser has kept.
 *
 * ## Why this exists, when the panel's own header says a target is used once
 *
 * Because that was true of a render used as a *reference* and false of everything else
 * people did with it. A render costs thirty to sixty seconds of local CPU and a model
 * call for the caption before it, it is never written to disk by the bridge — it arrives
 * inside the response — and until this file existed, a reload, a screen switch or one more
 * press of Render destroyed it. "Used once" describes the Compare workflow; it does not
 * describe a session where somebody renders eight variants of a door and wants the third.
 *
 * So the renders are kept, and the header's claim is narrowed rather than dropped: nothing
 * is written to `out/` and nothing lands in the user's file system without a Download.
 *
 * ## Why IndexedDB and not `localStorage`
 *
 * `localStorage` holds strings, so audio would go in base64 — a third bigger than the
 * bytes it encodes — inside a ~5 MB per-origin quota that is **shared** with the two
 * things in this app that already depend on it: the unsaved-recipe session
 * (`lib/session.ts`) and the library of stars and edits (`lib/library.ts`). Three MP3s
 * would evict a session of unsaved work, and it would happen silently, because both of
 * those writers swallow their quota errors on purpose. IndexedDB stores the `Blob`
 * itself, has an origin quota measured in hundreds of megabytes, and is already where
 * `lib/keystore.ts` keeps things — so this adds no new kind of storage to the app.
 *
 * The audio is not a credential and not somebody else's file: it is bytes this machine
 * made from a prompt this machine typed. That is what makes keeping it a different
 * question from keeping the reference recording, which still lives in memory and nowhere
 * else.
 *
 * ## The shape of a record
 *
 * Everything the sidebar draws is stored alongside the blob — the title, the duration, the
 * prompt it answers — because the alternative is decoding every kept render on the way to
 * first paint to find out how long it is. The blob is the file the bridge returned, byte
 * for byte, so a Download from the list is a copy rather than a re-encode.
 *
 * Every function here is defensive in the same way `lib/session.ts` is: a store that
 * cannot be opened, a record that no longer matches this shape and a quota that is full
 * are all "there are no kept renders", never an exception on a screen that was drawing
 * something else.
 *
 * @packageDocumentation
 */

/** Where they live. Versioned in the store name, so a shape change is a fresh start. */
const DB_NAME = 'txt2sfx-renders';
const DB_VERSION = 1;
const STORE = 'renders.v1';

/**
 * How many renders are kept, newest first.
 *
 * A two-second MP3 from the bridge is ~40 kB and an eleven-second one ~200 kB, so forty
 * of them is under 8 MB — comfortable against an IndexedDB quota, and past the point
 * anybody scrolls. The cap is about the list, not the disk: a sidebar nobody can reach
 * the bottom of stops being a place to find the third variant of a door.
 */
export const RENDER_LIMIT = 40;

/** One kept render. */
export interface KeptRender {
  /** Stable across renames. Assigned by {@link keepRender}. */
  readonly id: string;
  /** What the list shows. A model wrote it; see `@txt2sfx/agent`'s `audioAssetName`. */
  readonly title: string;
  /** The file-name stem a Download uses, extension excluded. */
  readonly file: string;
  /** The bytes the bridge returned, untouched. */
  readonly blob: Blob;
  /** The extension those bytes actually are — `mp3` for everything the bridge makes. */
  readonly extension: string;
  readonly bytes: number;
  readonly durationMs: number;
  /** The caption that was sent, which on the render screen is also the prompt. */
  readonly prompt: string;
  readonly seed: number;
  /** Epoch milliseconds, for the ordering and for "when did I make this". */
  readonly at: number;
}

/** What {@link keepRender} is given: a record without the parts this module assigns. */
export type NewRender = Omit<KeptRender, 'id' | 'at'>;

/** Open the database, creating the store on first use. */
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('this browser has no IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open'));
  });
}

/** Run one transaction and resolve with whatever the request produced. */
async function transact<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = body(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB refused the request'));
    });
  } finally {
    db.close();
  }
}

/**
 * Whether a value read back is still the shape this version writes.
 *
 * Exported for the test, and separate from the read for the reason `loadSession` gives:
 * one unreadable record left by an older build drops itself rather than taking the whole
 * list — and therefore the whole sidebar — down with it.
 */
export function isKeptRender(value: unknown): value is KeptRender {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    record['id'] !== '' &&
    typeof record['title'] === 'string' &&
    typeof record['file'] === 'string' &&
    record['blob'] instanceof Blob &&
    typeof record['extension'] === 'string' &&
    typeof record['bytes'] === 'number' &&
    typeof record['durationMs'] === 'number' &&
    typeof record['prompt'] === 'string' &&
    typeof record['seed'] === 'number' &&
    typeof record['at'] === 'number'
  );
}

/**
 * Order and cap a list of records, newest first.
 *
 * Pure and exported because it is the only part of this module with a decision in it,
 * and the IndexedDB plumbing around it is what a test cannot reach without a fake
 * database — the same division `lib/keystore.ts` makes for the same reason.
 */
export function newestFirst(records: readonly KeptRender[], limit = RENDER_LIMIT): KeptRender[] {
  return [...records].sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Everything kept, newest first. Never throws: an unopenable store is an empty list. */
export async function listRenders(): Promise<KeptRender[]> {
  try {
    const all = await transact<unknown[]>('readonly', (store) => store.getAll() as IDBRequest<unknown[]>);
    return newestFirst(all.filter(isKeptRender));
  } catch {
    return [];
  }
}

/**
 * Keep one render, evicting the oldest past {@link RENDER_LIMIT}.
 *
 * @returns The stored record, or null when nothing could be stored — a full quota, a
 *   private window with IndexedDB disabled. Null rather than a throw because the render
 *   itself is fine and on screen; only the keeping failed, and the screen says so by the
 *   row simply not appearing.
 */
export async function keepRender(entry: NewRender): Promise<KeptRender | null> {
  const record: KeptRender = { ...entry, id: newId(), at: Date.now() };
  try {
    await transact('readwrite', (store) => store.put(record));
    await evict();
    return record;
  } catch {
    return null;
  }
}

/** Rename one — the model's title arrives after the render it names. Silent on failure. */
export async function renameRender(id: string, title: string, file: string): Promise<void> {
  try {
    const existing = await transact<unknown>('readonly', (store) => store.get(id) as IDBRequest<unknown>);
    if (!isKeptRender(existing)) return;
    await transact('readwrite', (store) => store.put({ ...existing, title, file }));
  } catch {
    /* A row keeps the name it already has. Nothing else is affected. */
  }
}

/** Forget one. Silent on failure, for the same reason. */
export async function forgetRender(id: string): Promise<void> {
  try {
    await transact('readwrite', (store) => store.delete(id));
  } catch {
    /* Nothing to do and nothing worth saying. */
  }
}

/** Drop everything past the cap, oldest first. */
async function evict(): Promise<void> {
  const all = await transact<unknown[]>('readonly', (store) => store.getAll() as IDBRequest<unknown[]>);
  const kept = all.filter(isKeptRender);
  if (kept.length <= RENDER_LIMIT) return;
  const doomed = newestFirst(kept, kept.length).slice(RENDER_LIMIT);
  for (const record of doomed) await forgetRender(record.id);
}

/**
 * A key for a new record.
 *
 * `randomUUID` where it exists — every browser that ships `OfflineAudioContext` in a
 * secure context has it — and a timestamped random otherwise, because a page served over
 * plain HTTP on a LAN address is a real way this app gets opened and a missing id would
 * make the whole sidebar unusable there.
 */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}
