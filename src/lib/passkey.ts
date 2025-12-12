import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import { hexToBytes, keccak256, concat } from "viem";

// Types for our passkey-derived wallet
export interface PasskeyCredential {
  credentialId: string; // base64url format (original from WebAuthn)
  credentialIdHex: string; // hex format for key derivation
  publicKey: string;
  createdAt: number;
  username?: string;
  isImported?: boolean; // true if wallet was imported via private key
}

export interface StoredWallet {
  credentialId: string;
  credentialIdHex: string;
  username: string;
  address: string;
  createdAt: number;
  isImported?: boolean; // true if wallet was imported via private key
}

export interface PasskeyWallet {
  credential: PasskeyCredential;
  privateKey: `0x${string}`;
  address: `0x${string}`;
}

export interface RecoveryResult {
  wallet: PasskeyWallet;
  alreadyExisted: boolean;
}

// Storage keys
const CREDENTIAL_STORAGE_KEY = "punk_wallet_credential";
const WALLETS_LIST_KEY = "punk_wallet_list";

// Passkey RP (Relying Party) configuration
// This MUST match the domain in your apple-app-site-association file
// Set NEXT_PUBLIC_PASSKEY_RP_ID in your .env.local or Vercel environment
function getPasskeyRpId(): string {
  // Use environment variable if set (for production)
  if (
    typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_PASSKEY_RP_ID
  ) {
    return process.env.NEXT_PUBLIC_PASSKEY_RP_ID;
  }
  // Fallback to current hostname (for local development)
  if (typeof window !== "undefined") {
    return window.location.hostname;
  }
  return "localhost";
}

// Generate a random challenge
function generateChallenge(): Uint8Array {
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  return challenge;
}

// Derive a private key from the passkey credential ID
// We use ONLY the credential ID for deterministic derivation
// This ensures the same passkey always produces the same wallet
async function derivePrivateKey(
  credentialIdHex: string
): Promise<`0x${string}`> {
  const credentialBytes = hexToBytes(credentialIdHex as `0x${string}`);

  // Add a domain separator for security
  const domainSeparator = new TextEncoder().encode("PunkWallet-v1");

  // Hash credential ID with domain separator to get private key
  const combined = concat([domainSeparator, credentialBytes]);
  const privateKey = keccak256(combined);

  return privateKey;
}

// Convert ArrayBuffer to base64url string
function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Convert base64url to hex
function base64urlToHex(base64url: string): string {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  let hex = "0x";
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex;
}

// Get all stored wallets
export function getStoredWallets(): StoredWallet[] {
  if (typeof window === "undefined") return [];
  const stored = localStorage.getItem(WALLETS_LIST_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

// Save wallet to the list
export function saveWalletToList(wallet: StoredWallet): void {
  const wallets = getStoredWallets();
  // Check if already exists
  const existingIndex = wallets.findIndex(
    (w) => w.credentialId === wallet.credentialId
  );
  if (existingIndex >= 0) {
    wallets[existingIndex] = wallet;
  } else {
    wallets.push(wallet);
  }
  localStorage.setItem(WALLETS_LIST_KEY, JSON.stringify(wallets));
}

// Check if running on Mac (iOS app on Mac via Catalyst)
export function isMacCatalystApp(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  const isMac = ua.includes("Macintosh") || ua.includes("Mac OS");
  const isCapacitor =
    (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    )?.Capacitor?.isNativePlatform?.() ?? false;
  return isMac && isCapacitor;
}

// Register a new passkey
export async function registerPasskey(
  username: string
): Promise<PasskeyCredential> {
  const challenge = generateChallenge();

  const registrationResponse = await startRegistration({
    optionsJSON: {
      challenge: bufferToBase64url(challenge.buffer as ArrayBuffer),
      rp: {
        name: "Punk Wallet",
        id: getPasskeyRpId(),
      },
      user: {
        id: bufferToBase64url(
          new TextEncoder().encode(username + "-" + Date.now())
            .buffer as ArrayBuffer
        ),
        name: username,
        displayName: username,
      },
      pubKeyCredParams: [
        { alg: -7, type: "public-key" }, // ES256 (P-256)
        { alg: -257, type: "public-key" }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "required",
      },
      timeout: 60000,
      attestation: "none",
    },
  });

  // Store both the original base64url ID and the hex version
  const credential: PasskeyCredential = {
    credentialId: registrationResponse.id,
    credentialIdHex: base64urlToHex(registrationResponse.id),
    publicKey: base64urlToHex(
      registrationResponse.response.publicKey || registrationResponse.id
    ),
    createdAt: Date.now(),
    username,
  };

  // Derive the address for this credential
  const privateKey = await derivePrivateKey(credential.credentialIdHex);
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(privateKey);

  // Save to wallets list
  saveWalletToList({
    credentialId: credential.credentialId,
    credentialIdHex: credential.credentialIdHex,
    username,
    address: account.address,
    createdAt: credential.createdAt,
  });

  // Store current credential
  localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));

  return credential;
}

// Authenticate with existing passkey and derive wallet
export async function authenticateAndDeriveWallet(): Promise<PasskeyWallet | null> {
  const stored = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  const credential: PasskeyCredential = JSON.parse(stored);
  const challenge = generateChallenge();

  // Handle migration from old format (where credentialId was hex)
  let credentialIdBase64url = credential.credentialId;
  let credentialIdHex = credential.credentialIdHex;

  // If credentialId starts with 0x, it's in the old format
  if (credential.credentialId.startsWith("0x")) {
    const hexBytes = hexToBytes(credential.credentialId as `0x${string}`);
    credentialIdBase64url = bufferToBase64url(hexBytes.buffer as ArrayBuffer);
    credentialIdHex = credential.credentialId;
  }

  try {
    // Authenticate with specific credential
    await startAuthentication({
      optionsJSON: {
        challenge: bufferToBase64url(challenge.buffer as ArrayBuffer),
        rpId: getPasskeyRpId(),
        allowCredentials: [
          {
            id: credentialIdBase64url,
            type: "public-key",
          },
        ],
        userVerification: "required",
        timeout: 60000,
      },
    });

    // Derive private key deterministically from credential ID
    const privateKey = await derivePrivateKey(credentialIdHex);
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(privateKey);

    return {
      credential,
      privateKey,
      address: account.address,
    };
  } catch (error) {
    console.error("Authentication failed:", error);
    return null;
  }
}

// Extract username from userHandle (which contains "username-timestamp")
function extractUsernameFromUserHandle(
  userHandle: string | undefined
): string | undefined {
  if (!userHandle) return undefined;

  try {
    // userHandle is base64url encoded
    const decoded = base64urlToString(userHandle);
    // Format is "username-timestamp", we want just the username
    // Find the last dash followed by a number (timestamp)
    const lastDashIndex = decoded.lastIndexOf("-");
    if (lastDashIndex > 0) {
      const afterDash = decoded.substring(lastDashIndex + 1);
      // Check if what's after the dash looks like a timestamp (all digits)
      if (/^\d+$/.test(afterDash)) {
        return decoded.substring(0, lastDashIndex);
      }
    }
    // If no valid timestamp suffix found, return the whole decoded string
    return decoded;
  } catch {
    return undefined;
  }
}

// Convert base64url to string
function base64urlToString(base64url: string): string {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(base64 + padding);
}

// Recover wallet using discoverable credentials
// This lets the browser show ALL passkeys for this site
export async function recoverWallet(): Promise<RecoveryResult | null> {
  const challenge = generateChallenge();

  try {
    // Don't specify allowCredentials - browser will show all registered passkeys
    const authResponse = await startAuthentication({
      optionsJSON: {
        challenge: bufferToBase64url(challenge.buffer as ArrayBuffer),
        rpId: getPasskeyRpId(),
        userVerification: "required",
        timeout: 60000,
        // No allowCredentials = discoverable credential mode
      },
    });

    // Get the credential ID from the response
    const credentialId = authResponse.id;
    const credentialIdHex = base64urlToHex(credentialId);

    // Check if wallet already exists in local storage
    const wallets = getStoredWallets();
    const existingWallet = wallets.find((w) => w.credentialId === credentialId);
    const alreadyExisted = !!existingWallet;

    // Derive private key deterministically from credential ID
    const privateKey = await derivePrivateKey(credentialIdHex);
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(privateKey);

    // Try to get username from multiple sources:
    // 1. First try the passkey's userHandle (most reliable for cross-device recovery)
    // 2. Fall back to local storage if available
    let username: string | undefined;

    // The userHandle in the auth response contains the user.id from registration
    // which was set to "username-timestamp"
    username = extractUsernameFromUserHandle(authResponse.response.userHandle);

    // Fall back to checking local storage
    if (!username && existingWallet) {
      username = existingWallet.username;
    }

    // Create credential object
    const credential: PasskeyCredential = {
      credentialId,
      credentialIdHex,
      publicKey: credentialIdHex,
      createdAt: existingWallet?.createdAt || Date.now(),
      username,
    };

    // Save as current credential
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));

    // Only add to wallets list if it doesn't already exist
    if (!alreadyExisted) {
      saveWalletToList({
        credentialId,
        credentialIdHex,
        username: username || "Recovered Wallet",
        address: account.address,
        createdAt: Date.now(),
      });
    }

    return {
      wallet: {
        credential,
        privateKey,
        address: account.address,
      },
      alreadyExisted,
    };
  } catch (error) {
    console.error("Recovery failed:", error);
    return null;
  }
}

// Authenticate with a specific stored wallet
export async function authenticateWithWallet(
  storedWallet: StoredWallet
): Promise<PasskeyWallet | null> {
  const challenge = generateChallenge();

  try {
    // Authenticate with the specific credential
    await startAuthentication({
      optionsJSON: {
        challenge: bufferToBase64url(challenge.buffer as ArrayBuffer),
        rpId: getPasskeyRpId(),
        allowCredentials: [
          {
            id: storedWallet.credentialId,
            type: "public-key",
          },
        ],
        userVerification: "required",
        timeout: 60000,
      },
    });

    // Derive private key deterministically from credential ID
    const privateKey = await derivePrivateKey(storedWallet.credentialIdHex);
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(privateKey);

    // Create credential object
    const credential: PasskeyCredential = {
      credentialId: storedWallet.credentialId,
      credentialIdHex: storedWallet.credentialIdHex,
      publicKey: storedWallet.credentialIdHex,
      createdAt: storedWallet.createdAt,
      username: storedWallet.username,
    };

    // Save as current credential
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));

    return {
      credential,
      privateKey,
      address: account.address,
    };
  } catch (error) {
    console.error("Authentication failed:", error);
    return null;
  }
}

// Check if a passkey credential exists
export function hasStoredCredential(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(CREDENTIAL_STORAGE_KEY) !== null;
}

// Clear stored credential (but keep in wallets list)
export function clearStoredCredential(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(CREDENTIAL_STORAGE_KEY);
}

// Get stored credential without authentication
export function getStoredCredential(): PasskeyCredential | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
  if (!stored) return null;
  return JSON.parse(stored);
}

// Remove a wallet from the stored wallets list
export function removeWalletFromList(credentialId: string): void {
  if (typeof window === "undefined") return;
  const wallets = getStoredWallets();
  const filtered = wallets.filter((w) => w.credentialId !== credentialId);
  localStorage.setItem(WALLETS_LIST_KEY, JSON.stringify(filtered));
}

// Update wallet name in storage
export function updateWalletName(credentialId: string, newName: string): void {
  if (typeof window === "undefined") return;

  // Update in wallets list
  const wallets = getStoredWallets();
  const walletIndex = wallets.findIndex((w) => w.credentialId === credentialId);
  if (walletIndex >= 0) {
    wallets[walletIndex].username = newName;
    localStorage.setItem(WALLETS_LIST_KEY, JSON.stringify(wallets));
  }

  // Update current credential if it matches
  const currentCredential = getStoredCredential();
  if (currentCredential?.credentialId === credentialId) {
    currentCredential.username = newName;
    localStorage.setItem(
      CREDENTIAL_STORAGE_KEY,
      JSON.stringify(currentCredential)
    );
  }
}

// Delete account with passkey authentication
// Requires re-authentication before deletion for security
export async function deleteAccountWithAuth(
  storedWallet: StoredWallet
): Promise<boolean> {
  const challenge = generateChallenge();

  try {
    // Require passkey authentication before deletion (for both regular and imported wallets)
    await startAuthentication({
      optionsJSON: {
        challenge: bufferToBase64url(challenge.buffer as ArrayBuffer),
        rpId: getPasskeyRpId(),
        allowCredentials: [
          {
            id: storedWallet.credentialId,
            type: "public-key",
          },
        ],
        userVerification: "required",
        timeout: 60000,
      },
    });

    // Authentication successful - remove from wallets list
    removeWalletFromList(storedWallet.credentialId);

    // If this was the current credential, clear it
    const currentCredential = getStoredCredential();
    if (currentCredential?.credentialId === storedWallet.credentialId) {
      clearStoredCredential();
    }

    // If imported wallet, also remove the encrypted key
    if (storedWallet.isImported) {
      removeEncryptedKey(storedWallet.credentialId);
    }

    return true;
  } catch (error) {
    console.error("Delete authentication failed:", error);
    return false;
  }
}

// Storage key for encrypted imported wallet private keys
const ENCRYPTED_KEYS_STORAGE_KEY = "punk_wallet_encrypted_keys";

// Get stored encrypted private keys
function getEncryptedKeys(): Record<
  string,
  { iv: string; ciphertext: string }
> {
  if (typeof window === "undefined") return {};
  const stored = localStorage.getItem(ENCRYPTED_KEYS_STORAGE_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

// Save encrypted private key
function saveEncryptedKey(
  credentialId: string,
  iv: string,
  ciphertext: string
): void {
  const keys = getEncryptedKeys();
  keys[credentialId] = { iv, ciphertext };
  localStorage.setItem(ENCRYPTED_KEYS_STORAGE_KEY, JSON.stringify(keys));
}

// Remove encrypted private key
function removeEncryptedKey(credentialId: string): void {
  const keys = getEncryptedKeys();
  delete keys[credentialId];
  localStorage.setItem(ENCRYPTED_KEYS_STORAGE_KEY, JSON.stringify(keys));
}

// Derive an AES encryption key from the passkey credential ID
async function deriveEncryptionKey(
  credentialIdHex: string
): Promise<CryptoKey> {
  const credentialBytes = hexToBytes(credentialIdHex as `0x${string}`);

  // Use a different domain separator for encryption (different from wallet derivation)
  const domainSeparator = new TextEncoder().encode(
    "PunkWallet-Import-Encryption-v1"
  );
  const combined = concat([domainSeparator, credentialBytes]);

  // Hash to get key material
  const keyMaterial = keccak256(combined);
  const keyBytes = hexToBytes(keyMaterial);

  // Convert to ArrayBuffer for crypto.subtle
  const keyBuffer = new Uint8Array(keyBytes).buffer;

  // Import as AES-GCM key
  return await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Encrypt private key using AES-GCM
async function encryptPrivateKey(
  privateKey: string,
  encryptionKey: CryptoKey
): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const data = encoder.encode(privateKey);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    encryptionKey,
    data
  );

  return {
    iv: bufferToBase64url(iv.buffer as ArrayBuffer),
    ciphertext: bufferToBase64url(ciphertext),
  };
}

// Decrypt private key using AES-GCM
async function decryptPrivateKey(
  iv: string,
  ciphertext: string,
  encryptionKey: CryptoKey
): Promise<string> {
  // Convert base64url back to ArrayBuffer
  const ivBytes = base64urlToArrayBuffer(iv);
  const ciphertextBytes = base64urlToArrayBuffer(ciphertext);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    encryptionKey,
    ciphertextBytes
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

// Convert base64url to ArrayBuffer
function base64urlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Validate private key format
export function isValidPrivateKey(key: string): boolean {
  // Check if it's a valid hex string with 0x prefix and 64 hex chars (32 bytes)
  const cleanKey = key.trim();
  if (cleanKey.startsWith("0x")) {
    return /^0x[a-fA-F0-9]{64}$/.test(cleanKey);
  }
  // Also accept without 0x prefix
  return /^[a-fA-F0-9]{64}$/.test(cleanKey);
}

// Normalize private key to 0x format
function normalizePrivateKey(key: string): `0x${string}` {
  const cleanKey = key.trim();
  if (cleanKey.startsWith("0x")) {
    return cleanKey as `0x${string}`;
  }
  return `0x${cleanKey}`;
}

// Import wallet from private key - creates a passkey and encrypts the imported key
export async function importWalletFromPrivateKey(
  privateKey: string,
  username: string
): Promise<PasskeyWallet | null> {
  try {
    const normalizedKey = normalizePrivateKey(privateKey);
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(normalizedKey);

    // Step 1: Create a new passkey for this imported wallet
    const challenge = generateChallenge();
    const registrationResponse = await startRegistration({
      optionsJSON: {
        challenge: bufferToBase64url(challenge.buffer as ArrayBuffer),
        rp: {
          name: "Punk Wallet",
          id: getPasskeyRpId(),
        },
        user: {
          id: bufferToBase64url(
            new TextEncoder().encode(`import-${account.address}-${Date.now()}`)
              .buffer as ArrayBuffer
          ),
          name: `${username} (Imported)`,
          displayName: `${username} (Imported)`,
        },
        pubKeyCredParams: [
          { alg: -7, type: "public-key" },
          { alg: -257, type: "public-key" },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "required",
        },
        timeout: 60000,
        attestation: "none",
      },
    });

    const credentialId = registrationResponse.id;
    const credentialIdHex = base64urlToHex(credentialId);

    // Step 2: Derive encryption key from the passkey's credential ID
    const encryptionKey = await deriveEncryptionKey(credentialIdHex);

    // Step 3: Encrypt the imported private key
    const { iv, ciphertext } = await encryptPrivateKey(
      normalizedKey,
      encryptionKey
    );

    // Step 4: Store the encrypted key
    saveEncryptedKey(credentialId, iv, ciphertext);

    // Create credential object
    const credential: PasskeyCredential = {
      credentialId,
      credentialIdHex,
      publicKey: base64urlToHex(
        registrationResponse.response.publicKey || credentialId
      ),
      createdAt: Date.now(),
      username,
      isImported: true,
    };

    // Save to wallets list
    saveWalletToList({
      credentialId,
      credentialIdHex,
      username,
      address: account.address,
      createdAt: credential.createdAt,
      isImported: true,
    });

    // Store current credential
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));

    return {
      credential,
      privateKey: normalizedKey,
      address: account.address,
    };
  } catch (error) {
    console.error("Import wallet failed:", error);
    return null;
  }
}

// Unlock an imported wallet - requires passkey authentication to decrypt the key
export async function unlockImportedWallet(
  storedWallet: StoredWallet
): Promise<PasskeyWallet | null> {
  if (!storedWallet.isImported) {
    console.error("Not an imported wallet");
    return null;
  }

  const challenge = generateChallenge();

  try {
    // Step 1: Authenticate with the passkey
    await startAuthentication({
      optionsJSON: {
        challenge: bufferToBase64url(challenge.buffer as ArrayBuffer),
        rpId: getPasskeyRpId(),
        allowCredentials: [
          {
            id: storedWallet.credentialId,
            type: "public-key",
          },
        ],
        userVerification: "required",
        timeout: 60000,
      },
    });

    // Step 2: Get the encrypted key
    const encryptedKeys = getEncryptedKeys();
    const encryptedData = encryptedKeys[storedWallet.credentialId];

    if (!encryptedData) {
      console.error("Encrypted key not found for imported wallet");
      return null;
    }

    // Step 3: Derive the decryption key from credential ID
    const encryptionKey = await deriveEncryptionKey(
      storedWallet.credentialIdHex
    );

    // Step 4: Decrypt the private key
    const privateKey = await decryptPrivateKey(
      encryptedData.iv,
      encryptedData.ciphertext,
      encryptionKey
    );

    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(privateKey as `0x${string}`);

    const credential: PasskeyCredential = {
      credentialId: storedWallet.credentialId,
      credentialIdHex: storedWallet.credentialIdHex,
      publicKey: storedWallet.credentialIdHex,
      createdAt: storedWallet.createdAt,
      username: storedWallet.username,
      isImported: true,
    };

    // Save as current credential
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));

    return {
      credential,
      privateKey: privateKey as `0x${string}`,
      address: account.address,
    };
  } catch (error) {
    console.error("Unlock imported wallet failed:", error);
    return null;
  }
}

// Enhanced remove that also cleans up encrypted keys
export function removeWalletFromListWithCleanup(credentialId: string): void {
  removeWalletFromList(credentialId);
  removeEncryptedKey(credentialId);
}
