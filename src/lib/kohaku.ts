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
  createPPv1Plugin,
  createPPv1Broadcaster,
  OxBowAspService,
  PrivacyPoolsV1_0xBow,
  E_ADDRESS,
  type PPv1Instance,
  type PPv1Broadcaster,
} from "@kohaku-eth/privacy-pools";
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

// Unshielding takes one of two shapes depending on the protocol:
// - self-broadcast (Railgun): the wallet EOA signs and submits the proved
//   transactions itself. Links the EOA on-chain, fine for withdraw-to-self.
// - relayed (Privacy Pools, Tornado): a relayer/bundler submits, so no EOA
//   signature and no EOA link. The registry owns the network call.
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

// Tornado Cash init. Dynamic import keeps its comlink Web Worker + circuit
// machinery out of every build and lets a load failure be caught at runtime
// (isolated per-protocol) rather than breaking the whole bundle. The worker
// runs the fixed-denomination note scanning and Groth16 proving off-thread.
async function initTornado(
  credentialId: string,
  networkId: string,
  chainId: number
): Promise<{ plugin: TornadoInstance; broadcaster: TornadoBroadcaster }> {
  const tc = await import("@kohaku-eth/tornado-cash");
  const protocolConfig =
    tc.TornadoCashConfigs[chainId as keyof typeof tc.TornadoCashConfigs];
  if (!protocolConfig) {
    throw new Error(`Tornado Cash is not configured for chain ${chainId}`);
  }
  const host = buildHost(credentialId, networkId, "tornado");
  // No stateManagerWorkerUrl: let our worker-loader shim create the worker via
  // new Worker(new URL(...)) so webpack bundles the full worker graph.
  const plugin = tc.createTCPlugin(host, {
    accountIndex: 0,
    protocolConfig: protocolConfig as unknown as Parameters<
      typeof tc.createTCPlugin
    >[1]["protocolConfig"],
    paymasterConfig: tc.TornadoPaymasterConfigs,
  }) as unknown as TornadoInstance;
  const broadcaster = tc.createTCBroadcaster(host, {
    paymasterConfig: tc.TornadoPaymasterConfigs,
  }) as unknown as TornadoBroadcaster;
  return { plugin, broadcaster };
}

// ---------------------------------------------------------------------------
// Registry state

type RailgunPluginInstance = Awaited<
  ReturnType<typeof import("@kohaku-eth/railgun").createRailgunPlugin>
>;

// Structural shape of the Tornado plugin we use (loaded via dynamic import,
// so we avoid a static type dependency that would pull it into every build).
type TornadoInstance = {
  balance(assets: unknown): Promise<
    Array<{ asset: { contract: string }; amount: bigint; tag?: string }>
  >;
  notes(params: {
    includeSpent?: boolean;
  }): Promise<
    Array<{ amount: bigint; assetAddress: bigint; timestamp: bigint }>
  >;
  prepareShield(
    asset: { asset: { __type: "erc20"; contract: `0x${string}` }; amount: bigint },
    options?: { strategy: number }
  ): Promise<{ txns: Array<{ to: string; data: string; value: bigint }> }>;
  prepareUnshield(
    asset: { asset: { __type: "erc20"; contract: `0x${string}` }; amount: bigint },
    to: `0x${string}`,
    options?: { mode: "relayer" | "paymaster" }
  ): Promise<unknown>;
};

type TornadoBroadcaster = { broadcast(op: unknown): Promise<unknown> };

type RegistryState = {
  credentialId: string;
  networkId: string;
  chainId: number;
  railgun: RailgunPluginInstance | null;
  railgunWrappedBase: `0x${string}` | null;
  railgunUnshieldFeeBps: number;
  privacyPools: PPv1Instance | null;
  privacyPoolsBroadcaster: PPv1Broadcaster | null;
  tornado: {
    plugin: TornadoInstance;
    broadcaster: TornadoBroadcaster;
  } | null;
};

// The 0xbow relayer that submits Privacy Pools withdrawals. Overridable, no
// public default is documented, so withdraw stays gated until it is set.
const PRIVACY_POOLS_RELAYER_URL =
  process.env.NEXT_PUBLIC_PRIVACY_POOLS_RELAYER_URL || "";

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
        privacyPools: null,
        privacyPoolsBroadcaster: null,
        tornado: null,
      };

      // Each protocol initializes independently: one plugin failing (e.g. the
      // Tornado worker not loading) must not take down the others.
      const failures: string[] = [];

      if (enabled.includes("railgun")) {
        try {
          const railgunModule = await ensureRailgunWasm();
          const host = buildHost(credentialId, networkId, "railgun");
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

      if (enabled.includes("privacy-pools")) {
        try {
          const entry =
            PrivacyPoolsV1_0xBow[chainId as keyof typeof PrivacyPoolsV1_0xBow];
          if (entry) {
            const host = buildHost(credentialId, networkId, "privacy-pools");
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

      if (enabled.includes("tornado") && isTornadoEnabledInBuild()) {
        try {
          next.tornado = await initTornado(credentialId, networkId, chainId);
        } catch (e) {
          console.error("Tornado Cash init failed", e);
          failures.push("Tornado Cash");
        }
      }

      state = next;
      // Only a total wipe-out is a hard error; partial failures are logged
      // and surfaced softly, other protocols still work.
      lastInitError =
        failures.length > 0 &&
        !next.railgun &&
        !next.privacyPools &&
        !next.tornado
          ? `Failed to start: ${failures.join(", ")}`
          : null;
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
  // Native markers: Railgun uses the wrapped base token, Privacy Pools/
  // Tornado use the sentinel E_ADDRESS
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

  if (s.privacyPools) {
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
  }

  if (s.tornado) {
    // Tornado holds fixed-denomination notes; report the total plus a note
    // count. All notes here are native ETH pools in our config.
    const notes = await s.tornado.plugin.notes({ includeSpent: false });
    const total = notes.reduce((sum, n) => sum + n.amount, BigInt(0));
    if (notes.length > 0) {
      rows.push({
        protocol: "tornado",
        symbol: "ETH",
        decimals: 18,
        contract: null,
        spendable: total,
        pending: BigInt(0),
        noteCount: notes.length,
      });
    }
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

  // Tornado deposit: fixed-denomination pool(s). The amount must be a whole
  // multiple of a supported denomination; the plugin picks pools by strategy.
  if (protocol === "tornado") {
    if (!s.tornado) {
      throw new Error("Tornado Cash is not available.");
    }
    const { txns } = await s.tornado.plugin.prepareShield(
      {
        asset: {
          __type: "erc20",
          contract: (args.contract ?? (E_ADDRESS as `0x${string}`)) as `0x${string}`,
        },
        amount: args.amount,
      },
      { strategy: 0 /* MaxAnonymitySet */ }
    );
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

  // Tornado withdrawal via the 4337 paymaster (bundler pays gas, no EOA link
  // and no fresh-address gas problem). Relayed, so no EOA signature.
  if (protocol === "tornado") {
    if (!s.tornado) {
      throw new Error("Tornado Cash is not available.");
    }
    const op = await s.tornado.plugin.prepareUnshield(
      {
        asset: {
          __type: "erc20",
          contract: (args.contract ?? (E_ADDRESS as `0x${string}`)) as `0x${string}`,
        },
        amount: args.amount,
      },
      args.to,
      { mode: "paymaster" }
    );
    const broadcaster = s.tornado.broadcaster;
    return {
      protocol,
      feeNote: "Gas is covered by the Tornado paymaster from the withdrawn amount.",
      relayed: {
        broadcast: async () => {
          await broadcaster.broadcast(op);
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
      getTransactionCount(address: string, block?: number): Promise<number | bigint>;
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
    return BigInt(await this.provider.getTransactionCount(address, block));
  }
}

let pendingTransferOp: unknown = null;

// Prove a private transfer. No key needed. Stores the proved op for broadcast.
export async function prepareRailgunPrivateTransfer(args: {
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

// Broadcast the proved transfer via the 4337 bundler. The EOA private key
// authorizes the fee UserOperation; it is used to build a WASM Signer that is
// freed, and detached from the plugin, immediately after. Called ONLY from
// signer.ts inside a passkey ceremony.
export async function broadcastRailgunPrivateTransfer(
  ownerAddress: `0x${string}`,
  privateKey: `0x${string}`
): Promise<void> {
  const s = requireState();
  if (!s.railgun) throw new Error("Railgun is not available.");
  if (!PIMLICO_API_KEY) throw new Error("No bundler configured for private send.");
  if (!pendingTransferOp) throw new Error("No prepared transfer to broadcast.");

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
    await plugin.broadcast(pendingTransferOp);
  } finally {
    // Detach and free the key-bearing signer immediately
    (signer as unknown as { free?: () => void }).free?.();
    plugin.setBundler(undefined);
    pendingTransferOp = null;
  }
}

// ---------------------------------------------------------------------------
// Ragequit (Privacy Pools only): reclaim a deposit the ASP never approved.
// Public, self-broadcast, de-anonymizing.

export async function prepareRagequit(
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
