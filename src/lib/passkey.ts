import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import { bytesToHex } from "viem";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { formatAddress } from "./wallet";
import {
  getEncryptedKeyRecord,
  hasEncryptedKey,
  saveEncryptedKey,
  removeEncryptedKey,
} from "./keystore";

// WebAuthn PRF extension types. The @simplewebauthn/browser v13 DOM types do
// not declare `prf`, so we describe the shape we pass in and read back.
// simplewebauthn forwards `extensions` verbatim to the native call, so the
// eval salt must be raw bytes and the result comes back as an ArrayBuffer.
interface PrfExtensionOutput {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

// The bundled extension-input type lacks `prf`; simplewebauthn forwards the
// object verbatim to the native call, so we build it untyped and cast.
type WebAuthnExtensions = Parameters<
  typeof startAuthentication
>[0]["optionsJSON"]["extensions"];

// Types for our passkey-derived wallet
export interface PasskeyCredential {
  credentialId: string; // base64url format (original from WebAuthn)
  credentialIdHex: string; // hex format for key derivation
  publicKey: string;
  createdAt: number;
  username?: string;
  isImported?: boolean; // true if wallet was imported via private key
  index?: number; // active HD account index (0 = primary; absent means 0)
}

// How a wallet's key comes into existence. Recorded so a build/config change
// (wrong RP ID, changed derivation) is caught before a ceremony instead of
// silently opening a different, empty address.
export interface WalletDerivationMeta {
  rpId: string;
  derivation: "prf-hkdf-eoa-v2" | "imported-aes-gcm-v2";
  prfSaltV: 2;
}

export interface StoredWallet {
  credentialId: string;
  credentialIdHex: string;
  username: string;
  address: string;
  createdAt: number;
  isImported?: boolean; // true if wallet was imported via private key
  index?: number; // HD account index (0 = primary; absent means 0). Multiple
  // entries can share a credentialId, differing only by index+address.
  meta?: WalletDerivationMeta; // absent on entries created before mid-2026, backfilled on unlock
}

// The only wallet shape handed to the UI. Deliberately contains NO key
// material - React state must never hold a private key. Signing goes through
// src/lib/signer.ts, which scopes the key to a single ceremony.
export interface PublicWalletInfo {
  credentialId: string;
  credentialIdHex: string;
  address: `0x${string}`;
  username?: string;
  createdAt: number;
  isImported: boolean;
  index?: number; // HD account index (0 = primary)
}

// Storage keys
const CREDENTIAL_STORAGE_KEY = "punk_wallet_credential";
const WALLETS_LIST_KEY = "punk_wallet_list";

// The RP ID is misconfigured or missing. Passkeys are bound to the RP ID, so
// proceeding with a guessed value would create/unlock wallets on the wrong
// domain. This must surface loudly, never be treated as a cancelled prompt.
export class RpIdConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpIdConfigurationError";
  }
}

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

  const envRpId =
    typeof process !== "undefined"
      ? process.env?.NEXT_PUBLIC_PASSKEY_RP_ID
      : undefined;

  // Capacitor runs on localhost internally, so its hostname is never a valid
  // RP ID. Fail closed instead of silently binding passkeys to "localhost".
  if (isCapacitor) {
    if (envRpId) return envRpId;
    throw new RpIdConfigurationError(
      "NEXT_PUBLIC_PASSKEY_RP_ID is not set. The native app cannot derive a passkey domain from its internal origin - set the env var at build time."
    );
  }

  // For browser-based local development (not Capacitor), use localhost
  if (typeof window !== "undefined") {
    const hostname = window.location.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return hostname;
    }
  }

  // Use environment variable if set (for production web)
  if (envRpId) return envRpId;

  // Fail closed in production: a hostname-derived RP ID would silently bind
  // new passkeys to whatever domain happens to serve the app.
  if (process.env.NODE_ENV === "production") {
    throw new RpIdConfigurationError(
      "NEXT_PUBLIC_PASSKEY_RP_ID is not set. Production builds must pin the passkey domain explicitly."
    );
  }

  // Dev-only fallback to the current hostname
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

// Fixed application salt for the WebAuthn PRF evaluation. Must never change:
// rotating it would change the PRF output and thus every wallet address.
const PRF_SALT = new TextEncoder().encode(
  "PunkWallet-PRF-v2-eval-salt-do-not-change"
);

// HKDF info strings domain-separate the two secrets derived from the same
// PRF output (the wallet key and the imported-key encryption key).
const EOA_HKDF_INFO = new TextEncoder().encode("PunkWallet-EOA-v2");
const ENC_HKDF_INFO = new TextEncoder().encode("PunkWallet-Import-Encryption-v2");

// Root secret for the Kohaku privacy plugins (Railgun etc.). Independent of
// the EOA key by HKDF info separation - never change these strings, the
// user's shielded balances derive from them. Imported wallets derive from
// their EOA key instead of PRF so that re-importing the same key on another
// device recovers the same shielded accounts.
const KOHAKU_ROOT_INFO = new TextEncoder().encode("PunkWallet-Kohaku-Root-v1");
const KOHAKU_ROOT_IMPORTED_INFO = new TextEncoder().encode(
  "PunkWallet-Kohaku-Root-Imported-v1"
);

// Minimal hex-to-bytes for 0x-prefixed keys (avoids pulling viem utils here)
function hexKeyToBytes(hex: `0x${string}`): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Extension object passed to every registration/authentication ceremony
function prfExtensionInput(): WebAuthnExtensions {
  return { prf: { eval: { first: PRF_SALT } } } as unknown as WebAuthnExtensions;
}

// Pull the 32-byte PRF secret out of a ceremony's client extension results.
// Returns null when the authenticator/browser did not return PRF output.
function readPrfSecret(clientExtensionResults: unknown): Uint8Array | null {
  const first = (clientExtensionResults as PrfExtensionOutput)?.prf?.results
    ?.first;
  if (!first) return null;
  return new Uint8Array(first);
}

// Loud, specific error when PRF is unavailable. Callers must never fall back
// to any credential-ID-based derivation - that is the insecure scheme we
// removed.
class PrfUnsupportedError extends Error {
  constructor() {
    super(
      "This device or browser does not support the passkey PRF extension, which Punk Wallet needs to secure your key. Use a device with iOS 18+/Safari 18+ and iCloud Keychain, or a recent Chrome."
    );
    this.name = "PrfUnsupportedError";
  }
}

// Thrown when the user dismisses a passkey prompt (or the ceremony fails in a
// way indistinguishable from a cancel). Callers treat it as a no-op, unlike
// key-integrity or PRF-support errors, which must surface loudly.
export class UserCancelledError extends Error {
  constructor(cause?: unknown) {
    super("Passkey authentication was cancelled.", { cause });
    this.name = "UserCancelledError";
  }
}

// Derive the EOA private key from the PRF secret via HKDF-SHA256.
// The PRF secret is Input Keying Material, not used directly as the key.
//
// `index` selects an HD-style account. Index 0 uses the original info string,
// so the primary address is byte-identical to before this change and never
// moves. Indices > 0 are additional clean accounts (e.g. private-unshield
// destinations), domain-separated by an indexed info label.
function derivePrivateKeyFromPrf(
  prfSecret: Uint8Array,
  index = 0
): `0x${string}` {
  const info =
    index === 0
      ? EOA_HKDF_INFO
      : new TextEncoder().encode(`PunkWallet-EOA-v2:acct:${index}`);
  const key = hkdf(sha256, prfSecret, undefined, info, 32);
  return bytesToHex(key);
}

// Read the PRF secret from a ceremony result or throw the unsupported error
function requirePrfSecret(clientExtensionResults: unknown): Uint8Array {
  const secret = readPrfSecret(clientExtensionResults);
  if (!secret) throw new PrfUnsupportedError();
  return secret;
}

// Run an authentication ceremony for a specific credential purely to obtain
// its PRF secret. Used when create() did not return PRF output (some
// authenticators only expose PRF on get()). Costs one extra biometric prompt.
async function evaluatePrfForCredential(
  credentialId: string
): Promise<Uint8Array> {
  const challenge = generateChallenge();
  const result = await startAuthentication({
    optionsJSON: {
      challenge: bufferToBase64url(challenge.buffer as ArrayBuffer),
      rpId: getPasskeyRpId(),
      allowCredentials: [{ id: credentialId, type: "public-key" }],
      userVerification: "required",
      timeout: 60000,
      extensions: prfExtensionInput(),
    },
  });
  return requirePrfSecret(result.clientExtensionResults);
}

// Whether the current environment can do a WebAuthn ceremony at all. PRF
// support itself can only be confirmed by running a ceremony, so onboarding
// checks this and surfaces PrfUnsupportedError if the result lacks PRF.
export async function isWebAuthnAvailable(): Promise<boolean> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) {
    return false;
  }
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
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

// Metadata stamped on every wallet entry at create/import/recover time (and
// backfilled on unlock for older entries).
function buildDerivationMeta(imported: boolean): WalletDerivationMeta {
  return {
    rpId: getPasskeyRpId(),
    derivation: imported ? "imported-aes-gcm-v2" : "prf-hkdf-eoa-v2",
    prfSaltV: 2,
  };
}

// Pre-ceremony guard: if the stored wallet records the RP ID it was created
// under and the app is now configured for a different one, stop before the
// prompt. The post-derivation address check remains the ultimate gate; this
// just turns a confusing failure into an actionable message.
function assertRpIdMatchesStored(credentialId: string): void {
  const stored = getStoredWallets().find(
    (w) => w.credentialId === credentialId
  );
  const recordedRpId = stored?.meta?.rpId;
  if (!recordedRpId) return;
  const configured = getPasskeyRpId();
  if (recordedRpId !== configured) {
    throw new RpIdConfigurationError(
      `This wallet's passkey was created for "${recordedRpId}" but the app is configured for "${configured}". Unlocking is blocked - fix NEXT_PUBLIC_PASSKEY_RP_ID or use the original domain.`
    );
  }
}

// Stamp derivation metadata onto an existing list entry (no-op when present)
function backfillDerivationMeta(credentialId: string, imported: boolean): void {
  const wallets = getStoredWallets();
  const entry = wallets.find((w) => w.credentialId === credentialId);
  if (!entry || entry.meta) return;
  entry.meta = buildDerivationMeta(imported);
  localStorage.setItem(WALLETS_LIST_KEY, JSON.stringify(wallets));
}

// Save wallet to the list. Identity is (credentialId, index): one credential
// can hold several HD accounts, so a second index must not overwrite index 0.
export function saveWalletToList(wallet: StoredWallet): void {
  const wallets = getStoredWallets();
  const walletIndex = wallet.index ?? 0;
  const existingIndex = wallets.findIndex(
    (w) => w.credentialId === wallet.credentialId && (w.index ?? 0) === walletIndex
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

// Run one authentication ceremony and return its PRF secret plus the raw
// response. A cancelled/failed ceremony throws UserCancelledError; missing
// PRF output throws PrfUnsupportedError. Omitting credentialId uses
// discoverable-credential mode (browser shows all passkeys for this site).
async function authenticateForPrf(credentialId?: string): Promise<{
  prfSecret: Uint8Array;
  response: Awaited<ReturnType<typeof startAuthentication>>;
}> {
  const challenge = generateChallenge();
  let response: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    response = await startAuthentication({
      optionsJSON: {
        challenge: bufferToBase64url(challenge.buffer as ArrayBuffer),
        rpId: getPasskeyRpId(),
        ...(credentialId
          ? {
              allowCredentials: [
                { id: credentialId, type: "public-key" as const },
              ],
            }
          : {}),
        userVerification: "required",
        timeout: 60000,
        extensions: prfExtensionInput(),
      },
    });
  } catch (error) {
    // Configuration problems must never masquerade as a cancelled prompt
    if (error instanceof RpIdConfigurationError) throw error;
    console.error("Authentication failed:", error);
    throw new UserCancelledError(error);
  }
  return {
    prfSecret: requirePrfSecret(response.clientExtensionResults),
    response,
  };
}

// The single choke point through which key material flows. Runs one passkey
// ceremony, resolves and verifies the key, hands it to `fn`, and wipes the
// PRF secret afterwards. The hex key itself is an immutable JS string and
// cannot be zeroed - confining it to this scope bounds its lifetime, it is
// not a memory-erasure guarantee.
async function withKeyForCredential<T>(
  opts: {
    credentialId: string;
    isImportedHint?: boolean;
    expectedAddress?: string;
    // HD account index. 0 (default) is the primary account. The Kohaku
    // privacy root is always derived from the credential's index-0 identity,
    // so a derived account is a clean public destination, not its own 0zk
    // account.
    index?: number;
  },
  fn: (key: {
    privateKey: `0x${string}`;
    address: `0x${string}`;
    // Derives the Kohaku privacy root secret. Valid ONLY while fn runs -
    // the closure is disarmed in the same finally that wipes the PRF secret.
    // Callers own the returned bytes and must wipe them when done.
    deriveKohakuRoot: () => Uint8Array;
  }) => Promise<T>
): Promise<T> {
  const imported = await isImportedCredential(
    opts.credentialId,
    opts.isImportedHint
  );
  assertRpIdMatchesStored(opts.credentialId);
  const { prfSecret } = await authenticateForPrf(opts.credentialId);
  let boundaryOpen = true;
  try {
    const resolved = await resolveKeyForCredential(
      opts.credentialId,
      prfSecret,
      imported,
      opts.expectedAddress,
      opts.index ?? 0
    );
    const deriveKohakuRoot = (): Uint8Array => {
      if (!boundaryOpen) {
        throw new Error(
          "deriveKohakuRoot called outside the passkey ceremony boundary."
        );
      }
      if (imported) {
        const keyBytes = hexKeyToBytes(resolved.privateKey);
        try {
          return hkdf(sha256, keyBytes, undefined, KOHAKU_ROOT_IMPORTED_INFO, 32);
        } finally {
          keyBytes.fill(0);
        }
      }
      return hkdf(sha256, prfSecret, undefined, KOHAKU_ROOT_INFO, 32);
    };
    return await fn({ ...resolved, deriveKohakuRoot });
  } finally {
    boundaryOpen = false;
    prfSecret.fill(0);
  }
}

/**
 * Escape hatch for the signer boundary. The ONLY sanctioned importer is
 * src/lib/signer.ts (enforced via no-restricted-imports in eslint.config.mjs).
 * The key must never be stored, put into React state, or otherwise outlive
 * `fn`. Every call costs one passkey ceremony - that is the point.
 */
export async function unsafeWithSessionKey<T>(
  target: {
    credentialId: string;
    isImported?: boolean;
    address?: `0x${string}`;
    index?: number;
  },
  fn: (privateKey: `0x${string}`, address: `0x${string}`) => Promise<T>
): Promise<T> {
  return withKeyForCredential(
    {
      credentialId: target.credentialId,
      isImportedHint: target.isImported,
      expectedAddress: target.address,
      index: target.index,
    },
    ({ privateKey, address }) => fn(privateKey, address)
  );
}

/**
 * Like unsafeWithSessionKey but additionally exposes deriveKohakuRoot so the
 * signer can hand the privacy root secret to the Kohaku session module. Same
 * rules and same ONLY sanctioned importer, src/lib/signer.ts (enforced via
 * no-restricted-imports in eslint.config.mjs). The derived root must go
 * straight into the kohakuSession module, never React state.
 */
export async function unsafeWithSessionSecrets<T>(
  target: {
    credentialId: string;
    isImported?: boolean;
    address?: `0x${string}`;
    index?: number;
  },
  fn: (key: {
    privateKey: `0x${string}`;
    address: `0x${string}`;
    deriveKohakuRoot: () => Uint8Array;
  }) => Promise<T>
): Promise<T> {
  return withKeyForCredential(
    {
      credentialId: target.credentialId,
      isImportedHint: target.isImported,
      expectedAddress: target.address,
      index: target.index,
    },
    fn
  );
}

// Create a new wallet: one registration ceremony, derive the address from the
// registration's PRF output (or one follow-up get() ceremony on
// authenticators that only expose PRF on get()). Returns no key material.
export async function createWalletWithPasskey(
  username: string
): Promise<PublicWalletInfo> {
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
      extensions: prfExtensionInput(),
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

  // Derive the address from the PRF secret. Some authenticators do not return
  // PRF output on create(), so fall back to an immediate get() ceremony.
  // The derived key exists only inside this block.
  const prfSecret =
    readPrfSecret(registrationResponse.clientExtensionResults) ??
    (await evaluatePrfForCredential(credential.credentialId));
  let address: `0x${string}`;
  try {
    const privateKey = derivePrivateKeyFromPrf(prfSecret);
    const { privateKeyToAccount } = await import("viem/accounts");
    address = privateKeyToAccount(privateKey).address;
  } finally {
    prfSecret.fill(0);
  }

  // Save to wallets list
  saveWalletToList({
    credentialId: credential.credentialId,
    credentialIdHex: credential.credentialIdHex,
    username,
    address,
    createdAt: credential.createdAt,
    meta: buildDerivationMeta(false),
  });

  // Store current credential
  localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));

  return {
    credentialId: credential.credentialId,
    credentialIdHex: credential.credentialIdHex,
    address,
    username,
    createdAt: credential.createdAt,
    isImported: false,
  };
}

// Authenticate with the current (stored) credential. Returns only public
// wallet info - no key material. Cancelled prompts return null to preserve
// the existing unlock UX; decryption, integrity, and PRF-support errors
// deliberately throw so the UI shows the real reason.
export async function unlockCurrentWallet(options?: {
  // Invoked inside the unlock ceremony so app-open auth doubles as privacy-
  // key derivation (no extra biometric prompt). Receiver owns the bytes.
  onKohakuRoot?: (root: Uint8Array) => void;
}): Promise<PublicWalletInfo | null> {
  const stored = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  const credential: PasskeyCredential = JSON.parse(stored);
  const activeIndex = credential.index ?? 0;
  const storedWallet = getStoredWallets().find(
    (w) =>
      w.credentialId === credential.credentialId && (w.index ?? 0) === activeIndex
  );
  const imported = await isImportedCredential(
    credential.credentialId,
    credential.isImported
  );

  let address: `0x${string}`;
  try {
    address = await withKeyForCredential(
      {
        credentialId: credential.credentialId,
        isImportedHint: imported,
        expectedAddress: storedWallet?.address,
        index: activeIndex,
      },
      async (key) => {
        options?.onKohakuRoot?.(key.deriveKohakuRoot());
        return key.address;
      }
    );
  } catch (error) {
    if (error instanceof UserCancelledError) return null;
    throw error;
  }

  // Self-heal older credential blobs saved without the isImported flag
  const resolvedCredential: PasskeyCredential = {
    ...credential,
    isImported: imported,
  };
  localStorage.setItem(
    CREDENTIAL_STORAGE_KEY,
    JSON.stringify(resolvedCredential)
  );
  backfillDerivationMeta(credential.credentialId, imported);

  return {
    credentialId: credential.credentialId,
    credentialIdHex: credential.credentialIdHex,
    address,
    username: credential.username,
    createdAt: credential.createdAt,
    isImported: imported,
    index: activeIndex,
  };
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
export async function recoverWalletInfo(): Promise<{
  info: PublicWalletInfo;
  alreadyExisted: boolean;
} | null> {
  let authResponse: Awaited<ReturnType<typeof startAuthentication>>;
  let prfSecret: Uint8Array;
  try {
    // No credentialId = discoverable mode, browser shows all passkeys
    ({ prfSecret, response: authResponse } = await authenticateForPrf());
  } catch (error) {
    if (error instanceof UserCancelledError) return null;
    throw error;
  }

  // Get the credential ID from the response
  const credentialId = authResponse.id;
  const credentialIdHex = base64urlToHex(credentialId);

  // Check if wallet already exists in local storage
  const wallets = getStoredWallets();
  const existingWallet = wallets.find((w) => w.credentialId === credentialId);
  const alreadyExisted = !!existingWallet;

  // Imported passkeys were registered with user.id "import-{address}-{timestamp}",
  // so they are detectable via userHandle even on a device with no local data.
  // The full pattern (not just the "import-" prefix) must match, because
  // regular wallets store "{username}-{timestamp}" and a username can
  // legitimately be "import".
  let decodedHandle: string | undefined;
  try {
    decodedHandle = authResponse.response.userHandle
      ? base64urlToString(authResponse.response.userHandle)
      : undefined;
  } catch {
    decodedHandle = undefined;
  }
  const importHandleMatch = decodedHandle?.match(
    /^import-(0x[0-9a-fA-F]{40})-\d+$/
  );
  const handleIsImport = !!importHandleMatch;
  const importAddress = importHandleMatch?.[1];
  const imported =
    (await isImportedCredential(credentialId, existingWallet?.isImported)) ||
    handleIsImport;

  let address: `0x${string}`;
  try {
    // An imported wallet's key only exists as an encrypted blob on the device
    // that imported it. Never fall through to derivation - that would open a
    // different, empty address.
    if (imported && !(await hasEncryptedKey(credentialId))) {
      const shortAddress = importAddress
        ? ` (${formatAddress(importAddress)})`
        : "";
      throw new Error(
        `This passkey belongs to an imported wallet${shortAddress}. Its key cannot be recovered from the passkey alone. Re-import the private key on this device.`
      );
    }

    ({ address } = await resolveKeyForCredential(
      credentialId,
      prfSecret,
      imported,
      existingWallet?.address ?? importAddress
    ));
  } finally {
    prfSecret.fill(0);
  }

  // Try to get username from multiple sources:
  // 1. First try the passkey's userHandle (most reliable for cross-device recovery)
  // 2. Fall back to local storage if available
  let username: string | undefined;

  // The userHandle in the auth response contains the user.id from registration
  // which was set to "username-timestamp" ("import-{address}-{timestamp}" is
  // an internal marker, not a display name)
  if (!handleIsImport) {
    username = extractUsernameFromUserHandle(authResponse.response.userHandle);
  }

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
    isImported: imported,
  };

  // Save as current credential
  localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));

  // Only add to wallets list if it doesn't already exist
  if (!alreadyExisted) {
    saveWalletToList({
      credentialId,
      credentialIdHex,
      username: username || (imported ? "Imported Wallet" : "Recovered Wallet"),
      address,
      createdAt: Date.now(),
      isImported: imported,
      meta: buildDerivationMeta(imported),
    });
  } else {
    backfillDerivationMeta(credentialId, imported);
  }

  return {
    info: {
      credentialId,
      credentialIdHex,
      address,
      username,
      createdAt: credential.createdAt,
      isImported: imported,
    },
    alreadyExisted,
  };
}

// Authenticate with a specific stored wallet (derived or imported - one
// ceremony either way). Returns only public wallet info, no key material.
// Cancelled prompts return null; integrity/decryption errors throw.
export async function unlockWallet(
  storedWallet: StoredWallet,
  options?: {
    // Same contract as unlockCurrentWallet's hook
    onKohakuRoot?: (root: Uint8Array) => void;
  }
): Promise<PublicWalletInfo | null> {
  const imported = await isImportedCredential(
    storedWallet.credentialId,
    storedWallet.isImported
  );

  const accountIndex = storedWallet.index ?? 0;
  let address: `0x${string}`;
  try {
    address = await withKeyForCredential(
      {
        credentialId: storedWallet.credentialId,
        isImportedHint: imported,
        expectedAddress: storedWallet.address,
        index: accountIndex,
      },
      async (key) => {
        options?.onKohakuRoot?.(key.deriveKohakuRoot());
        return key.address;
      }
    );
  } catch (error) {
    if (error instanceof UserCancelledError) return null;
    throw error;
  }

  // Save as current credential, remembering which HD account is active
  const credential: PasskeyCredential = {
    credentialId: storedWallet.credentialId,
    credentialIdHex: storedWallet.credentialIdHex,
    publicKey: storedWallet.credentialIdHex,
    createdAt: storedWallet.createdAt,
    username: storedWallet.username,
    isImported: imported,
    index: accountIndex,
  };
  localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));
  backfillDerivationMeta(storedWallet.credentialId, imported);

  return {
    credentialId: storedWallet.credentialId,
    credentialIdHex: storedWallet.credentialIdHex,
    address,
    username: storedWallet.username,
    createdAt: storedWallet.createdAt,
    isImported: imported,
    index: accountIndex,
  };
}

// Create a new HD-derived account under the current passkey credential. One
// ceremony derives the next free index's address (no key retained), then a
// StoredWallet entry is saved. Used for clean private-unshield destinations.
// Only prf-derived credentials support this (imported wallets hold a single
// stored key with no HD indices).
export async function createDerivedAccount(
  credentialId: string,
  username?: string
): Promise<PublicWalletInfo | null> {
  if (await isImportedCredential(credentialId)) {
    throw new Error(
      "Imported wallets cannot derive additional accounts (they have a single stored key)."
    );
  }
  const wallets = getStoredWallets();
  const forCredential = wallets.filter((w) => w.credentialId === credentialId);
  if (forCredential.length === 0) {
    throw new Error("No account found for this passkey.");
  }
  const primary = forCredential.find((w) => (w.index ?? 0) === 0) ?? forCredential[0];
  const nextIndex =
    Math.max(...forCredential.map((w) => w.index ?? 0)) + 1;

  let address: `0x${string}`;
  try {
    address = await withKeyForCredential(
      { credentialId, isImportedHint: false, index: nextIndex },
      async (key) => key.address
    );
  } catch (error) {
    if (error instanceof UserCancelledError) return null;
    throw error;
  }

  const name = username || `${primary.username || "Account"} ${nextIndex + 1}`;
  saveWalletToList({
    credentialId,
    credentialIdHex: primary.credentialIdHex,
    username: name,
    address,
    createdAt: Date.now(),
    index: nextIndex,
    meta: buildDerivationMeta(false),
  });

  return {
    credentialId,
    credentialIdHex: primary.credentialIdHex,
    address,
    username: name,
    createdAt: Date.now(),
    isImported: false,
    index: nextIndex,
  };
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
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
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
  } catch (error) {
    // Only ceremony failures/cancels map to false; everything after a
    // successful auth throws with its real message.
    if (error instanceof RpIdConfigurationError) throw error;
    console.error("Delete authentication failed:", error);
    return false;
  }

  // For imported wallets, delete the encrypted key blob FIRST. If the
  // Keychain delete fails this throws, keeping the wallet metadata intact
  // so the user can retry - never orphan a Keychain secret that no metadata
  // points at.
  const imported = await isImportedCredential(
    storedWallet.credentialId,
    storedWallet.isImported
  );
  if (imported) {
    await removeEncryptedKey(storedWallet.credentialId);
  }

  // Blob gone (or derived wallet) - now remove the metadata
  removeWalletFromList(storedWallet.credentialId);

  const currentCredential = getStoredCredential();
  if (currentCredential?.credentialId === storedWallet.credentialId) {
    clearStoredCredential();
  }

  return true;
}

// Derive an AES-GCM encryption key from the PRF secret (domain-separated from
// the wallet key by the HKDF info string). Imported wallets encrypt their
// private key under this so the ciphertext is bound to the passkey secret.
async function deriveEncryptionKey(prfSecret: Uint8Array): Promise<CryptoKey> {
  const keyBytes = hkdf(sha256, prfSecret, undefined, ENC_HKDF_INFO, 32);
  // Copy into a standalone ArrayBuffer for crypto.subtle
  const keyBuffer = keyBytes.slice().buffer;
  keyBytes.fill(0);

  try {
    return await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  } finally {
    new Uint8Array(keyBuffer).fill(0);
  }
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

// Decrypt the AES-GCM-stored private key for an imported wallet.
// Throws (never returns null) so callers surface a specific, loud error
// instead of falling back to a derived key.
async function decryptImportedPrivateKey(
  credentialId: string,
  prfSecret: Uint8Array
): Promise<`0x${string}`> {
  const encryptedData = await getEncryptedKeyRecord(credentialId);
  if (!encryptedData) {
    throw new Error(
      "This wallet was imported from a private key, but its encrypted key is not on this device. Re-import the private key to restore it."
    );
  }

  const encryptionKey = await deriveEncryptionKey(prfSecret);
  const privateKey = await decryptPrivateKey(
    encryptedData.iv,
    encryptedData.ciphertext,
    encryptionKey
  );
  return privateKey as `0x${string}`;
}

// Resolve key material after a passkey ceremony. Imported wallets must
// decrypt their stored key - deriving from the credential ID would silently
// produce a different (empty) address. When the expected address is known,
// a mismatch fails loudly rather than opening the wrong wallet.
async function resolveKeyForCredential(
  credentialId: string,
  prfSecret: Uint8Array,
  isImported: boolean,
  expectedAddress?: string,
  index = 0
): Promise<{ privateKey: `0x${string}`; address: `0x${string}` }> {
  // Imported wallets have a single stored key and no HD indices; only the
  // prf-derived path supports index > 0.
  const privateKey = isImported
    ? await decryptImportedPrivateKey(credentialId, prfSecret)
    : derivePrivateKeyFromPrf(prfSecret, index);

  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(privateKey);

  if (
    expectedAddress &&
    expectedAddress.toLowerCase() !== account.address.toLowerCase()
  ) {
    // Lead with the actionable part - the global error toast clamps long
    // messages, so the warning must survive truncation
    throw new Error(
      `Wallet integrity check failed. Do not send funds. The unlocked key does not match the stored address ${formatAddress(expectedAddress)}. Unlock from the wallet list or re-import the private key.`
    );
  }

  return { privateKey, address: account.address };
}

// Single source of truth for "is this credential an imported wallet?".
// The encrypted-keys check covers credential blobs saved before the
// isImported flag was written consistently everywhere.
async function isImportedCredential(
  credentialId: string,
  hint?: boolean
): Promise<boolean> {
  if (hint === true) return true;
  const stored = getStoredWallets().find(
    (w) => w.credentialId === credentialId
  );
  if (stored?.isImported) return true;
  return hasEncryptedKey(credentialId);
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

// Import wallet from private key - creates a passkey and encrypts the
// imported key. The plaintext key exists only inside this function; the
// caller gets back public wallet info only.
export async function importWalletFromPrivateKey(
  privateKey: string,
  username: string
): Promise<PublicWalletInfo | null> {
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
        extensions: prfExtensionInput(),
      },
    });

    const credentialId = registrationResponse.id;
    const credentialIdHex = base64urlToHex(credentialId);

    // Step 2: Derive the AES encryption key from the passkey's PRF secret
    // (fall back to a get() ceremony if create() returned no PRF output)
    const prfSecret =
      readPrfSecret(registrationResponse.clientExtensionResults) ??
      (await evaluatePrfForCredential(credentialId));
    let iv: string;
    let ciphertext: string;
    try {
      const encryptionKey = await deriveEncryptionKey(prfSecret);
      // Step 3: Encrypt the imported private key
      ({ iv, ciphertext } = await encryptPrivateKey(
        normalizedKey,
        encryptionKey
      ));
    } finally {
      prfSecret.fill(0);
    }

    // Step 4: Store the encrypted key
    await saveEncryptedKey(credentialId, { iv, ciphertext });

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
      meta: buildDerivationMeta(true),
    });

    // Store current credential
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));

    return {
      credentialId,
      credentialIdHex,
      address: account.address,
      username,
      createdAt: credential.createdAt,
      isImported: true,
    };
  } catch (error) {
    // Hard errors must surface with their real message, not a generic
    // "check the private key" hint
    if (
      error instanceof RpIdConfigurationError ||
      error instanceof PrfUnsupportedError
    ) {
      throw error;
    }
    console.error("Import wallet failed:", error);
    return null;
  }
}

// Enhanced remove that also cleans up encrypted keys
export async function removeWalletFromListWithCleanup(
  credentialId: string
): Promise<void> {
  removeWalletFromList(credentialId);
  await removeEncryptedKey(credentialId);
}
