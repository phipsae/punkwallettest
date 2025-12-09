import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  type PublicClient,
  type WalletClient,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia, arbitrum, base } from "viem/chains";

// Supported networks
export const NETWORKS: Record<string, Chain> = {
  mainnet,
  sepolia,
  arbitrum,
  base,
};

// Default to Sepolia for testing
const DEFAULT_NETWORK = "sepolia";

// Alchemy API Key from environment
const ALCHEMY_API_KEY = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || "";

// RPC URLs - using Alchemy endpoints
const RPC_URLS: Record<string, string> = {
  mainnet: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  sepolia: `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  base: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
};

export interface WalletState {
  address: `0x${string}`;
  balance: string;
  balanceWei: bigint;
  network: string;
}

export interface TransactionResult {
  hash: `0x${string}`;
  success: boolean;
  error?: string;
}

// Create public client for reading blockchain data
export function createPublicClientForNetwork(
  networkId: string = DEFAULT_NETWORK
): PublicClient {
  const chain = NETWORKS[networkId] || NETWORKS[DEFAULT_NETWORK];
  const rpcUrl = RPC_URLS[networkId] || RPC_URLS[DEFAULT_NETWORK];

  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

// Create wallet client for signing transactions
export function createWalletClientForNetwork(
  privateKey: `0x${string}`,
  networkId: string = DEFAULT_NETWORK
): WalletClient {
  const chain = NETWORKS[networkId] || NETWORKS[DEFAULT_NETWORK];
  const rpcUrl = RPC_URLS[networkId] || RPC_URLS[DEFAULT_NETWORK];
  const account = privateKeyToAccount(privateKey);

  return createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });
}

// Get wallet balance
export async function getBalance(
  address: `0x${string}`,
  networkId: string = DEFAULT_NETWORK
): Promise<{ formatted: string; wei: bigint }> {
  const client = createPublicClientForNetwork(networkId);

  try {
    const balance = await client.getBalance({ address });
    return {
      formatted: formatEther(balance),
      wei: balance,
    };
  } catch (error) {
    console.error("Failed to get balance:", error);
    return { formatted: "0", wei: BigInt(0) };
  }
}

// Send ETH transaction
export async function sendETH(
  privateKey: `0x${string}`,
  to: `0x${string}`,
  amountEth: string,
  networkId: string = DEFAULT_NETWORK
): Promise<TransactionResult> {
  const walletClient = createWalletClientForNetwork(privateKey, networkId);
  const publicClient = createPublicClientForNetwork(networkId);

  try {
    const account = privateKeyToAccount(privateKey);

    // Parse amount to wei
    const value = parseEther(amountEth);

    // Estimate gas
    const gasEstimate = await publicClient.estimateGas({
      account: account.address,
      to,
      value,
    });

    // Get the chain
    const chain = NETWORKS[networkId] || NETWORKS[DEFAULT_NETWORK];

    // Send transaction
    const hash = await walletClient.sendTransaction({
      account,
      chain,
      to,
      value,
      gas: gasEstimate,
    });

    return {
      hash,
      success: true,
    };
  } catch (error) {
    console.error("Transaction failed:", error);
    return {
      hash: "0x0" as `0x${string}`,
      success: false,
      error: error instanceof Error ? error.message : "Transaction failed",
    };
  }
}

// Validate Ethereum address
export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Format address for display
export function formatAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Get transaction explorer URL
export function getExplorerUrl(
  hash: string,
  networkId: string = DEFAULT_NETWORK
): string {
  const explorers: Record<string, string> = {
    mainnet: "https://etherscan.io/tx/",
    sepolia: "https://sepolia.etherscan.io/tx/",
    arbitrum: "https://arbiscan.io/tx/",
    base: "https://basescan.org/tx/",
  };

  return `${explorers[networkId] || explorers.sepolia}${hash}`;
}

// Get address explorer URL
export function getAddressExplorerUrl(
  address: string,
  networkId: string = DEFAULT_NETWORK
): string {
  const explorers: Record<string, string> = {
    mainnet: "https://etherscan.io/address/",
    sepolia: "https://sepolia.etherscan.io/address/",
    arbitrum: "https://arbiscan.io/address/",
    base: "https://basescan.org/address/",
  };

  return `${explorers[networkId] || explorers.sepolia}${address}`;
}
