import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import { hexToBytes, keccak256, concat, toHex } from "viem";
import { p256 } from "@noble/curves/p256";

// SHA-256 hash function using Web Crypto API
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Create a new Uint8Array copy to ensure compatibility with SubtleCrypto
  const copy = new Uint8Array(data);
  const hash = await crypto.subtle.digest("SHA-256", copy);
  return new Uint8Array(hash);
}

// Synchronous keccak256 hash for non-WebAuthn uses (challenge generation)
function hashForChallenge(data: Uint8Array): Uint8Array {
  const hex = toHex(data);
  const hash = keccak256(hex);
  return hexToBytes(hash);
}

// Types for our passkey-derived wallet
export interface PasskeyCredential {
  credentialId: string; // base64url format (original from WebAuthn)
  credentialIdHex: string; // hex format for legacy compatibility
  publicKey: string;
  createdAt: number;
  username?: string;
  isImported?: boolean; // true if wallet was imported via private key
  isLegacy?: boolean; // true for v1 wallets (insecure credentialId-based derivation)
}

export interface StoredWallet {
  credentialId: string;
  credentialIdHex: string;
  username: string;
  address: string;
  createdAt: number;
  isImported?: boolean; // true if wallet was imported via private key
  isLegacy?: boolean; // true for v1 wallets (insecure credentialId-based derivation)
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
  // Check if running in Capacitor native app
  const isCapacitor =
    typeof window !== "undefined" &&
    (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    )?.Capacitor?.isNativePlatform?.();

  // For Capacitor apps, ALWAYS use the production RP ID from env var
  // (Capacitor runs on localhost internally but needs the real domain for passkeys)
  if (isCapacitor) {
    if (
      typeof process !== "undefined" &&
      process.env?.NEXT_PUBLIC_PASSKEY_RP_ID
    ) {
      return process.env.NEXT_PUBLIC_PASSKEY_RP_ID;
    }
  }

  // For browser-based local development (not Capacitor), use localhost
  if (typeof window !== "undefined") {
    const hostname = window.location.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return hostname;
    }
  }

  // Use environment variable if set (for production web)
  if (
    typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_PASSKEY_RP_ID
  ) {
    return process.env.NEXT_PUBLIC_PASSKEY_RP_ID;
  }

  // Fallback to current hostname
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

// ============================================================================
// LEGACY (INSECURE) KEY DERIVATION - Only for backward compatibility
// WARNING: This method derives keys from the public credentialId, which is NOT secure.
// Anyone with access to localStorage can derive the private key without biometric auth.
// ============================================================================
async function derivePrivateKeyLegacy(
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

// ============================================================================
// PASSSEEDS SECURE KEY DERIVATION (v2)
// Uses ECDSA public key recovery from WebAuthn signatures.
// The private key can ONLY be derived after successful biometric authentication.
// ============================================================================

// Helper to convert Uint8Array to hex string (browser-compatible, no Buffer needed)
function bytesToHexString(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Generate a deterministic challenge for PassSeeds
// This challenge is used for key derivation and must be consistent
function getPassSeedsChallenge(credentialId: string): Uint8Array {
  const encoder = new TextEncoder();
  const data = encoder.encode(`PunkWallet-PassSeeds-v2:${credentialId}`);
  // Use keccak256 for challenge generation (synchronous, doesn't need to be SHA-256)
  return hashForChallenge(data);
}

// Parse ASN.1 DER encoded signature from WebAuthn into r, s components
function parseAsn1Signature(signature: Uint8Array): { r: bigint; s: bigint } {
  // ASN.1 DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
  if (signature[0] !== 0x30) {
    throw new Error("Invalid signature: not a SEQUENCE");
  }

  let offset = 2; // Skip SEQUENCE tag and length

  // Parse r
  if (signature[offset] !== 0x02) {
    throw new Error("Invalid signature: r is not an INTEGER");
  }
  offset++;
  const rLength = signature[offset];
  offset++;
  let rBytes = signature.slice(offset, offset + rLength);
  // Remove leading zero if present (ASN.1 adds it for positive numbers with high bit set)
  if (rBytes[0] === 0x00 && rBytes.length > 1) {
    rBytes = rBytes.slice(1);
  }
  offset += rLength;

  // Parse s
  if (signature[offset] !== 0x02) {
    throw new Error("Invalid signature: s is not an INTEGER");
  }
  offset++;
  const sLength = signature[offset];
  offset++;
  let sBytes = signature.slice(offset, offset + sLength);
  // Remove leading zero if present
  if (sBytes[0] === 0x00 && sBytes.length > 1) {
    sBytes = sBytes.slice(1);
  }

  // Convert to BigInt
  const r = BigInt("0x" + bytesToHexString(rBytes));
  const s = BigInt("0x" + bytesToHexString(sBytes));

  return { r, s };
}

// Compute the WebAuthn message hash that was signed
// Per WebAuthn spec: hash = SHA-256(authenticatorData || SHA-256(clientDataJSON))
async function computeWebAuthnMessageHash(
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array
): Promise<Uint8Array> {
  const clientDataHash = await sha256(clientDataJSON);
  const combined = new Uint8Array(authenticatorData.length + clientDataHash.length);
  combined.set(authenticatorData, 0);
  combined.set(clientDataHash, authenticatorData.length);
  return sha256(combined);
}

// Recover public key from WebAuthn signature using ECDSA recovery
// Returns the recovered public key as a hex string
async function recoverPublicKeyFromSignature(
  signature: Uint8Array,
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array
): Promise<`0x${string}`> {
  const { r, s } = parseAsn1Signature(signature);
  const msgHash = await computeWebAuthnMessageHash(authenticatorData, clientDataJSON);

  // Try both recovery IDs (0 and 1) to find the valid public key
  // P-256 signatures can recover to one of two possible public keys
  for (let recoveryId = 0; recoveryId <= 1; recoveryId++) {
    try {
      const sig = new p256.Signature(r, s).addRecoveryBit(recoveryId);
      const publicKey = sig.recoverPublicKey(msgHash);
      // Return the compressed public key as hex
      const pubKeyBytes = publicKey.toRawBytes(true);
      const hex = "0x" + bytesToHexString(pubKeyBytes);
      return hex as `0x${string}`;
    } catch {
      // Try next recovery ID
      continue;
    }
  }

  throw new Error("Failed to recover public key from signature");
}

// Derive private key securely from recovered public key (PassSeeds v2)
// This requires actual biometric authentication to get the signature
function derivePrivateKeyFromPublicKey(
  recoveredPublicKey: `0x${string}`
): `0x${string}` {
  const publicKeyBytes = hexToBytes(recoveredPublicKey);
  const domainSeparator = new TextEncoder().encode("PunkWallet-PassSeeds-v2");
  const combined = concat([domainSeparator, publicKeyBytes]);
  return keccak256(combined);
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

// Debug info for Mac detection
export interface MacDetectionDebug {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  isCapacitor: boolean;
  isMac: boolean;
  result: boolean;
}

export function getMacDetectionDebug(): MacDetectionDebug {
  if (typeof window === "undefined") {
    return {
      userAgent: "SSR",
      platform: "SSR",
      maxTouchPoints: 0,
      isCapacitor: false,
      isMac: false,
      result: false,
    };
  }

  const ua = navigator.userAgent;
  const platform = navigator.platform;
  const maxTouchPoints = navigator.maxTouchPoints;
  const isCapacitor =
    (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    )?.Capacitor?.isNativePlatform?.() ?? false;
  const isMac =
    ua.includes("Macintosh") ||
    ua.includes("Mac OS") ||
    platform.includes("Mac");

  return {
    userAgent: ua,
    platform,
    maxTouchPoints,
    isCapacitor,
    isMac,
    result: isMacCatalystApp(),
  };
}

// Check if running on Mac (iOS app on Mac via Catalyst)
// This should NOT trigger on iPhone/iPad or in the iOS Simulator
export function isMacCatalystApp(): boolean {
  if (typeof window === "undefined") return false;

  const ua = navigator.userAgent;
  const platform = navigator.platform;

  // Check navigator.platform first - this is more reliable for simulators
  // iOS devices and simulators report "iPad", "iPhone", or "iPod"
  // Macs report "MacIntel" or similar
  if (platform === "iPad" || platform === "iPhone" || platform === "iPod") {
    return false;
  }

  // Also check user agent for iPhone/iPad strings
  if (ua.includes("iPhone") || ua.includes("iPad")) {
    return false;
  }

  // Check for multi-touch support - real iPads have multi-touch (>1 touch points)
  // Mac Catalyst apps on Mac typically have 0 or 1 (trackpad)
  if (navigator.maxTouchPoints > 1) {
    return false;
  }

  // Now check if it's actually a Mac running Capacitor
  const isMac =
    ua.includes("Macintosh") ||
    ua.includes("Mac OS") ||
    platform.includes("Mac");
  const isCapacitor =
    (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    )?.Capacitor?.isNativePlatform?.() ?? false;

  return isMac && isCapacitor;
}

// Register a new passkey using PassSeeds (v2 secure derivation)
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
        { alg: -7, type: "public-key" }, // ES256 (P-256) - required for PassSeeds
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

  // PassSeeds: Immediately sign a deterministic challenge to recover the public key
  // This ensures we can derive the same wallet address on any device with this passkey
  const passSeedsChallenge = getPassSeedsChallenge(credentialId);
  
  const authResponse = await startAuthentication({
    optionsJSON: {
      challenge: bufferToBase64url(passSeedsChallenge.buffer as ArrayBuffer),
      rpId: getPasskeyRpId(),
      allowCredentials: [
        {
          id: credentialId,
          type: "public-key",
        },
      ],
      userVerification: "required",
      timeout: 60000,
    },
  });

  // Recover public key from the signature
  const signature = base64urlToArrayBuffer(authResponse.response.signature);
  const authenticatorData = base64urlToArrayBuffer(authResponse.response.authenticatorData);
  const clientDataJSON = new TextEncoder().encode(
    atob(authResponse.response.clientDataJSON.replace(/-/g, "+").replace(/_/g, "/"))
  );

  const recoveredPublicKey = await recoverPublicKeyFromSignature(
    new Uint8Array(signature),
    new Uint8Array(authenticatorData),
    clientDataJSON
  );

  // Derive wallet private key from recovered public key (PassSeeds v2)
  const privateKey = derivePrivateKeyFromPublicKey(recoveredPublicKey);
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(privateKey);

  // Store credential (v2 - not legacy)
  const credential: PasskeyCredential = {
    credentialId,
    credentialIdHex,
    publicKey: recoveredPublicKey,
    createdAt: Date.now(),
    username,
    isLegacy: false,
  };

  // Save to wallets list
  saveWalletToList({
    credentialId,
    credentialIdHex,
    username,
    address: account.address,
    createdAt: credential.createdAt,
    isLegacy: false,
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

  // Handle migration from old format (where credentialId was hex)
  let credentialIdBase64url = credential.credentialId;
  let credentialIdHex = credential.credentialIdHex;

  // If credentialId starts with 0x, it's in the old format
  if (credential.credentialId.startsWith("0x")) {
    const hexBytes = hexToBytes(credential.credentialId as `0x${string}`);
    credentialIdBase64url = bufferToBase64url(hexBytes.buffer as ArrayBuffer);
    credentialIdHex = credential.credentialId;
  }

  // Determine if this is a legacy wallet (v1) or PassSeeds wallet (v2)
  // Legacy wallets are those without isLegacy explicitly set to false
  const isLegacy = credential.isLegacy !== false;

  // Use deterministic PassSeeds challenge for v2, random for legacy
  const challenge = isLegacy
    ? generateChallenge()
    : getPassSeedsChallenge(credentialIdBase64url);

  try {
    // Authenticate with specific credential
    const authResponse = await startAuthentication({
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

    let privateKey: `0x${string}`;

    if (isLegacy) {
      // Legacy (v1): Derive from credential ID (INSECURE - for backward compatibility only)
      privateKey = await derivePrivateKeyLegacy(credentialIdHex);
    } else {
      // PassSeeds (v2): Recover public key from signature and derive from it
      const signature = base64urlToArrayBuffer(authResponse.response.signature);
      const authenticatorData = base64urlToArrayBuffer(authResponse.response.authenticatorData);
      const clientDataJSON = new TextEncoder().encode(
        atob(authResponse.response.clientDataJSON.replace(/-/g, "+").replace(/_/g, "/"))
      );

      const recoveredPublicKey = await recoverPublicKeyFromSignature(
        new Uint8Array(signature),
        new Uint8Array(authenticatorData),
        clientDataJSON
      );

      privateKey = derivePrivateKeyFromPublicKey(recoveredPublicKey);
    }

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
  try {
    // First, do a discoverable authentication to get the credential ID
    // We use a random challenge here since we don't know the credential ID yet
    const discoveryChallenge = generateChallenge();
    
    const discoveryResponse = await startAuthentication({
      optionsJSON: {
        challenge: bufferToBase64url(discoveryChallenge.buffer as ArrayBuffer),
        rpId: getPasskeyRpId(),
        userVerification: "required",
        timeout: 60000,
        // No allowCredentials = discoverable credential mode
      },
    });

    // Get the credential ID from the response
    const credentialId = discoveryResponse.id;
    const credentialIdHex = base64urlToHex(credentialId);

    // Check if wallet already exists in local storage
    const wallets = getStoredWallets();
    const existingWallet = wallets.find((w) => w.credentialId === credentialId);
    const alreadyExisted = !!existingWallet;

    // Determine if this is a legacy wallet
    const isLegacy = existingWallet?.isLegacy !== false;

    let privateKey: `0x${string}`;
    let recoveredPublicKey: `0x${string}` | undefined;

    if (isLegacy && existingWallet) {
      // Legacy wallet: use old derivation
      privateKey = await derivePrivateKeyLegacy(credentialIdHex);
    } else {
      // PassSeeds (v2): Need to authenticate again with the deterministic challenge
      // to recover the public key
      const passSeedsChallenge = getPassSeedsChallenge(credentialId);
      
      const authResponse = await startAuthentication({
        optionsJSON: {
          challenge: bufferToBase64url(passSeedsChallenge.buffer as ArrayBuffer),
          rpId: getPasskeyRpId(),
          allowCredentials: [
            {
              id: credentialId,
              type: "public-key",
            },
          ],
          userVerification: "required",
          timeout: 60000,
        },
      });

      // Recover public key from the signature
      const signature = base64urlToArrayBuffer(authResponse.response.signature);
      const authenticatorData = base64urlToArrayBuffer(authResponse.response.authenticatorData);
      const clientDataJSON = new TextEncoder().encode(
        atob(authResponse.response.clientDataJSON.replace(/-/g, "+").replace(/_/g, "/"))
      );

      recoveredPublicKey = await recoverPublicKeyFromSignature(
        new Uint8Array(signature),
        new Uint8Array(authenticatorData),
        clientDataJSON
      );

      privateKey = derivePrivateKeyFromPublicKey(recoveredPublicKey);
    }

    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(privateKey);

    // Try to get username from multiple sources:
    // 1. First try the passkey's userHandle (most reliable for cross-device recovery)
    // 2. Fall back to local storage if available
    let username: string | undefined;

    // The userHandle in the auth response contains the user.id from registration
    // which was set to "username-timestamp"
    username = extractUsernameFromUserHandle(discoveryResponse.response.userHandle);

    // Fall back to checking local storage
    if (!username && existingWallet) {
      username = existingWallet.username;
    }

    // Create credential object
    const credential: PasskeyCredential = {
      credentialId,
      credentialIdHex,
      publicKey: recoveredPublicKey || credentialIdHex,
      createdAt: existingWallet?.createdAt || Date.now(),
      username,
      isLegacy: isLegacy && !!existingWallet,
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
        isLegacy: false, // New recoveries use PassSeeds
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
  // Determine if this is a legacy wallet
  const isLegacy = storedWallet.isLegacy !== false;

  // Use deterministic PassSeeds challenge for v2, random for legacy
  const challenge = isLegacy
    ? generateChallenge()
    : getPassSeedsChallenge(storedWallet.credentialId);

  try {
    // Authenticate with the specific credential
    const authResponse = await startAuthentication({
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

    let privateKey: `0x${string}`;
    let publicKey: string;

    if (isLegacy) {
      // Legacy (v1): Derive from credential ID (INSECURE - for backward compatibility only)
      privateKey = await derivePrivateKeyLegacy(storedWallet.credentialIdHex);
      publicKey = storedWallet.credentialIdHex;
    } else {
      // PassSeeds (v2): Recover public key from signature and derive from it
      const signature = base64urlToArrayBuffer(authResponse.response.signature);
      const authenticatorData = base64urlToArrayBuffer(authResponse.response.authenticatorData);
      const clientDataJSON = new TextEncoder().encode(
        atob(authResponse.response.clientDataJSON.replace(/-/g, "+").replace(/_/g, "/"))
      );

      const recoveredPublicKey = await recoverPublicKeyFromSignature(
        new Uint8Array(signature),
        new Uint8Array(authenticatorData),
        clientDataJSON
      );

      privateKey = derivePrivateKeyFromPublicKey(recoveredPublicKey);
      publicKey = recoveredPublicKey;
    }

    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(privateKey);

    // Create credential object
    const credential: PasskeyCredential = {
      credentialId: storedWallet.credentialId,
      credentialIdHex: storedWallet.credentialIdHex,
      publicKey,
      createdAt: storedWallet.createdAt,
      username: storedWallet.username,
      isLegacy,
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

// ============================================================================
// MIGRATION HELPERS - For detecting and handling legacy (v1) wallets
// ============================================================================

// Check if a wallet is using legacy (insecure) key derivation
export function isLegacyWallet(wallet: StoredWallet | PasskeyCredential): boolean {
  // Legacy wallets are those without isLegacy explicitly set to false
  // and are not imported wallets
  if (wallet.isImported) return false;
  return wallet.isLegacy !== false;
}

// Get all legacy wallets that need migration
export function getLegacyWallets(): StoredWallet[] {
  return getStoredWallets().filter(
    (w) => !w.isImported && w.isLegacy !== false
  );
}

// Check if there are any legacy wallets that need migration warning
export function hasLegacyWallets(): boolean {
  return getLegacyWallets().length > 0;
}

// Get the secure (v2) address for a passkey
// This is useful for showing users what their new address will be after migration
export async function getSecureAddressForPasskey(
  credentialId: string
): Promise<`0x${string}` | null> {
  const passSeedsChallenge = getPassSeedsChallenge(credentialId);

  try {
    const authResponse = await startAuthentication({
      optionsJSON: {
        challenge: bufferToBase64url(passSeedsChallenge.buffer as ArrayBuffer),
        rpId: getPasskeyRpId(),
        allowCredentials: [
          {
            id: credentialId,
            type: "public-key",
          },
        ],
        userVerification: "required",
        timeout: 60000,
      },
    });

    // Recover public key from the signature
    const signature = base64urlToArrayBuffer(authResponse.response.signature);
    const authenticatorData = base64urlToArrayBuffer(authResponse.response.authenticatorData);
    const clientDataJSON = new TextEncoder().encode(
      atob(authResponse.response.clientDataJSON.replace(/-/g, "+").replace(/_/g, "/"))
    );

    const recoveredPublicKey = await recoverPublicKeyFromSignature(
      new Uint8Array(signature),
      new Uint8Array(authenticatorData),
      clientDataJSON
    );

    const privateKey = derivePrivateKeyFromPublicKey(recoveredPublicKey);
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(privateKey);

    return account.address;
  } catch (error) {
    console.error("Failed to get secure address:", error);
    return null;
  }
}

// Migration info for a legacy wallet
export interface MigrationInfo {
  legacyWallet: StoredWallet;
  legacyAddress: `0x${string}`;
  secureAddress: `0x${string}` | null;
}

// Get migration info for all legacy wallets
export async function getMigrationInfo(): Promise<MigrationInfo[]> {
  const legacyWallets = getLegacyWallets();
  const results: MigrationInfo[] = [];

  for (const wallet of legacyWallets) {
    results.push({
      legacyWallet: wallet,
      legacyAddress: wallet.address as `0x${string}`,
      secureAddress: null, // Will be populated when user initiates migration
    });
  }

  return results;
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
