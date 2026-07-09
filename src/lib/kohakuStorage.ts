// Encrypted IndexedDB adapter implementing the Kohaku Host Storage interface.
//
// Plugin storage holds decrypted note data (the user's private balances and
// history), which is exactly what the privacy feature promises to hide, so
// values are AES-GCM encrypted at rest with a key derived from the passkey
// session (kohakuSession.deriveStorageKeyFromSession). Consequences:
// - Storage is only readable while the privacy session is unlocked, which is
//   fine because plugins only run post-unlock.
// - Scan state is re-derivable from chain data, losing it costs a re-sync,
//   never funds.
//
// Not Keychain (megabytes, continuously rewritten during sync) and not
// localStorage (5MB quota). Same iOS 17 availability gate as walletconnect.ts.

import { sha256 } from "@noble/hashes/sha2.js";
import { deriveStorageKeyFromSession } from "./kohakuSession";

const DB_NAME = "punk_wallet_kohaku";
const STORE_NAME = "host";
const DB_VERSION = 1;

// Kohaku Host Storage shape (structural, so kohaku.ts can pass this without
// re-exporting SDK types here)
export type KohakuHostStorage = {
  readonly _brand: "Storage";
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

// iOS 17 bug workaround, same probe pattern as walletconnect.ts
export async function checkKohakuIdbAvailable(): Promise<boolean> {
  if (typeof indexedDB === "undefined") {
    return false;
  }

  return new Promise((resolve) => {
    try {
      const testDbName = "__kohaku_idb_test__";
      const request = indexedDB.open(testDbName);

      request.onerror = () => {
        console.warn("Kohaku IndexedDB test failed - not available");
        resolve(false);
      };

      request.onsuccess = () => {
        try {
          request.result.close();
          indexedDB.deleteDatabase(testDbName);
          resolve(true);
        } catch {
          resolve(false);
        }
      };

      setTimeout(() => {
        console.warn("Kohaku IndexedDB test timed out");
        resolve(false);
      }, 3000);
    } catch {
      resolve(false);
    }
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error ?? new Error("Failed to open Kohaku storage DB"));
      };
    });
  }
  return dbPromise;
}

function idbGet(key: string): Promise<ArrayBuffer | null> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve((req.result as ArrayBuffer) ?? null);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbSet(key: string, value: ArrayBuffer): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

async function importAesKey(): Promise<CryptoKey> {
  const raw = deriveStorageKeyFromSession();
  try {
    return await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    raw.fill(0);
  }
}

async function encryptValue(plaintext: string): Promise<ArrayBuffer> {
  const key = await importAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const out = new Uint8Array(12 + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), 12);
  return out.buffer;
}

async function decryptValue(stored: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(stored);
  const key = await importAesKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12)
  );
  return new TextDecoder().decode(plaintext);
}

// Short stable per-wallet namespace so multiple wallets never share plugin
// state (the credentialId itself is not sensitive, hashing just keeps keys
// short and uniform)
function walletNamespace(credentialId: string): string {
  const digest = sha256(new TextEncoder().encode(credentialId));
  return Array.from(digest.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createHostStorage(
  credentialId: string,
  protocol: string
): KohakuHostStorage {
  const prefix = `${walletNamespace(credentialId)}:${protocol}:`;
  return {
    _brand: "Storage" as const,
    async get(key: string): Promise<string | null> {
      const stored = await idbGet(prefix + key);
      if (stored === null) return null;
      try {
        return await decryptValue(stored);
      } catch {
        // Wrong session key (e.g. different wallet) or corrupted record.
        // Treat as absent, the plugin re-syncs from chain data.
        console.warn("Kohaku storage decrypt failed, treating as empty:", key);
        return null;
      }
    },
    async set(key: string, value: string): Promise<void> {
      await idbSet(prefix + key, await encryptValue(value));
    },
  };
}
