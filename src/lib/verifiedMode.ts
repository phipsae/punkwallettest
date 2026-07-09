// Verified mode: route reads through the Colibri light client so RPC
// responses are checked against Ethereum consensus (sync-committee proofs)
// instead of trusted. Integrity only, not privacy, the RPC still sees which
// addresses are queried.
//
// Mainnet only: L2s have no sync committees, so a light client there would
// only verify the sequencer's signature (swapping one trusted party for
// another). Opt-in, gated, and degrades to plain RPC on any failure.

import { getRpcUrl } from "./wallet";

const VERIFIED_MODE_KEY = "punk_wallet_verified_mode";

// A consensus (beacon) API is required for the light client to follow the
// sync committee. Alchemy execution RPCs do not serve beacon data.
const BEACON_API_URL = process.env.NEXT_PUBLIC_BEACON_API_URL || "";

export function isVerifiedModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(VERIFIED_MODE_KEY) === "true";
}

export function setVerifiedModeEnabled(enabled: boolean): void {
  localStorage.setItem(VERIFIED_MODE_KEY, enabled ? "true" : "false");
}

export function isVerifiedModeConfigured(): boolean {
  return Boolean(BEACON_API_URL);
}

export type VerifiedStatus = "off" | "syncing" | "synced" | "unavailable";

let currentStatus: VerifiedStatus = "off";
let statusListeners: Array<(s: VerifiedStatus) => void> = [];

export function getVerifiedStatus(): VerifiedStatus {
  return currentStatus;
}

export function onVerifiedStatus(fn: (s: VerifiedStatus) => void): () => void {
  statusListeners.push(fn);
  return () => {
    statusListeners = statusListeners.filter((f) => f !== fn);
  };
}

function setStatus(s: VerifiedStatus): void {
  currentStatus = s;
  for (const fn of statusListeners) fn(s);
}

// Build a Colibri-backed EthereumProvider for the Kohaku Host. Returns null
// (and marks status "unavailable") if verified mode is off, unconfigured,
// not on mainnet, or the client fails to initialize. Callers fall back to the
// plain viem provider.
export async function createVerifiedProvider(
  networkId: string,
  chainId: number
): Promise<unknown | null> {
  if (!isVerifiedModeEnabled()) {
    setStatus("off");
    return null;
  }
  if (chainId !== 1 || !isVerifiedModeConfigured()) {
    setStatus("unavailable");
    return null;
  }
  try {
    setStatus("syncing");
    const { colibri } = await import("@kohaku-eth/provider/colibri");
    const provider = await colibri({
      chainId: 1,
      beacon_apis: [BEACON_API_URL],
      rpcs: [getRpcUrl(networkId)],
    } as Parameters<typeof colibri>[0]);
    setStatus("synced");
    return provider;
  } catch (e) {
    console.error("Verified mode init failed, falling back to RPC", e);
    setStatus("unavailable");
    return null;
  }
}
