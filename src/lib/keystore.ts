// Async store for the AES-GCM-encrypted private keys of imported wallets.
// Backend per platform: web keeps localStorage; native iOS stores the record
// in the Keychain (SecureStorage plugin, device-only, non-migrating), with a
// one-time verified migration of any pre-existing localStorage record.
// Callers must treat a missing record as a hard error for imported wallets -
// never fall back to key derivation.

import { Capacitor } from "@capacitor/core";
import { secureGet, secureSet } from "./securestorage";

export interface EncryptedKeyRecord {
  iv: string; // base64url
  ciphertext: string; // base64url
}

const ENCRYPTED_KEYS_STORAGE_KEY = "punk_wallet_encrypted_keys";

function parseRecords(raw: string | null): Record<string, EncryptedKeyRecord> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// One-time migration of the encrypted-keys record out of the WebView's
// localStorage into the Keychain. localStorage is only cleared after the
// Keychain copy is read back and verified; on any failure the localStorage
// copy is kept and the error propagates (an imported wallet must fail
// loudly, never silently lose its blob).
let migrationPromise: Promise<void> | null = null;

async function ensureMigrated(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (!migrationPromise) {
    migrationPromise = (async () => {
      if (typeof window === "undefined") return;
      const local = localStorage.getItem(ENCRYPTED_KEYS_STORAGE_KEY);
      if (!local) return;

      // Merge with anything already in the Keychain (Keychain wins) so an
      // interrupted earlier migration cannot drop entries.
      const keychainRaw = await secureGet(ENCRYPTED_KEYS_STORAGE_KEY);
      const merged = JSON.stringify({
        ...parseRecords(local),
        ...parseRecords(keychainRaw),
      });

      await secureSet(ENCRYPTED_KEYS_STORAGE_KEY, merged);
      const readback = await secureGet(ENCRYPTED_KEYS_STORAGE_KEY);
      if (readback !== merged) {
        throw new Error(
          "Keychain migration verification failed - keeping the existing copy. Imported wallets remain usable; try again after restarting the app."
        );
      }
      localStorage.removeItem(ENCRYPTED_KEYS_STORAGE_KEY);
    })().catch((err) => {
      // Allow a retry on the next call instead of caching the failure
      migrationPromise = null;
      throw err;
    });
  }
  return migrationPromise;
}

async function readAllRecords(): Promise<Record<string, EncryptedKeyRecord>> {
  await ensureMigrated();
  return parseRecords(await secureGet(ENCRYPTED_KEYS_STORAGE_KEY));
}

async function writeAllRecords(
  records: Record<string, EncryptedKeyRecord>
): Promise<void> {
  await ensureMigrated();
  await secureSet(ENCRYPTED_KEYS_STORAGE_KEY, JSON.stringify(records));
}

export async function getEncryptedKeyRecord(
  credentialId: string
): Promise<EncryptedKeyRecord | null> {
  const records = await readAllRecords();
  return records[credentialId] ?? null;
}

export async function hasEncryptedKey(credentialId: string): Promise<boolean> {
  return (await getEncryptedKeyRecord(credentialId)) !== null;
}

export async function saveEncryptedKey(
  credentialId: string,
  record: EncryptedKeyRecord
): Promise<void> {
  const records = await readAllRecords();
  records[credentialId] = record;
  await writeAllRecords(records);
}

export async function removeEncryptedKey(credentialId: string): Promise<void> {
  const records = await readAllRecords();
  delete records[credentialId];
  await writeAllRecords(records);
}
