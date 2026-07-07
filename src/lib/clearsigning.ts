import { Capacitor, registerPlugin } from "@capacitor/core";
import type { SessionRequest } from "./walletconnect";
import { getAllNetworks } from "./wallet";
import { getTokensForNetwork } from "./tokens";

// ERC-7730 clear signing via the native ClearSigning Capacitor plugin
// (Rust engine + Swift binding, iOS only - there is no web/WASM build).
// See ios/App/App/ClearSigningPlugin.swift for the native side.

export interface KnownToken {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  name: string;
}

export interface ClearSigningItem {
  kind: "item";
  label: string;
  value: string;
}

export interface ClearSigningGroup {
  kind: "group";
  label: string;
  iteration: "sequential" | "bundled";
  items: { label: string; value: string }[];
}

export interface ClearSigningNested {
  kind: "nested";
  label: string;
  intent: string;
  owner?: string | null;
  entries: ClearSigningEntry[];
}

export type ClearSigningEntry =
  | ClearSigningItem
  | ClearSigningGroup
  | ClearSigningNested;

export interface ClearSigningDiagnostic {
  code: string;
  severity: "info" | "warning";
  message: string;
}

export type ClearSigningFallbackReason =
  | "descriptorNotFound"
  | "formatNotFound"
  | "nestedCallNotClearSigned"
  | "insufficientContext";

export interface ClearSigningResult {
  // The last two statuses are JS-only. "webOnly" means the native engine
  // is absent (browser build). "notApplicable" means there is nothing to
  // decode for this request (personal_sign, plain ETH transfer).
  status: "clearSigned" | "fallback" | "error" | "webOnly" | "notApplicable";
  intent?: string;
  interpolatedIntent?: string;
  owner?: string;
  contractName?: string;
  fallbackReason?: ClearSigningFallbackReason;
  entries?: ClearSigningEntry[];
  diagnostics?: ClearSigningDiagnostic[];
  errorMessage?: string;
}

interface ClearSigningPluginType {
  formatTransaction(options: {
    chainId: number;
    to: string;
    data: string;
    value?: string;
    from?: string;
    knownTokens: KnownToken[];
  }): Promise<ClearSigningResult>;
  formatTypedData(options: {
    typedDataJson: string;
    knownTokens: KnownToken[];
  }): Promise<ClearSigningResult>;
}

const ClearSigning = registerPlugin<ClearSigningPluginType>("ClearSigning");

export function isClearSigningAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

// The native DataProviderFfi callbacks are synchronous, so token metadata
// is prefetched here and passed with each call instead of resolved natively
function getKnownTokensForChain(chainId: number): KnownToken[] {
  const networks = getAllNetworks();
  const networkId = Object.keys(networks).find(
    (id) => networks[id].id === chainId
  );
  if (!networkId) return [];

  return getTokensForNetwork(networkId).map((token) => ({
    chainId,
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
    name: token.name,
  }));
}

type DecodablePayload =
  | { kind: "tx"; to: string; data: string; value?: string; from?: string }
  | { kind: "typedData"; typedDataJson: string };

// Returns what the engine could decode from this request, or null when
// there is nothing to decode on any platform (personal_sign, plain ETH
// transfer, legacy typed-data shapes)
function getDecodablePayload(request: SessionRequest): DecodablePayload | null {
  const { method, params } = request.params.request;

  if (method === "eth_sendTransaction") {
    const tx = params[0] as {
      to?: string;
      data?: string;
      value?: string;
      from?: string;
    };
    if (!tx?.to || !tx.data || tx.data === "0x") {
      return null;
    }
    return { kind: "tx", to: tx.to, data: tx.data, value: tx.value, from: tx.from };
  }

  if (method === "eth_signTypedData" || method === "eth_signTypedData_v4") {
    const typedDataJson = params[1];
    // Guard against legacy shapes where params[1] is an address rather
    // than the typed-data JSON object
    if (
      typeof typedDataJson !== "string" ||
      !typedDataJson.trim().startsWith("{")
    ) {
      return null;
    }
    return { kind: "typedData", typedDataJson };
  }

  return null;
}

// Format a WalletConnect session request into a human-readable breakdown.
// Never throws - every failure mode maps onto the result envelope.
export async function formatSessionRequest(
  request: SessionRequest
): Promise<ClearSigningResult> {
  try {
    const payload = getDecodablePayload(request);
    if (!payload) {
      return { status: "notApplicable" };
    }

    if (!isClearSigningAvailable()) {
      return { status: "webOnly" };
    }

    const chainId = Number(request.params.chainId.split(":")[1]);
    if (!Number.isFinite(chainId)) {
      return { status: "notApplicable" };
    }
    const knownTokens = getKnownTokensForChain(chainId);

    if (payload.kind === "tx") {
      return await ClearSigning.formatTransaction({
        chainId,
        to: payload.to,
        data: payload.data,
        value: payload.value,
        from: payload.from,
        knownTokens,
      });
    }
    return await ClearSigning.formatTypedData({
      typedDataJson: payload.typedDataJson,
      knownTokens,
    });
  } catch (error) {
    return {
      status: "error",
      errorMessage:
        error instanceof Error ? error.message : "Clear signing failed",
    };
  }
}
