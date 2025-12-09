import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import { bytesToHex, hexToBytes, keccak256, concat } from "viem";

// Types for our passkey-derived wallet
export interface PasskeyCredential {
  credentialId: string; // base64url format (original from WebAuthn)
  credentialIdHex: string; // hex format for key derivation
  publicKey: string;
  createdAt: number;
  username?: string;
}

export interface StoredWallet {
  credentialId: string;
  credentialIdHex: string;
  username: string;
  address: string;
  createdAt: number;
}

export interface PasskeyWallet {
  credential: PasskeyCredential;
  privateKey: `0x${string}`;
  address: `0x${string}`;
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
function saveWalletToList(wallet: StoredWallet): void {
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

// Recover wallet using discoverable credentials
// This lets the browser show ALL passkeys for this site
export async function recoverWallet(): Promise<PasskeyWallet | null> {
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

    // Derive private key deterministically from credential ID
    const privateKey = await derivePrivateKey(credentialIdHex);
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(privateKey);

    // Create credential object
    const credential: PasskeyCredential = {
      credentialId,
      credentialIdHex,
      publicKey: credentialIdHex,
      createdAt: Date.now(),
    };

    // Check if this wallet is in our list, if so get the username
    const wallets = getStoredWallets();
    const existingWallet = wallets.find((w) => w.credentialId === credentialId);
    if (existingWallet) {
      credential.username = existingWallet.username;
    }

    // Save as current credential
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));

    // Also save/update in wallets list
    saveWalletToList({
      credentialId,
      credentialIdHex,
      username: credential.username || "Recovered Wallet",
      address: account.address,
      createdAt: existingWallet?.createdAt || Date.now(),
    });

    return {
      credential,
      privateKey,
      address: account.address,
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
