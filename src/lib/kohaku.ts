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
import {
  createPublicClientForNetwork,
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

export type ProtocolId = KohakuProtocolId;

// Kohaku's Railgun crate ships chain configs for mainnet and Sepolia only.
// Privacy Pools v1 and the Tornado configs cover the same two chains.
export const PRIVACY_SUPPORTED_CHAIN_IDS = [1, 11155111];

// Tornado ships in the web build by default and stays out of the iOS build
// unless explicitly opted in (App Store review risk, OFAC history).
function isTornadoEnabledInBuild(): boolean {
  if (process.env.NEXT_PUBLIC_ENABLE_TORNADO === "false") return false;
  if (typeof window !== "undefined") {
    const isNative = Boolean(
      (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
        .Capacitor?.isNativePlatform?.()
    );
    if (isNative && process.env.NEXT_PUBLIC_TORNADO_IOS !== "true") {
      return false;
    }
  }
  return true;
}

export function getAvailableProtocols(): ProtocolId[] {
  const protocols: ProtocolId[] = ["railgun", "privacy-pools"];
  if (isTornadoEnabledInBuild()) protocols.push("tornado");
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

export type PreparedUnshield = {
  protocol: ProtocolId;
  // Self-broadcast transactions, signed and sent in order by the wallet EOA
  txs: PreparedTx[];
  // Railgun native unshields deliver WETH, this unwraps it (only offered
  // when the destination is the wallet's own address)
  unwrapTx?: PreparedTx;
  feeNote?: string;
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

async function ensureRailgunWasm(logLevel?: string): Promise<
  typeof import("@kohaku-eth/railgun")
> {
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
};

let state: RegistryState | null = null;
let initPromise: Promise<RegistryState> | null = null;
let idbAvailable: boolean | null = null;
let lastInitError: string | null = null;

export function resetPrivacy(): void {
  state = null;
  initPromise = null;
  lastInitError = null;
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

function buildHost(credentialId: string, networkId: string, protocol: ProtocolId): Host {
  const publicClient = createPublicClientForNetwork(networkId);
  return {
    network: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    },
    storage: createHostStorage(credentialId, protocol),
    keystore: {
      deriveAt: (path: string) => deriveAtFromSession(protocol, path),
    },
    provider: viemProviderAdapter(publicClient),
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
      };

      if (enabled.includes("railgun")) {
        const railgunModule = await ensureRailgunWasm();
        const host = buildHost(credentialId, networkId, "railgun");
        next.railgun = await railgunModule.createRailgunPlugin(host, {
          keyIndex: 0,
          poi: true,
        });
        const chain = railgunModule.chainConfig(BigInt(chainId));
        next.railgunWrappedBase = chain?.wrappedBaseToken ?? null;
        next.railgunUnshieldFeeBps = chain?.unshieldFeeBps ?? 25;
      }

      state = next;
      lastInitError = null;
      return next;
    })().catch((error) => {
      initPromise = null;
      lastInitError =
        error instanceof Error ? error.message : "Privacy initialization failed";
      throw new PrivacyInitError(lastInitError, "init-failed");
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
  if (wrappedBase && contract.toLowerCase() === wrappedBase.toLowerCase()) {
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

export async function getPrivateBalances(): Promise<PrivateBalanceRow[]> {
  const s = requireState();
  const rows: PrivateBalanceRow[] = [];

  if (s.railgun) {
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
  }

  return rows;
}

// The 0zk receive address for the wallet's Railgun account
export async function getRailgunAddress(): Promise<string | null> {
  const s = requireState();
  if (!s.railgun) return null;
  return s.railgun.instanceId();
}

// ---------------------------------------------------------------------------
// Shield

export async function prepareShield(
  protocol: ProtocolId,
  args: {
    // null = native ETH
    contract: `0x${string}` | null;
    amount: bigint;
    owner: `0x${string}`;
  }
): Promise<PreparedShield> {
  const s = requireState();
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

export async function prepareUnshield(
  protocol: ProtocolId,
  args: {
    contract: `0x${string}` | null;
    amount: bigint;
    to: `0x${string}`;
    isOwnAddress: boolean;
  }
): Promise<PreparedUnshield> {
  const s = requireState();
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
    txs,
    unwrapTx,
    feeNote: `Railgun charges a ${feePct}% unshield fee (added on top so the recipient gets the exact amount).`,
  };
}
