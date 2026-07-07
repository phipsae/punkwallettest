// Async store for the AES-GCM-encrypted private keys of imported wallets.
// The API is async so the backend can be swapped per platform: web keeps
// localStorage, native iOS uses the Keychain (SecureStorage plugin). Callers
// must treat a missing record as a hard error for imported wallets - never
// fall back to key derivation.

export interface EncryptedKeyRecord {
  iv: string; // base64url
  ciphertext: string; // base64url
}

const ENCRYPTED_KEYS_STORAGE_KEY = "punk_wallet_encrypted_keys";

async function readAllRecords(): Promise<Record<string, EncryptedKeyRecord>> {
  if (typeof window === "undefined") return {};
  const stored = localStorage.getItem(ENCRYPTED_KEYS_STORAGE_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

async function writeAllRecords(
  records: Record<string, EncryptedKeyRecord>
): Promise<void> {
  localStorage.setItem(ENCRYPTED_KEYS_STORAGE_KEY, JSON.stringify(records));
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
