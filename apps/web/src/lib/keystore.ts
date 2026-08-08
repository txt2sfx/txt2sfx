/**
 * Remembering an API key on this machine, as safely as a browser allows.
 *
 * ## What "secure" can and cannot mean here
 *
 * A page that has to *use* a key must be able to read it, so no browser storage can
 * protect it from code running on this origin. What can be done, and is done here:
 *
 * - **Nothing readable is stored.** The key is encrypted with AES-GCM before it
 *   touches disk. Opening DevTools → Application shows an IV and ciphertext.
 * - **The wrapping key cannot be exported.** It is generated with
 *   `extractable: false` and stored as a live `CryptoKey` in IndexedDB, which is the
 *   one thing browsers *do* keep out of script's reach: the bytes cannot be read
 *   back, only used. Copying the database to another machine yields nothing usable.
 * - **`localStorage` is not involved**, for the reason the project already had a rule
 *   about it: it stores plaintext, is synchronous, and is the first place anything
 *   looks.
 *
 * What this does **not** protect against, stated plainly because a security claim
 * that oversells is worse than none: a script injected into this origin can call
 * {@link Keystore.load} exactly as the app does. If the playground were serving
 * untrusted code, remembering the key would be the wrong choice — which is why every
 * surface that stores one says so in plain text beside the field, and why forgetting is
 * one click from there.
 *
 * ## Injectable storage
 *
 * The crypto and the flow are testable without a browser, so the key-value layer is
 * an interface with an IndexedDB implementation behind it. Tests drive the real
 * WebCrypto against an in-memory map; only the ~30 lines of IndexedDB plumbing go
 * unexercised, and those fail loudly rather than quietly.
 *
 * @packageDocumentation
 */

/** The smallest storage this needs: get, set, delete, by string key. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * What a stored key looks like on disk.
 *
 * `Uint8Array<ArrayBuffer>` rather than plain `Uint8Array`: WebCrypto will not accept
 * a view that might be backed by a `SharedArrayBuffer`, and being specific here is
 * better than casting at the two call sites.
 */
interface Envelope {
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly data: ArrayBuffer;
}

const WRAP_KEY = 'wrapping-key';
const ALGORITHM = 'AES-GCM';
const IV_BYTES = 12;

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate['iv'] instanceof Uint8Array && candidate['data'] instanceof ArrayBuffer;
}

/** Remembering and forgetting keys, one entry per provider. */
export interface Keystore {
  /** Encrypt and store. Overwrites any previous value for this name. */
  save(name: string, secret: string): Promise<void>;
  /** Decrypt, or `null` when nothing is stored (or it no longer decrypts). */
  load(name: string): Promise<string | null>;
  forget(name: string): Promise<void>;
  /** Which names currently have something stored. */
  names(): Promise<readonly string[]>;
}

/** The subset of `crypto` used, so a test can pass Node's implementation. */
export interface CryptoLike {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

/**
 * Build a keystore over a key-value layer.
 *
 * @param store - Where envelopes and the wrapping key live.
 * @param cryptoImpl - Defaults to the platform `crypto`.
 */
export function createKeystore(store: KeyValueStore, cryptoImpl: CryptoLike = globalThis.crypto): Keystore {
  /**
   * Fetch the non-extractable wrapping key, generating it on first use.
   *
   * Stored as a `CryptoKey`, not as bytes — structured clone keeps it a key object,
   * and `extractable: false` means nothing, including this module, can read it back
   * out. That is the whole security argument, so it is not optional.
   */
  const wrappingKey = async (): Promise<CryptoKey> => {
    const existing = await store.get(WRAP_KEY);
    if (existing instanceof CryptoKey) return existing;
    const created = await cryptoImpl.subtle.generateKey({ name: ALGORITHM, length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await store.set(WRAP_KEY, created);
    return created;
  };

  const entry = (name: string): string => `key:${name}`;

  return {
    async save(name, secret) {
      const key = await wrappingKey();
      const iv = cryptoImpl.getRandomValues(new Uint8Array(IV_BYTES));
      const data = await cryptoImpl.subtle.encrypt(
        { name: ALGORITHM, iv },
        key,
        new TextEncoder().encode(secret),
      );
      await store.set(entry(name), { iv, data } satisfies Envelope);
      await store.set('names', await namesWith(name));
    },

    async load(name) {
      const stored = await store.get(entry(name));
      if (!isEnvelope(stored)) return null;
      try {
        const key = await wrappingKey();
        const plain = await cryptoImpl.subtle.decrypt({ name: ALGORITHM, iv: stored.iv }, key, stored.data);
        return new TextDecoder().decode(plain);
      } catch {
        /* A ciphertext that no longer decrypts — the wrapping key was cleared, the
           profile was moved — is indistinguishable from nothing stored, and the only
           useful answer is the same: ask the user for the key again. */
        return null;
      }
    },

    async forget(name) {
      await store.delete(entry(name));
      const kept = (await namesList()).filter((n) => n !== name);
      await store.set('names', kept);
    },

    names: namesList,
  };

  async function namesList(): Promise<readonly string[]> {
    const stored = await store.get('names');
    return Array.isArray(stored) ? stored.filter((n): n is string => typeof n === 'string') : [];
  }

  async function namesWith(name: string): Promise<readonly string[]> {
    const current = await namesList();
    return current.includes(name) ? current : [...current, name];
  }
}

/* ------------------------------------------------------------------------- *
 * IndexedDB
 * ------------------------------------------------------------------------- */

const DB_NAME = 'txt2sfx';
const DB_STORE = 'secrets';

/** Promisify one IndexedDB request. */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Open (and if needed create) the one object store this uses. */
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open IndexedDB'));
  });
}

/**
 * IndexedDB as a {@link KeyValueStore}.
 *
 * IndexedDB rather than `localStorage` for one decisive reason beyond the plaintext
 * problem: it can hold a live `CryptoKey`. `localStorage` stores strings, so the
 * wrapping key would have to be exportable — and an exportable wrapping key stored
 * next to the ciphertext is decoration, not encryption.
 */
export function indexedDbStore(): KeyValueStore {
  const tx = async (mode: IDBTransactionMode): Promise<IDBObjectStore> => {
    const db = await open();
    return db.transaction(DB_STORE, mode).objectStore(DB_STORE);
  };

  return {
    async get(key) {
      return request((await tx('readonly')).get(key)) as Promise<unknown>;
    },
    async set(key, value) {
      await request((await tx('readwrite')).put(value, key));
    },
    async delete(key) {
      await request((await tx('readwrite')).delete(key));
    },
  };
}

/** Whether this browser can remember a key at all. */
export const canRemember: boolean =
  typeof indexedDB !== 'undefined' && typeof globalThis.crypto?.subtle !== 'undefined';

/** The playground's keystore, over IndexedDB. */
export const keystore: Keystore = createKeystore(indexedDbStore());
