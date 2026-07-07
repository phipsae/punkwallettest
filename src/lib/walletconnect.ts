import { Core } from "@walletconnect/core";
import { WalletKit, WalletKitTypes } from "@reown/walletkit";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import { formatEther, type Hex, type Chain } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { getAllNetworks, getAllNetworkIds, getCustomNetworks } from "./wallet";

// WalletConnect Project ID - Get yours at https://cloud.walletconnect.com
const PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "demo-project-id";

// Get supported chains dynamically from wallet configuration
function getSupportedChains(): Record<string, Chain> {
  const networks = getAllNetworks();
  const supportedChains: Record<string, Chain> = {};

  for (const [networkId, chain] of Object.entries(networks)) {
    supportedChains[`eip155:${chain.id}`] = chain;
  }

  return supportedChains;
}

// Get chain ID to network ID mapping
function getChainIdToNetworkMap(): Record<string, string> {
  const networks = getAllNetworks();
  const mapping: Record<string, string> = {};

  for (const [networkId, chain] of Object.entries(networks)) {
    mapping[String(chain.id)] = networkId;
  }

  return mapping;
}

// eth_sign is deliberately absent: it blind-signs arbitrary hashes and is
// rejected outright (UNSUPPORTED_METHODS), never shown to the user.
const SUPPORTED_METHODS = [
  "eth_sendTransaction",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v4",
];

const SUPPORTED_EVENTS = ["chainChanged", "accountsChanged"];

export interface SessionRequest {
  id: number;
  topic: string;
  params: {
    request: {
      method: string;
      params: unknown[];
    };
    chainId: string;
  };
  verifyContext?: {
    verified: {
      origin: string;
      validation: string;
      verifyUrl: string;
    };
  };
}

export interface SessionProposal {
  id: number;
  params: WalletKitTypes.SessionProposal["params"];
  verifyContext?: WalletKitTypes.SessionProposal["verifyContext"];
}

export interface ActiveSession {
  topic: string;
  peerMeta: {
    name: string;
    description: string;
    url: string;
    icons: string[];
  };
  expiry: number;
}

type EventCallback = {
  onSessionProposal?: (proposal: SessionProposal) => void;
  onSessionRequest?: (request: SessionRequest) => void;
  onSessionDelete?: (topic: string) => void;
};

let walletKit: InstanceType<typeof WalletKit> | null = null;
let eventCallbacks: EventCallback = {};
let wcInitFailed = false;

// Check if IndexedDB is available and working (iOS 17 bug workaround)
async function checkIndexedDBAvailable(): Promise<boolean> {
  if (typeof indexedDB === "undefined") {
    return false;
  }

  return new Promise((resolve) => {
    try {
      const testDbName = "__wc_idb_test__";
      const request = indexedDB.open(testDbName);

      request.onerror = () => {
        console.warn("IndexedDB test failed - not available");
        resolve(false);
      };

      request.onsuccess = () => {
        try {
          request.result.close();
          indexedDB.deleteDatabase(testDbName);
          resolve(true);
        } catch {
          resolve(false);
        }
      };

      // Timeout after 3 seconds (iOS can hang on IndexedDB)
      setTimeout(() => {
        console.warn("IndexedDB test timed out");
        resolve(false);
      }, 3000);
    } catch {
      resolve(false);
    }
  });
}

// Check if WalletConnect is available (didn't fail to initialize)
export function isWalletConnectAvailable(): boolean {
  return !wcInitFailed;
}

// Initialize WalletConnect with iOS 17 IndexedDB protection
export async function initWalletConnect(): Promise<InstanceType<
  typeof WalletKit
> | null> {
  if (walletKit) return walletKit;
  if (wcInitFailed) return null;

  try {
    // Test IndexedDB availability first (iOS 17 bug workaround)
    const idbAvailable = await checkIndexedDBAvailable();
    if (!idbAvailable) {
      console.warn(
        "IndexedDB not available - WalletConnect disabled (likely iOS 17 Lockdown Mode or IndexedDB bug)"
      );
      wcInitFailed = true;
      return null;
    }

    const core = new Core({
      projectId: PROJECT_ID,
    });

    walletKit = await WalletKit.init({
      core,
      metadata: {
        name: "Punk Wallet",
        description: "Self-custodial Ethereum wallet secured by passkeys",
        url:
          typeof window !== "undefined"
            ? window.location.origin
            : "https://punkwallet.io",
        icons: ["https://avatars.githubusercontent.com/u/37784886"],
      },
    });

    // Set up event listeners
    walletKit.on("session_proposal", async (proposal) => {
      console.log("Session proposal received:", proposal);
      if (eventCallbacks.onSessionProposal) {
        eventCallbacks.onSessionProposal({
          id: proposal.id,
          params: proposal.params,
          verifyContext: proposal.verifyContext,
        });
      }
    });

    walletKit.on("session_request", async (request) => {
      console.log("Session request received:", request);
      const sessionRequest = request as SessionRequest;

      // Auto-reject before any UI: unsupported methods (incl. eth_sign,
      // possibly advertised by sessions approved before it was dropped) and
      // chains this wallet does not know. Never sign against a silently
      // substituted chain.
      const method = sessionRequest.params.request.method;
      const requestChainId = sessionRequest.params.chainId.split(":")[1];
      const knownChain = requestChainId in getChainIdToNetworkMap();
      if (!SUPPORTED_METHODS.includes(method) || !knownChain) {
        const reason = !SUPPORTED_METHODS.includes(method)
          ? getSdkError("UNSUPPORTED_METHODS")
          : getSdkError("UNSUPPORTED_CHAINS");
        console.warn(
          `Auto-rejecting session request (${method} on ${sessionRequest.params.chainId}):`,
          reason.message
        );
        try {
          await walletKit?.respondSessionRequest({
            topic: sessionRequest.topic,
            response: {
              id: sessionRequest.id,
              jsonrpc: "2.0",
              error: reason,
            },
          });
        } catch (err) {
          console.error("Failed to auto-reject session request:", err);
        }
        return;
      }

      if (eventCallbacks.onSessionRequest) {
        eventCallbacks.onSessionRequest(sessionRequest);
      }
    });

    walletKit.on("session_delete", async (event) => {
      console.log("Session deleted:", event);
      if (eventCallbacks.onSessionDelete) {
        eventCallbacks.onSessionDelete(event.topic);
      }
    });

    return walletKit;
  } catch (err) {
    console.error(
      "WalletConnect initialization failed (likely iOS 17 IndexedDB issue):",
      err
    );
    wcInitFailed = true;
    return null;
  }
}

// Set event callbacks
export function setEventCallbacks(callbacks: EventCallback) {
  eventCallbacks = { ...eventCallbacks, ...callbacks };
}

// Connect to a dApp using WalletConnect URI
export async function connectWithUri(uri: string): Promise<void> {
  const wk = await initWalletConnect();
  if (!wk) throw new Error("WalletConnect not initialized");
  await wk.pair({ uri });
}

// Approve a session proposal
export async function approveSession(
  proposalId: number,
  proposal: WalletKitTypes.SessionProposal["params"],
  address: string
): Promise<ActiveSession> {
  const wk = await initWalletConnect();
  if (!wk) throw new Error("WalletConnect not initialized");

  // Get current supported chains dynamically
  const supportedChains = getSupportedChains();
  const chainKeys = Object.keys(supportedChains);

  // Build namespaces based on what the dApp requested
  const namespaces = buildApprovedNamespaces({
    proposal,
    supportedNamespaces: {
      eip155: {
        chains: chainKeys,
        methods: SUPPORTED_METHODS,
        events: SUPPORTED_EVENTS,
        accounts: chainKeys.map(
          (chain) => `${chain}:${address}`
        ),
      },
    },
  });

  const session = await wk.approveSession({
    id: proposalId,
    namespaces,
  });

  return {
    topic: session.topic,
    peerMeta: {
      name: session.peer.metadata.name,
      description: session.peer.metadata.description,
      url: session.peer.metadata.url,
      icons: session.peer.metadata.icons,
    },
    expiry: session.expiry,
  };
}

// Reject a session proposal
export async function rejectSession(proposalId: number): Promise<void> {
  const wk = await initWalletConnect();
  if (!wk) throw new Error("WalletConnect not initialized");
  await wk.rejectSession({
    id: proposalId,
    reason: getSdkError("USER_REJECTED"),
  });
}

// Get all active sessions
export async function getActiveSessions(): Promise<ActiveSession[]> {
  const wk = await initWalletConnect();
  if (!wk) throw new Error("WalletConnect not initialized");
  const sessions = wk.getActiveSessions();

  return Object.values(sessions).map((session) => ({
    topic: session.topic,
    peerMeta: {
      name: session.peer.metadata.name,
      description: session.peer.metadata.description,
      url: session.peer.metadata.url,
      icons: session.peer.metadata.icons,
    },
    expiry: session.expiry,
  }));
}

// Disconnect a session
export async function disconnectSession(topic: string): Promise<void> {
  const wk = await initWalletConnect();
  if (!wk) throw new Error("WalletConnect not initialized");
  await wk.disconnectSession({
    topic,
    reason: getSdkError("USER_DISCONNECTED"),
  });
}

// Update all sessions with a new account address (when switching wallets)
export async function updateSessionsAccount(newAddress: string): Promise<void> {
  const wk = await initWalletConnect();
  if (!wk) throw new Error("WalletConnect not initialized");
  const sessions = wk.getActiveSessions();

  // Emit accountsChanged event to each active session
  for (const session of Object.values(sessions)) {
    // Get the chains this session is connected to
    const chains = Object.keys(session.namespaces)
      .flatMap((ns) => {
        const namespace = session.namespaces[ns];
        return namespace.chains || [];
      })
      .filter((chain) => chain.startsWith("eip155:"));

    // Emit accountsChanged for each chain
    for (const chainId of chains) {
      try {
        await wk.emitSessionEvent({
          topic: session.topic,
          event: {
            name: "accountsChanged",
            data: [`${chainId}:${newAddress}`],
          },
          chainId,
        });
        console.log(
          `Emitted accountsChanged to ${session.peer.metadata.name} on ${chainId}`
        );
      } catch (error) {
        console.error(
          `Failed to emit accountsChanged to ${session.peer.metadata.name}:`,
          error
        );
      }
    }

    // Also update the session namespaces with the new account
    try {
      const updatedNamespaces = { ...session.namespaces };
      for (const ns of Object.keys(updatedNamespaces)) {
        if (ns === "eip155" || ns.startsWith("eip155:")) {
          const namespace = updatedNamespaces[ns];
          // Update accounts to use new address
          namespace.accounts = (namespace.chains || []).map(
            (chain) => `${chain}:${newAddress}`
          );
        }
      }

      await wk.updateSession({
        topic: session.topic,
        namespaces: updatedNamespaces,
      });
      console.log(
        `Updated session namespaces for ${session.peer.metadata.name}`
      );
    } catch (error) {
      console.error(
        `Failed to update session for ${session.peer.metadata.name}:`,
        error
      );
    }
  }
}

// Handle a session request (sign transaction, message, etc.)
// Reject a session request. Key-free path - callable without any unlock.
export async function rejectSessionRequest(
  request: SessionRequest
): Promise<void> {
  const wk = await initWalletConnect();
  if (!wk) throw new Error("WalletConnect not initialized");
  await wk.respondSessionRequest({
    topic: request.topic,
    response: {
      id: request.id,
      jsonrpc: "2.0",
      error: getSdkError("USER_REJECTED"),
    },
  });
}

// Sign/execute an approved session request and respond to the dApp. Takes a
// viem account, never a raw key - only src/lib/signer.ts may call this, from
// inside its key scope. Signing failures are responded to the dApp AND
// rethrown so the UI shows the real reason.
export async function executeSessionRequest(
  request: SessionRequest,
  account: PrivateKeyAccount
): Promise<string> {
  const wk = await initWalletConnect();
  if (!wk) throw new Error("WalletConnect not initialized");
  const { id, topic, params } = request;
  const { method, params: requestParams } = params.request;

  const isAddressShaped = (value: unknown): value is string =>
    typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

  // The request's signer/from address must be the unlocked account. With
  // multiple wallets, a session approved as account A can receive a request
  // while account B is unlocked - signing with the wrong key must fail, and
  // the throw lands inside the try below so the dApp gets the error response.
  const assertRequestedSigner = (requested: string | undefined): void => {
    if (!requested) return;
    if (requested.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(
        `Request is for address ${requested} but the unlocked wallet is ${account.address}. Switch to the requested account and try again.`
      );
    }
  };

  try {
    let result: string;

    switch (method) {
      case "personal_sign": {
        // Standard shape is [message, address]; tolerate swapped params
        assertRequestedSigner(
          [requestParams[1], requestParams[0]].find(isAddressShaped)
        );
        const message = requestParams[0] as Hex;
        result = await account.signMessage({
          message: { raw: message },
        });
        break;
      }

      case "eth_signTypedData":
      case "eth_signTypedData_v4": {
        // Standard shape is [address, typedDataJson]
        assertRequestedSigner(
          isAddressShaped(requestParams[0]) ? requestParams[0] : undefined
        );
        const typedData = JSON.parse(requestParams[1] as string);
        result = await account.signTypedData(typedData);
        break;
      }

      case "eth_sendTransaction": {
        const tx = requestParams[0] as {
          from: string;
          to: string;
          value?: string;
          data?: string;
          gas?: string;
          gasPrice?: string;
        };
        // An absent from means the wallet's own account
        assertRequestedSigner(tx.from);

        // Get chain info dynamically. No fallback: signing against a
        // silently substituted chain is worse than failing.
        const { createWalletClientForNetwork } = await import("./wallet");
        const chainId = params.chainId.split(":")[1];
        const networkId = getChainIdToNetworkMap()[chainId];
        const chain = getSupportedChains()[`eip155:${chainId}`];
        if (!networkId || !chain) {
          throw new Error(`Unsupported chain eip155:${chainId}`);
        }

        const walletClient = createWalletClientForNetwork(account, networkId);

        const hash = await walletClient.sendTransaction({
          account,
          chain,
          to: tx.to as Hex,
          value: tx.value ? BigInt(tx.value) : undefined,
          data: tx.data as Hex | undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
        });

        result = hash;
        break;
      }

      default:
        throw new Error(`Unsupported method: ${method}`);
    }

    await wk.respondSessionRequest({
      topic,
      response: {
        id,
        jsonrpc: "2.0",
        result,
      },
    });

    return result;
  } catch (error) {
    console.error("Error handling request:", error);
    // Best-effort error response to the dApp, then rethrow so the wallet UI
    // shows the real failure instead of a silent null.
    try {
      await wk.respondSessionRequest({
        topic,
        response: {
          id,
          jsonrpc: "2.0",
          error: {
            code: 5000,
            message: error instanceof Error ? error.message : "Unknown error",
          },
        },
      });
    } catch (respondError) {
      console.error("Failed to respond with error to dApp:", respondError);
    }
    throw error;
  }
}

export interface RequestDisplay {
  method: string;
  description: string;
  details: string;
  // Context the user must see before approving: which chain, which origin,
  // and (for transactions) recipient and value.
  chainId: string;
  chainName: string;
  origin?: string;
  to?: string;
  value?: string;
}

// Format request for display
export function formatRequestDisplay(request: SessionRequest): RequestDisplay {
  const { method, params } = request.params.request;

  // Resolve the target chain name; never substitute a different chain
  const rawChainId = request.params.chainId.split(":")[1];
  const networkId = getChainIdToNetworkMap()[rawChainId];
  const chainName = networkId
    ? getAllNetworks()[networkId]?.name ?? networkId
    : `Unknown chain (eip155:${rawChainId})`;
  const context = {
    chainId: request.params.chainId,
    chainName,
    origin: request.verifyContext?.verified?.origin || undefined,
  };

  switch (method) {
    case "personal_sign": {
      const message = params[0] as string;
      let decodedMessage = message;
      try {
        // Try to decode hex message
        if (message.startsWith("0x")) {
          decodedMessage = Buffer.from(message.slice(2), "hex").toString(
            "utf8"
          );
        }
      } catch {
        // Keep original if decoding fails
      }
      return {
        ...context,
        method: "Sign Message",
        description: "The dApp is requesting you to sign a message",
        details:
          decodedMessage.length > 200
            ? decodedMessage.slice(0, 200) + "..."
            : decodedMessage,
      };
    }

    case "eth_signTypedData":
    case "eth_signTypedData_v4": {
      const typedData = JSON.parse(params[1] as string);
      return {
        ...context,
        method: "Sign Typed Data",
        description: "The dApp is requesting you to sign structured data",
        details: JSON.stringify(typedData.message || typedData, null, 2).slice(
          0,
          300
        ),
      };
    }

    case "eth_sendTransaction": {
      const tx = params[0] as { to: string; value?: string; data?: string };
      const value = tx.value ? formatEther(BigInt(tx.value)) : "0";
      const shortTo = `${tx.to.slice(0, 8)}...${tx.to.slice(-6)}`;
      const isContractCall = !!tx.data && tx.data !== "0x";
      // A contract call with zero value is not an "ETH send" - only frame it
      // that way for an actual native-value transfer.
      let description: string;
      if (isContractCall) {
        description =
          value !== "0"
            ? `Contract interaction with ${shortTo} (sending ${value} ETH)`
            : `Contract interaction with ${shortTo}`;
      } else {
        description = `Send ${value} ETH to ${shortTo}`;
      }
      return {
        ...context,
        method: "Send Transaction",
        description,
        details: isContractCall
          ? `Contract interaction with data: ${tx.data!.slice(0, 66)}...`
          : "Simple ETH transfer",
        to: tx.to,
        value: `${value} ETH`,
      };
    }

    default:
      return {
        ...context,
        method,
        description: "Unknown request type",
        details: JSON.stringify(params).slice(0, 200),
      };
  }
}
