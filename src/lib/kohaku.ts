// Kohaku privacy plugin registry. THE ONLY FILE that may import
// @kohaku-eth/* packages - the SDKs are unaudited alphas and every upgrade
// is a deliberate migration, confining them here keeps that to one file.
//
// Lifecycle mirrors walletconnect.ts: module-scoped singletons, re-init on
// wallet/network change, explicit availability gating (iOS 17 IndexedDB
// bug), degraded state instead of crashes.
//
// The UI talks only to the protocol-agnostic wrappers at the bottom, plugin
// objects and SDK types never reach React state.

import { encodeFunctionData, erc20Abi } from "viem";
import { viem as viemProviderAdapter } from "@kohaku-eth/provider/viem";
import type { Host } from "@kohaku-eth/plugins";
// Privacy Pools pulls in snarkjs/ffjavascript, which JIT field arithmetic via
// `new Function` at module-eval time. Importing it statically would (a) load
// that whole stack on every page view and (b) trip the CSP at startup and
// brick the wallet. So we keep only the types here and import the values
// lazily inside initPrivacy. Same rationale as the Railgun dynamic import.
import type { PPv1Instance, PPv1Broadcaster } from "@kohaku-eth/privacy-pools";

// Native-asset sentinel used by Privacy Pools (mirrors its exported
// E_ADDRESS; inlined to avoid a static import of the PP module).
const E_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
import {
  createPublicClientForNetwork,
  createPrivacyPublicClientForNetwork,
  getAllNetworks,
} from "./wallet";
import { getTokensForNetwork, type Token } from "./tokens";
import {
  deriveAtFromSession,
  isKohakuUnlocked,
  getEnabledProtocols,
  type KohakuProtocolId,
} from "./kohakuSession";
import {
  checkKohakuIdbAvailable,
  createHostStorage,
} from "./kohakuStorage";
import { createVerifiedProvider } from "./verifiedMode";

export type ProtocolId = KohakuProtocolId;

// Pimlico 4337 bundler for private Railgun transfers (0zk -> 0zk). Without it,
// private send is unavailable (self-broadcasting a transfer would link the
// EOA, defeating the purpose).
const PIMLICO_API_KEY = process.env.NEXT_PUBLIC_PIMLICO_API_KEY || "";
function pimlicoUrl(chainId: number): string {
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${PIMLICO_API_KEY}`;
}
export function isRailgunPrivateSendAvailable(): boolean {
  return Boolean(PIMLICO_API_KEY) && state?.railgun != null;
}

// Kohaku's Railgun crate ships chain configs for mainnet and Sepolia only.
// Privacy Pools v1 covers the same two chains.
export const PRIVACY_SUPPORTED_CHAIN_IDS = [1, 11155111];

export function getAvailableProtocols(): ProtocolId[] {
  const protocols: ProtocolId[] = ["railgun"];
  // Privacy Pools scans events over wide archive block ranges, which needs an
  // archive-capable RPC. Without one it only errors, so don't offer it.
  if (process.env.NEXT_PUBLIC_PRIVACY_RPC_URL) protocols.push("privacy-pools");
  return protocols;
}

export function getChainIdForNetwork(networkId: string): number | null {
  const chain = getAllNetworks()[networkId];
  return chain?.id ?? null;
}

export function isPrivacySupportedNetwork(networkId: string): boolean {
  const chainId = getChainIdForNetwork(networkId);
  return chainId !== null && PRIVACY_SUPPORTED_CHAIN_IDS.includes(chainId);
}

// ---------------------------------------------------------------------------
// Shared UI-facing shapes (no SDK types)

export type PreparedTx = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
};

export type PrivateBalanceRow = {
  protocol: ProtocolId;
  symbol: string;
  decimals: number;
  // null = native ETH (Railgun internally tracks it as wrapped base token)
  contract: `0x${string}` | null;
  spendable: bigint;
  pending: bigint;
  pendingLabel?: string;
  noteCount?: number;
};

export type PreparedShield = {
  protocol: ProtocolId;
  // Signed and sent in order by the wallet EOA (approve first when needed)
  txs: PreparedTx[];
};

// Unshielding takes one of two shapes depending on the protocol:
// - self-broadcast (Railgun): the wallet EOA signs and submits the proved
//   transactions itself. Links the EOA on-chain, fine for withdraw-to-self.
// - relayed (Privacy Pools): a relayer submits, so no EOA signature and no
//   EOA link. The registry owns the network call.
export type PreparedUnshield = {
  protocol: ProtocolId;
  feeNote?: string;
  selfBroadcast?: {
    txs: PreparedTx[];
    // Railgun native unshields deliver WETH; this unwraps it (only when the
    // destination is the wallet's own address)
    unwrapTx?: PreparedTx;
  };
  relayed?: {
    // Submits via the protocol's relayer. No passkey prompt (no EOA signing).
    broadcast: () => Promise<void>;
  };
};

// A public exit from a pending Privacy Pools deposit (ASP never approved it).
// De-anonymizing by design: funds return to the depositing address.
export type PreparedRagequit = {
  txs: PreparedTx[];
};

export class PrivacyInitError extends Error {
  constructor(
    message: string,
    public readonly reason: "unsupported-network" | "locked" | "storage" | "init-failed"
  ) {
    super(message);
    this.name = "PrivacyInitError";
  }
}

// ---------------------------------------------------------------------------
// Wasm + module init

// The Railgun prover downloads its SNARK artifacts at proof time from a host
// baked into the wasm: `github.com/<owner>/<repo>/raw/<ref>/<path>`. That URL
// 302-redirects to raw.githubusercontent.com, but the redirect response
// carries no valid `access-control-allow-origin`, so a cross-origin browser
// fetch is blocked on the redirect hop and reqwest reports it as the opaque
// "Artifact loader error: HTTP error: error sending request". Rewriting to the
// redirect target up front skips the bad hop; raw.githubusercontent.com serves
// the files directly with `access-control-allow-origin: *`.
const GH_RAW_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/raw\/(.+)$/;
function rewriteGithubRaw(url: string): string {
  const m = GH_RAW_RE.exec(url);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}` : url;
}
let fetchShimInstalled = false;
function installGithubRawFetchShim(): void {
  if (fetchShimInstalled || typeof globalThis.fetch !== "function") return;
  fetchShimInstalled = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" || input instanceof URL) {
      const rewritten = rewriteGithubRaw(input.toString());
      return original(rewritten, init);
    }
    const rewritten = rewriteGithubRaw(input.url);
    return rewritten === input.url
      ? original(input, init)
      : original(new Request(rewritten, input), init);
  }) as typeof globalThis.fetch;
}

async function ensureRailgunWasm(logLevel?: string): Promise<
  typeof import("@kohaku-eth/railgun")
> {
  installGithubRawFetchShim();
  const railgun = await import("@kohaku-eth/railgun");
  // CRITICAL: initialize with an explicit wasm source. The SDK's own
  // ensureInitialized(undefined) takes a Node fs branch in the browser
  // (Next defines `process`) and crashes. This call wins the memoized
  // init race, making the SDK's internal call a no-op.
  const wasmUrl = new URL("@kohaku-railgun-wasm", import.meta.url);
  await railgun.ensureInitialized(
    await fetch(wasmUrl),
    (logLevel ?? "Off") as Parameters<typeof railgun.ensureInitialized>[1]
  );
  return railgun;
}

// ---------------------------------------------------------------------------
// Registry state

type RailgunPluginInstance = Awaited<
  ReturnType<typeof import("@kohaku-eth/railgun").createRailgunPlugin>
>;

type RegistryState = {
  credentialId: string;
  networkId: string;
  chainId: number;
  railgun: RailgunPluginInstance | null;
  railgunWrappedBase: `0x${string}` | null;
  railgunUnshieldFeeBps: number;
  privacyPools: PPv1Instance | null;
  privacyPoolsBroadcaster: PPv1Broadcaster | null;
};

// The 0xbow relayer that submits Privacy Pools withdrawals. Overridable, no
// public default is documented, so withdraw stays gated until it is set.
const PRIVACY_POOLS_RELAYER_URL =
  process.env.NEXT_PUBLIC_PRIVACY_POOLS_RELAYER_URL || "";

let state: RegistryState | null = null;
let initPromise: Promise<RegistryState> | null = null;
// Bumped by resetPrivacy so an in-flight init can't assign `state` after a
// lock/wallet-switch invalidated it
let initGeneration = 0;
let idbAvailable: boolean | null = null;
let lastInitError: string | null = null;

// The plugins wrap wasm-bindgen objects (Railgun especially) that panic with
// "recursive use of an object" if two async methods run on the same instance
// concurrently. React dev double-invokes effects and balance() syncs
// internally, so overlaps are easy to hit. Serialize every plugin call
// through one queue.
let opQueue: Promise<unknown> = Promise.resolve();
function withPluginLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opQueue.then(fn, fn);
  // Keep the chain alive regardless of individual failures
  opQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function resetPrivacy(): void {
  state = null;
  initPromise = null;
  initGeneration++;
  lastInitError = null;
  // Drop any proved-but-unbroadcast ops so they can't be broadcast by a
  // different wallet after a lock/switch.
  pendingTransferOp = null;
  pendingUnshieldOp = null;
}

export function getPrivacyInitError(): string | null {
  return lastInitError;
}

export function isPrivacyReady(credentialId: string, networkId: string): boolean {
  return (
    state !== null &&
    state.credentialId === credentialId &&
    state.networkId === networkId
  );
}

// Gas units a relayed Railgun unshield UserOp burns (Groth16 verification
// dominates). Back-solved from an observed Sepolia repayment (~1.55M units);
// only used for pre-flight UX math, the wasm computes the binding number at
// broadcast.
const RELAYED_UNSHIELD_GAS_UNITS = BigInt(1_600_000);

// What the privacy paymaster will deduct from the shielded balance to repay
// its gas, estimated from the bundler's current fast gas price plus a 25%
// margin. Null when no bundler is configured or the quote fails.
export async function estimateRelayedGasRepayment(): Promise<bigint | null> {
  const s = state;
  if (!s || !PIMLICO_API_KEY) return null;
  try {
    const res = await fetch(pimlicoUrl(s.chainId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "pimlico_getUserOperationGasPrice",
        params: [],
      }),
    });
    const json = (await res.json()) as {
      result?: { fast?: { maxFeePerGas?: string } };
    };
    const maxFee = BigInt(json?.result?.fast?.maxFeePerGas ?? 0);
    if (maxFee <= BigInt(0)) return null;
    return (maxFee * RELAYED_UNSHIELD_GAS_UNITS * BigInt(125)) / BigInt(100);
  } catch {
    return null;
  }
}

// What actually leaves the shielded balance for an unshield of `amount`: the
// protocol fee is added on top so the destination receives `amount` exactly.
export function unshieldCost(amount: bigint): bigint {
  const feeBps = BigInt(state?.railgunUnshieldFeeBps ?? 25);
  return (amount * BigInt(10000)) / (BigInt(10000) - feeBps);
}

// Largest amount that can be unshielded in one go. A Railgun unshield also
// costs the protocol fee (feeBps, added on top of the withdrawn amount), and
// the relayed/clean path additionally repays the paymaster's gas out of the
// shielded balance. So unshielding the full spendable always fails. Pass the
// estimateRelayedGasRepayment() quote as `gasRepayment` for the relayed path.
export function maxUnshieldAmount(
  row: PrivateBalanceRow,
  gasRepayment: bigint | null = null
): bigint {
  const feeBps = BigInt(state?.railgunUnshieldFeeBps ?? 25);
  const available = row.spendable - (gasRepayment ?? BigInt(0));
  if (available <= BigInt(0)) return BigInt(0);
  // Reserve the protocol fee: max V with V + V*feeBps/(10000-feeBps) <= available.
  return (available * (BigInt(10000) - feeBps)) / BigInt(10000);
}

function buildHost(
  credentialId: string,
  networkId: string,
  protocol: ProtocolId,
  // A verified (light-client) provider to use instead of the plain viem one
  verifiedProvider?: unknown | null
): Host {
  // Privacy sync does wide eth_getLogs; use the log-friendly RPC client
  const publicClient = createPrivacyPublicClientForNetwork(networkId);
  return {
    network: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    },
    storage: createHostStorage(credentialId, protocol),
    keystore: {
      deriveAt: (path: string) => deriveAtFromSession(protocol, path),
    },
    provider:
      (verifiedProvider as Host["provider"] | null) ??
      viemProviderAdapter(publicClient),
  };
}

/**
 * Initialize (or re-initialize) the privacy plugins for the given wallet and
 * network. Idempotent per (credentialId, networkId). Only instantiates the
 * plugins whose protocols the user has enabled.
 */
export async function initPrivacy(
  credentialId: string,
  networkId: string
): Promise<void> {
  if (isPrivacyReady(credentialId, networkId)) return;

  if (!isPrivacySupportedNetwork(networkId)) {
    throw new PrivacyInitError(
      "Privacy features are only available on Ethereum mainnet.",
      "unsupported-network"
    );
  }
  if (!isKohakuUnlocked(credentialId)) {
    throw new PrivacyInitError(
      "Privacy session is locked. Unlock the wallet first.",
      "locked"
    );
  }
  if (idbAvailable === null) {
    idbAvailable = await checkKohakuIdbAvailable();
  }
  if (!idbAvailable) {
    throw new PrivacyInitError(
      "Private balances are unavailable on this device (storage unavailable).",
      "storage"
    );
  }

  if (!initPromise) {
    const generation = ++initGeneration;
    initPromise = (async () => {
      const enabled = getEnabledProtocols(credentialId);
      const chainId = getChainIdForNetwork(networkId)!;
      const next: RegistryState = {
        credentialId,
        networkId,
        chainId,
        railgun: null,
        railgunWrappedBase: null,
        railgunUnshieldFeeBps: 25,
        privacyPools: null,
        privacyPoolsBroadcaster: null,
      };

      // Each protocol initializes independently: one plugin failing must not
      // take down the others.
      const failures: string[] = [];

      // Verified mode (light client) provider, shared by all protocols. Null
      // when off/unconfigured/non-mainnet or on failure -> plain RPC.
      const verifiedProvider = await createVerifiedProvider(networkId, chainId);

      if (enabled.includes("railgun")) {
        try {
          const railgunModule = await ensureRailgunWasm();
          const host = buildHost(credentialId, networkId, "railgun", verifiedProvider);
          next.railgun = await railgunModule.createRailgunPlugin(host, {
            keyIndex: 0,
            poi: true,
          });
          const chain = railgunModule.chainConfig(BigInt(chainId));
          next.railgunWrappedBase = chain?.wrappedBaseToken ?? null;
          next.railgunUnshieldFeeBps = chain?.unshieldFeeBps ?? 25;
        } catch (e) {
          console.error("Railgun init failed", e);
          failures.push("Railgun");
        }
      }

      if (
        enabled.includes("privacy-pools") &&
        process.env.NEXT_PUBLIC_PRIVACY_RPC_URL
      ) {
        try {
          const {
            createPPv1Plugin,
            createPPv1Broadcaster,
            OxBowAspService,
            PrivacyPoolsV1_0xBow,
          } = await import("@kohaku-eth/privacy-pools");
          const entry =
            PrivacyPoolsV1_0xBow[chainId as keyof typeof PrivacyPoolsV1_0xBow];
          if (entry) {
            const host = buildHost(credentialId, networkId, "privacy-pools", verifiedProvider);
            next.privacyPools = createPPv1Plugin(host, {
              accountIndex: 0,
              entrypoint: {
                // IEntrypoint.address is a bigint (ox/Address), the 0xBow
                // config provides it as a hex string
                address: BigInt(
                  entry.entrypoint.entrypointAddress
                ) as unknown as bigint & {},
                deploymentBlock: entry.entrypoint.deploymentBlock,
              },
              broadcasterUrl: PRIVACY_POOLS_RELAYER_URL
                ? { default: PRIVACY_POOLS_RELAYER_URL }
                : {},
              aspServiceFactory: () =>
                new OxBowAspService({ network: host.network }),
            });
            if (PRIVACY_POOLS_RELAYER_URL) {
              next.privacyPoolsBroadcaster = createPPv1Broadcaster(host, {
                broadcasterUrl: { default: PRIVACY_POOLS_RELAYER_URL },
              });
            }
          }
        } catch (e) {
          console.error("Privacy Pools init failed", e);
          failures.push("Privacy Pools");
        }
      }

      if (generation !== initGeneration) {
        // resetPrivacy ran mid-init (lock/wallet switch); don't resurrect
        throw new PrivacyInitError(
          "Privacy initialization was superseded.",
          "init-failed"
        );
      }
      state = next;
      // Only a total wipe-out is a hard error; partial failures are logged
      // and surfaced softly, other protocols still work.
      lastInitError =
        failures.length > 0 && !next.railgun && !next.privacyPools
          ? `Failed to start: ${failures.join(", ")}`
          : null;
      return next;
    })().catch((error) => {
      const message =
        error instanceof Error ? error.message : "Privacy initialization failed";
      // A superseded init must not clobber the promise/error of a newer one
      if (generation === initGeneration) {
        initPromise = null;
        lastInitError = message;
      }
      throw new PrivacyInitError(message, "init-failed");
    });
  }
  await initPromise;

  // A different wallet/network raced in, re-init for the requested pair
  if (!isPrivacyReady(credentialId, networkId)) {
    resetPrivacy();
    return initPrivacy(credentialId, networkId);
  }
}

function requireState(): RegistryState {
  if (!state) {
    throw new PrivacyInitError("Privacy plugins are not initialized.", "init-failed");
  }
  return state;
}

// ---------------------------------------------------------------------------
// Balances

function tokenListFor(networkId: string): Token[] {
  return getTokensForNetwork(networkId);
}

function describeAsset(
  contract: `0x${string}`,
  wrappedBase: `0x${string}` | null,
  networkId: string
): { symbol: string; decimals: number; contract: `0x${string}` | null } {
  // Native markers: Railgun uses the wrapped base token, Privacy Pools uses
  // the sentinel E_ADDRESS
  const isNative =
    contract.toLowerCase() === E_ADDRESS.toLowerCase() ||
    (wrappedBase && contract.toLowerCase() === wrappedBase.toLowerCase());
  if (isNative) {
    return { symbol: "ETH", decimals: 18, contract: null };
  }
  const token = tokenListFor(networkId).find(
    (t) => t.address.toLowerCase() === contract.toLowerCase()
  );
  return token
    ? { symbol: token.symbol, decimals: token.decimals, contract }
    : { symbol: `${contract.slice(0, 6)}…`, decimals: 18, contract };
}

const POI_PENDING_LABELS: Record<string, string> = {
  ProofSubmitted: "proof submitted",
  Missing: "awaiting proof of innocence",
  ShieldBlocked: "blocked by proof of innocence",
};

async function getPrivateBalancesImpl(): Promise<PrivateBalanceRow[]> {
  const s = requireState();
  const rows: PrivateBalanceRow[] = [];

  // Per-protocol try/catch: one protocol's sync failing (e.g. Privacy Pools
  // log-scan hitting an RPC's archive limit) must not hide the others'
  // balances (notably Railgun, which syncs via Subsquid, not eth_getLogs).

  if (s.railgun) {
    try {
      const balances = await s.railgun.balance(undefined);
      // Merge per asset: Valid = spendable, everything else pending
      const merged = new Map<string, PrivateBalanceRow>();
      for (const b of balances) {
        if (b.asset.__type !== "erc20") continue;
        const desc = describeAsset(
          b.asset.contract as `0x${string}`,
          s.railgunWrappedBase,
          s.networkId
        );
        const key = desc.contract ?? "native";
        const row =
          merged.get(key) ??
          ({
            protocol: "railgun",
            ...desc,
            spendable: BigInt(0),
            pending: BigInt(0),
          } as PrivateBalanceRow);
        if (b.tag === "Valid" || b.tag === undefined) {
          row.spendable += b.amount;
        } else {
          row.pending += b.amount;
          row.pendingLabel = POI_PENDING_LABELS[b.tag] ?? b.tag;
        }
        merged.set(key, row);
      }
      rows.push(...merged.values());
    } catch (e) {
      console.error("Railgun balance sync failed", e);
    }
  }

  if (s.privacyPools) {
    try {
      // PP balance returns approved (spendable) + a 'pending' tag per asset
      const balances = await s.privacyPools.balance(undefined);
      const merged = new Map<string, PrivateBalanceRow>();
      for (const b of balances) {
        const desc = describeAsset(
          b.asset.contract as `0x${string}`,
          null,
          s.networkId
        );
        const key = desc.contract ?? "native";
        const row =
          merged.get(key) ??
          ({
            protocol: "privacy-pools",
            ...desc,
            spendable: BigInt(0),
            pending: BigInt(0),
          } as PrivateBalanceRow);
        if (b.tag === "pending") {
          row.pending += b.amount;
          row.pendingLabel = "awaiting ASP approval";
        } else {
          row.spendable += b.amount;
        }
        merged.set(key, row);
      }
      rows.push(...merged.values());
    } catch (e) {
      console.error("Privacy Pools balance sync failed", e);
    }
  }

  return rows;
}

// The 0zk receive address for the wallet's Railgun account
async function getRailgunAddressImpl(): Promise<string | null> {
  const s = requireState();
  if (!s.railgun) return null;
  return s.railgun.instanceId();
}

// ---------------------------------------------------------------------------
// Shield

async function prepareShieldImpl(
  protocol: ProtocolId,
  args: {
    // null = native ETH
    contract: `0x${string}` | null;
    amount: bigint;
    owner: `0x${string}`;
  }
): Promise<PreparedShield> {
  const s = requireState();

  // Privacy Pools deposit: single self-broadcast tx to the entrypoint (native
  // ETH uses the E_ADDRESS sentinel). Handles its own vetting fee internally.
  if (protocol === "privacy-pools") {
    if (!s.privacyPools) {
      throw new Error("Privacy Pools is not available on this network.");
    }
    const ppAsset = {
      __type: "erc20" as const,
      contract: (args.contract ?? (E_ADDRESS as `0x${string}`)) as `0x${string}`,
    };
    const { txns } = await s.privacyPools.prepareShield({
      asset: ppAsset,
      amount: args.amount,
    });
    return {
      protocol,
      txs: txns.map((tx) => ({
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: tx.value,
      })),
    };
  }

  if (protocol !== "railgun" || !s.railgun) {
    throw new Error(`Shielding via ${protocol} is not available yet.`);
  }

  const asset =
    args.contract === null
      ? ({ __type: "native" } as const)
      : ({ __type: "erc20", contract: args.contract } as const);

  const shieldTxs = await s.railgun.prepareShield({
    asset,
    amount: args.amount,
  });

  const txs: PreparedTx[] = [];

  // ERC-20 shields pull tokens from the EOA, prepend an approve when the
  // current allowance toward the shield contract is insufficient
  if (args.contract !== null && shieldTxs.length > 0) {
    const spender = shieldTxs[0].to as `0x${string}`;
    const publicClient = createPublicClientForNetwork(s.networkId);
    const allowance = await publicClient.readContract({
      address: args.contract,
      abi: erc20Abi,
      functionName: "allowance",
      args: [args.owner, spender],
    });
    if (allowance < args.amount) {
      txs.push({
        to: args.contract,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, args.amount],
        }),
        value: BigInt(0),
      });
    }
  }

  for (const tx of shieldTxs) {
    txs.push({
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: tx.value,
    });
  }

  return { protocol, txs };
}

// ---------------------------------------------------------------------------
// Unshield (self-broadcast: the proved transaction is valid from any sender,
// the EOA that submits it pays gas and is visible on-chain, which is fine
// when withdrawing to yourself)

async function prepareUnshieldImpl(
  protocol: ProtocolId,
  args: {
    contract: `0x${string}` | null;
    amount: bigint;
    to: `0x${string}`;
    isOwnAddress: boolean;
  }
): Promise<PreparedUnshield> {
  const s = requireState();

  // Privacy Pools withdrawal is relayed (the relayer submits and pays gas),
  // so the EOA never signs it. Requires a configured relayer.
  if (protocol === "privacy-pools") {
    if (!s.privacyPools) {
      throw new Error("Privacy Pools is not available on this network.");
    }
    if (args.contract === null) {
      throw new Error(
        "Privacy Pools does not support withdrawing native ETH in this version."
      );
    }
    if (!s.privacyPoolsBroadcaster) {
      throw new Error(
        "Privacy Pools withdrawals need a relayer. Set NEXT_PUBLIC_PRIVACY_POOLS_RELAYER_URL."
      );
    }
    // Proving happens inside prepareUnshield (in-browser)
    const op = await s.privacyPools.prepareUnshield(
      {
        asset: { __type: "erc20", contract: args.contract },
        amount: args.amount,
      },
      args.to
    );
    const broadcaster = s.privacyPoolsBroadcaster;
    return {
      protocol,
      feeNote: "The relayer deducts its fee from the withdrawn amount.",
      relayed: {
        broadcast: async () => {
          await broadcaster.broadcast(
            op as unknown as Parameters<typeof broadcaster.broadcast>[0]
          );
        },
      },
    };
  }

  if (protocol !== "railgun" || !s.railgun) {
    throw new Error(`Unshielding via ${protocol} is not available yet.`);
  }

  const asset =
    args.contract === null
      ? ({ __type: "native" } as const)
      : ({ __type: "erc20", contract: args.contract } as const);

  // Proving happens here, in-browser Groth16, takes a while
  const op = await s.railgun.prepareUnshield(
    { asset, amount: args.amount },
    args.to
  );

  // Reach through the plugin for the proved TxData. `provider` is private in
  // the .d.ts but present at runtime; pinned SDK version makes this stable,
  // revisit on upgrade. (The public broadcast() path requires a 4337 bundler,
  // which self-broadcast deliberately avoids.)
  const provider = (
    s.railgun as unknown as {
      provider: {
        build(builder: unknown): Promise<{ to: string; data: string; value: bigint }>;
      };
    }
  ).provider;
  const proved = await provider.build(
    (op as unknown as { builder: unknown }).builder
  );

  const txs: PreparedTx[] = [
    {
      to: proved.to as `0x${string}`,
      data: proved.data as `0x${string}`,
      value: BigInt(proved.value ?? 0),
    },
  ];

  // Native unshields deliver WETH, offer an unwrap when withdrawing to self
  let unwrapTx: PreparedTx | undefined;
  if (args.contract === null && args.isOwnAddress && s.railgunWrappedBase) {
    unwrapTx = {
      to: s.railgunWrappedBase,
      data: encodeFunctionData({
        abi: [
          {
            name: "withdraw",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [{ name: "wad", type: "uint256" }],
            outputs: [],
          },
        ],
        functionName: "withdraw",
        args: [args.amount],
      }),
      value: BigInt(0),
    };
  }

  const feePct = s.railgunUnshieldFeeBps / 100;
  return {
    protocol,
    selfBroadcast: { txs, unwrapTx },
    feeNote: `Railgun charges a ${feePct}% unshield fee (added on top so the recipient gets the exact amount).`,
  };
}

// ---------------------------------------------------------------------------
// Railgun private transfer (0zk -> 0zk), relayed via a 4337 bundler so the
// EOA never appears. Proving (keyless) and broadcast (needs the EOA key to
// authorize the fee UserOperation) are split so the passkey prompt comes
// after the ~1 min proof, not before it.
//
// Minimal replica of the SDK's internal (unexported) EthereumProviderAdapter,
// needed to build the SimpleSmartAccount.
class Eip1193Adapter {
  constructor(
    private provider: {
      getChainId(): Promise<bigint>;
      getBlockNumber(): Promise<bigint>;
      request(args: { method: string; params: unknown[] }): Promise<unknown>;
      call(args: { to: string; input: string }): Promise<string | undefined>;
      estimateGas(args: { to: string; from?: string; input: string }): Promise<bigint>;
      getGasPrice(): Promise<bigint>;
    }
  ) {}
  getChainId() {
    return this.provider.getChainId();
  }
  getBlockNumber() {
    return this.provider.getBlockNumber();
  }
  async getLogs(
    address: `0x${string}`,
    eventSignature: `0x${string}` | undefined,
    fromBlock: number | undefined,
    toBlock: number | undefined
  ) {
    const filter: Record<string, unknown> = { address };
    if (fromBlock !== undefined) filter.fromBlock = `0x${fromBlock.toString(16)}`;
    if (toBlock !== undefined) filter.toBlock = `0x${toBlock.toString(16)}`;
    if (eventSignature) filter.topics = [eventSignature];
    const logs = (await this.provider.request({
      method: "eth_getLogs",
      params: [filter],
    })) as Array<Record<string, unknown>>;
    return logs.map((log) => ({
      blockNumber:
        log.blockNumber != null ? Number(BigInt(log.blockNumber as string)) : null,
      blockTimestamp: null,
      transactionHash: log.transactionHash as string,
      address: (log.address as string) ?? address,
      topics: (log.topics as string[]) ?? [],
      data: (log.data as string) ?? "0x",
    }));
  }
  async ethCall(to: `0x${string}`, data: `0x${string}`) {
    return (await this.provider.call({ to, input: data })) ?? "0x";
  }
  estimateGas(to: `0x${string}`, from: `0x${string}` | undefined, data: `0x${string}`) {
    return this.provider.estimateGas({ to, from, input: data });
  }
  getGasPrice() {
    return this.provider.getGasPrice();
  }
  async getTransactionCount(address: `0x${string}`, block: number | undefined) {
    // The viem provider adapter exposes no getTransactionCount, so go through
    // the raw JSON-RPC method instead.
    const blockTag = block === undefined ? "latest" : `0x${block.toString(16)}`;
    const hex = (await this.provider.request({
      method: "eth_getTransactionCount",
      params: [address, blockTag],
    })) as string;
    return BigInt(hex);
  }
}

let pendingTransferOp: unknown = null;
let pendingUnshieldOp: unknown = null;

// Prove a private transfer. No key needed. Stores the proved op for broadcast.
async function prepareRailgunPrivateTransferImpl(args: {
  to0zk: string;
  contract: `0x${string}` | null;
  amount: bigint;
}): Promise<void> {
  const s = requireState();
  if (!s.railgun) throw new Error("Railgun is not available on this network.");
  if (args.contract === null) {
    throw new Error(
      "Private transfers require an ERC-20 token in this version (not native ETH)."
    );
  }
  pendingTransferOp = await s.railgun.prepareTransfer(
    { asset: { __type: "erc20", contract: args.contract }, amount: args.amount },
    args.to0zk as Parameters<typeof s.railgun.prepareTransfer>[1]
  );
}

// Prove a relayed (clean) unshield to `to`. No key needed. Stores the proved
// op for broadcast via the 4337 privacy paymaster.
async function prepareRailgunUnshieldRelayedImpl(args: {
  contract: `0x${string}` | null;
  amount: bigint;
  to: `0x${string}`;
}): Promise<void> {
  const s = requireState();
  if (!s.railgun) throw new Error("Railgun is not available on this network.");
  const asset =
    args.contract === null
      ? ({ __type: "native" } as const)
      : ({ __type: "erc20", contract: args.contract } as const);
  pendingUnshieldOp = await s.railgun.prepareUnshield(
    { asset, amount: args.amount },
    args.to
  );
}

// Shared 4337 broadcast plumbing. The EOA private key authorizes the fee
// UserOperation; it builds a WASM Signer that is freed, and detached from the
// plugin, immediately after. Gas is paid by Railgun's privacy paymaster from
// shielded funds, so `ownerAddress` needs no ETH. Called ONLY from signer.ts
// inside a passkey ceremony.
async function broadcastPendingOp(
  op: unknown,
  ownerAddress: `0x${string}`,
  privateKey: `0x${string}`
): Promise<void> {
  const s = requireState();
  if (!s.railgun) throw new Error("Railgun is not available.");
  if (!PIMLICO_API_KEY) throw new Error("No bundler configured for relaying.");
  if (!op) throw new Error("No prepared operation to broadcast.");

  const railgunModule = await import("@kohaku-eth/railgun");
  const publicClient = createPublicClientForNetwork(s.networkId);
  const eip1193 = new Eip1193Adapter(
    viemProviderAdapter(publicClient) as unknown as ConstructorParameters<
      typeof Eip1193Adapter
    >[0]
  );
  const bundler = railgunModule.Bundler.pimlico(pimlicoUrl(s.chainId));
  const smartAccount = new railgunModule.SimpleSmartAccount(
    ownerAddress,
    BigInt(s.chainId),
    eip1193 as unknown as ConstructorParameters<
      typeof railgunModule.SimpleSmartAccount
    >[2]
  );
  const signer = railgunModule.Signer.privateKey(privateKey);
  const plugin = s.railgun as unknown as {
    setBundler(b: unknown): void;
    setSmartAccount(sa: unknown, signer: unknown): void;
    broadcast(op: unknown): Promise<void>;
  };
  try {
    plugin.setBundler(bundler);
    plugin.setSmartAccount(smartAccount, signer);
    await plugin.broadcast(op);
  } catch (err) {
    // The wasm reports amount + protocol fee + paymaster gas repayment
    // overrunning the shielded balance as an opaque intent error
    if (String(err).includes("Insufficient balance for intent")) {
      throw new Error(
        "Shielded balance can't cover this amount plus the relayer's gas " +
          "repayment (the paymaster repays itself from your shielded funds). " +
          "Shield more first, or unshield less."
      );
    }
    throw err;
  } finally {
    // Detach first so the plugin never retains a reference to the freed
    // wasm signer, then free the key-bearing signer immediately
    plugin.setSmartAccount(undefined, undefined);
    plugin.setBundler(undefined);
    (signer as unknown as { free?: () => void }).free?.();
  }
}

async function broadcastRailgunPrivateTransferImpl(
  ownerAddress: `0x${string}`,
  privateKey: `0x${string}`
): Promise<void> {
  if (!pendingTransferOp) throw new Error("No prepared transfer to broadcast.");
  try {
    await broadcastPendingOp(pendingTransferOp, ownerAddress, privateKey);
  } finally {
    pendingTransferOp = null;
  }
}

// Broadcast the proved clean unshield. `ownerAddress`/`privateKey` are the
// fresh destination account, which both receives the funds and signs the fee
// UserOp, so the depositing EOA never appears on-chain.
async function broadcastRailgunUnshieldImpl(
  ownerAddress: `0x${string}`,
  privateKey: `0x${string}`
): Promise<void> {
  if (!pendingUnshieldOp) throw new Error("No prepared unshield to broadcast.");
  try {
    await broadcastPendingOp(pendingUnshieldOp, ownerAddress, privateKey);
  } finally {
    pendingUnshieldOp = null;
  }
}

// ---------------------------------------------------------------------------
// Ragequit (Privacy Pools only): reclaim a deposit the ASP never approved.
// Public, self-broadcast, de-anonymizing.

async function prepareRagequitImpl(
  labels: unknown[]
): Promise<PreparedRagequit> {
  const s = requireState();
  if (!s.privacyPools) {
    throw new Error("Privacy Pools is not available on this network.");
  }
  const { txns } = await s.privacyPools.ragequit(
    labels as Parameters<typeof s.privacyPools.ragequit>[0]
  );
  return {
    txs: txns.map((tx) => ({
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: tx.value,
    })),
  };
}

// ---------------------------------------------------------------------------
// Public API: every plugin-touching call is serialized through withPluginLock
// so overlapping calls never re-enter a wasm-bindgen object concurrently.

export function getPrivateBalances(): Promise<PrivateBalanceRow[]> {
  return withPluginLock(getPrivateBalancesImpl);
}
export function getRailgunAddress(): Promise<string | null> {
  return withPluginLock(getRailgunAddressImpl);
}
export function prepareShield(
  protocol: ProtocolId,
  args: { contract: `0x${string}` | null; amount: bigint; owner: `0x${string}` }
): Promise<PreparedShield> {
  return withPluginLock(() => prepareShieldImpl(protocol, args));
}
export function prepareUnshield(
  protocol: ProtocolId,
  args: {
    contract: `0x${string}` | null;
    amount: bigint;
    to: `0x${string}`;
    isOwnAddress: boolean;
  }
): Promise<PreparedUnshield> {
  return withPluginLock(() => prepareUnshieldImpl(protocol, args));
}
export function prepareRailgunPrivateTransfer(args: {
  to0zk: string;
  contract: `0x${string}` | null;
  amount: bigint;
}): Promise<void> {
  return withPluginLock(() => prepareRailgunPrivateTransferImpl(args));
}
export function broadcastRailgunPrivateTransfer(
  ownerAddress: `0x${string}`,
  privateKey: `0x${string}`
): Promise<void> {
  return withPluginLock(() =>
    broadcastRailgunPrivateTransferImpl(ownerAddress, privateKey)
  );
}
export function prepareRailgunUnshieldRelayed(args: {
  contract: `0x${string}` | null;
  amount: bigint;
  to: `0x${string}`;
}): Promise<void> {
  return withPluginLock(() => prepareRailgunUnshieldRelayedImpl(args));
}
export function broadcastRailgunUnshield(
  ownerAddress: `0x${string}`,
  privateKey: `0x${string}`
): Promise<void> {
  return withPluginLock(() =>
    broadcastRailgunUnshieldImpl(ownerAddress, privateKey)
  );
}
// True when a relayed (unlinkable) unshield is possible: a bundler is
// configured and the Railgun plugin is live.
export function isRelayedUnshieldAvailable(): boolean {
  return Boolean(PIMLICO_API_KEY) && state?.railgun != null;
}
export function prepareRagequit(labels: unknown[]): Promise<PreparedRagequit> {
  return withPluginLock(() => prepareRagequitImpl(labels));
}
