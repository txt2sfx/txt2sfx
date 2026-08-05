/**
 * Remembering a key.
 *
 * Real WebCrypto against an in-memory key-value store, so the flow and the crypto are
 * exercised without a browser; only the IndexedDB adapter is left untested, and it is
 * thirty lines that fail loudly.
 *
 * The property that carries the security claim is the last test: what lands in storage
 * must not contain the secret, and the wrapping key must refuse to be exported.
 */

import { describe, expect, it } from 'vitest';
import { createKeystore, type KeyValueStore } from '../src/lib/keystore.js';

/** The smallest possible store. Values are kept as-is, like structured clone would. */
function memoryStore(): KeyValueStore & { dump(): Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    get: (key) => Promise.resolve(map.get(key)),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
    dump: () => map,
  };
}

describe('keystore', () => {
  it('round-trips a secret', async () => {
    const keystore = createKeystore(memoryStore());
    await keystore.save('gemini', 'AIza-secret-key');
    await expect(keystore.load('gemini')).resolves.toBe('AIza-secret-key');
  });

  it('answers null for a name it has never seen', async () => {
    await expect(createKeystore(memoryStore()).load('anthropic')).resolves.toBeNull();
  });

  it('keeps providers apart', async () => {
    const keystore = createKeystore(memoryStore());
    await keystore.save('gemini', 'g-key');
    await keystore.save('anthropic', 'a-key');
    await expect(keystore.load('gemini')).resolves.toBe('g-key');
    await expect(keystore.load('anthropic')).resolves.toBe('a-key');
    expect(await keystore.names()).toEqual(['gemini', 'anthropic']);
  });

  it('overwrites rather than accumulating', async () => {
    const keystore = createKeystore(memoryStore());
    await keystore.save('gemini', 'first');
    await keystore.save('gemini', 'second');
    await expect(keystore.load('gemini')).resolves.toBe('second');
    expect(await keystore.names()).toEqual(['gemini']);
  });

  it('forgets on request, and says so', async () => {
    const keystore = createKeystore(memoryStore());
    await keystore.save('gemini', 'secret');
    await keystore.forget('gemini');
    await expect(keystore.load('gemini')).resolves.toBeNull();
    expect(await keystore.names()).toEqual([]);
  });

  /* A ciphertext whose wrapping key is gone is indistinguishable from nothing stored,
     and the only useful answer is the same one: ask for the key again. */
  it('answers null instead of throwing when the ciphertext no longer decrypts', async () => {
    const store = memoryStore();
    const keystore = createKeystore(store);
    await keystore.save('gemini', 'secret');
    await store.delete('wrapping-key');
    await expect(keystore.load('gemini')).resolves.toBeNull();
  });

  /**
   * The security claim, checked rather than asserted in a comment.
   *
   * Nothing readable reaches storage, and the wrapping key cannot be exported — which
   * is what makes copying the database useless. Everything else about this feature is
   * convenience; this is the part that justifies storing a credential at all.
   */
  it('stores no plaintext and no exportable key', async () => {
    const store = memoryStore();
    const keystore = createKeystore(store);
    await keystore.save('gemini', 'AIza-super-secret');

    const entries = [...store.dump().entries()];
    const serialized = JSON.stringify(entries, (_key, value) =>
      value instanceof Uint8Array || value instanceof ArrayBuffer ? '<bytes>' : value,
    );
    expect(serialized).not.toContain('AIza-super-secret');

    const wrapping = store.dump().get('wrapping-key');
    expect(wrapping).toBeInstanceOf(CryptoKey);
    expect((wrapping as CryptoKey).extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', wrapping as CryptoKey)).rejects.toThrow();
  });

  /* A fresh IV per save: reusing one under AES-GCM is the classic way to turn
     encryption into a puzzle rather than a wall. */
  it('uses a different IV every time', async () => {
    const store = memoryStore();
    const keystore = createKeystore(store);
    await keystore.save('gemini', 'same-secret');
    const first = store.dump().get('key:gemini') as { iv: Uint8Array };
    await keystore.save('gemini', 'same-secret');
    const second = store.dump().get('key:gemini') as { iv: Uint8Array };
    expect([...first.iv].join(',')).not.toBe([...second.iv].join(','));
  });
});
