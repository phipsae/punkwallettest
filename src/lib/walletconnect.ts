import { Core } from "@walletconnect/core";
import { WalletKit, WalletKitTypes } from "@reown/walletkit";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import { formatEther, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, mainnet } from "viem/chains";

// WalletConnect Project ID - Get yours at https://cloud.walletconnect.com
const PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "demo-project-id";

// Supported chains
const SUPPORTED_CHAINS = {
  "eip155:1": mainnet,
  "eip155:11155111": sepolia,
};

const SUPPORTED_METHODS = [
  "eth_sendTransaction",
  "eth_sign",
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

// Initialize WalletConnect
export async function initWalletConnect(): Promise<
  InstanceType<typeof WalletKit>
> {
  if (walletKit) return walletKit;

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
    if (eventCallbacks.onSessionRequest) {
      eventCallbacks.onSessionRequest(request as SessionRequest);
    }
  });

  walletKit.on("session_delete", async (event) => {
    console.log("Session deleted:", event);
    if (eventCallbacks.onSessionDelete) {
      eventCallbacks.onSessionDelete(event.topic);
    }
  });

  return walletKit;
}

// Set event callbacks
export function setEventCallbacks(callbacks: EventCallback) {
  eventCallbacks = { ...eventCallbacks, ...callbacks };
}

// Connect to a dApp using WalletConnect URI
export async function connectWithUri(uri: string): Promise<void> {
  const wk = await initWalletConnect();
  await wk.pair({ uri });
}

// Approve a session proposal
export async function approveSession(
  proposalId: number,
  proposal: WalletKitTypes.SessionProposal["params"],
  address: string
): Promise<ActiveSession> {
  const wk = await initWalletConnect();

  // Build namespaces based on what the dApp requested
  const namespaces = buildApprovedNamespaces({
    proposal,
    supportedNamespaces: {
      eip155: {
        chains: Object.keys(SUPPORTED_CHAINS),
        methods: SUPPORTED_METHODS,
        events: SUPPORTED_EVENTS,
        accounts: Object.keys(SUPPORTED_CHAINS).map(
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
  await wk.rejectSession({
    id: proposalId,
    reason: getSdkError("USER_REJECTED"),
  });
}

// Get all active sessions
export async function getActiveSessions(): Promise<ActiveSession[]> {
  const wk = await initWalletConnect();
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
  await wk.disconnectSession({
    topic,
    reason: getSdkError("USER_DISCONNECTED"),
  });
}

// Handle a session request (sign transaction, message, etc.)
export async function handleSessionRequest(
  request: SessionRequest,
  privateKey: Hex,
  approve: boolean
): Promise<string | null> {
  const wk = await initWalletConnect();
  const { id, topic, params } = request;
  const { method, params: requestParams } = params.request;

  if (!approve) {
    await wk.respondSessionRequest({
      topic,
      response: {
        id,
        jsonrpc: "2.0",
        error: getSdkError("USER_REJECTED"),
      },
    });
    return null;
  }

  try {
    const account = privateKeyToAccount(privateKey);
    let result: string;

    switch (method) {
      case "personal_sign": {
        const message = requestParams[0] as Hex;
        result = await account.signMessage({
          message: { raw: message },
        });
        break;
      }

      case "eth_sign": {
        const message = requestParams[1] as Hex;
        result = await account.signMessage({
          message: { raw: message },
        });
        break;
      }

      case "eth_signTypedData":
      case "eth_signTypedData_v4": {
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

        // For now, we'll just sign the transaction
        // In a real implementation, you'd broadcast it to the network
        const { createWalletClientForNetwork } = await import("./wallet");
        const chainId = params.chainId.split(":")[1];
        const networkId = chainId === "1" ? "mainnet" : "sepolia";
        const walletClient = createWalletClientForNetwork(
          privateKey,
          networkId
        );

        const hash = await walletClient.sendTransaction({
          account,
          chain: chainId === "1" ? mainnet : sepolia,
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
    return null;
  }
}

// Format request for display
export function formatRequestDisplay(request: SessionRequest): {
  method: string;
  description: string;
  details: string;
} {
  const { method, params } = request.params.request;

  switch (method) {
    case "personal_sign":
    case "eth_sign": {
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
      return {
        method: "Send Transaction",
        description: `Send ${value} ETH to ${tx.to.slice(0, 8)}...${tx.to.slice(
          -6
        )}`,
        details: tx.data
          ? `Contract interaction with data: ${tx.data.slice(0, 66)}...`
          : "Simple ETH transfer",
      };
    }

    default:
      return {
        method,
        description: "Unknown request type",
        details: JSON.stringify(params).slice(0, 200),
      };
  }
}
