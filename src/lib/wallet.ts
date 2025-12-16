import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  type PublicClient,
  type WalletClient,
  type Chain,
  defineChain,
} from "viem";
import { normalize } from "viem/ens";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, arbitrum, base, optimism, linea, zkSync, polygon } from "viem/chains";

// Custom network interface for user-added networks
export interface CustomNetwork {
  id: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  symbol: string;
  explorerUrl?: string;
  isCustom: true;
}

// Local storage key for custom networks
const CUSTOM_NETWORKS_KEY = "punk_wallet_custom_networks";

// Default supported networks
export const DEFAULT_NETWORKS: Record<string, Chain> = {
  mainnet,
  arbitrum,
  base,
  optimism,
  linea,
  zksync: zkSync,
  polygon,
};

// Default to Base
const DEFAULT_NETWORK = "base";

// Alchemy API Key from environment
const ALCHEMY_API_KEY = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || "";

// Default RPC URLs - using Alchemy endpoints
const DEFAULT_RPC_URLS: Record<string, string> = {
  mainnet: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  base: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  optimism: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  linea: `https://linea-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  zksync: `https://zksync-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  polygon: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
};

// Get custom networks from local storage
export function getCustomNetworks(): CustomNetwork[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(CUSTOM_NETWORKS_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as CustomNetwork[];
  } catch {
    return [];
  }
}

// Save custom network to local storage
export function addCustomNetwork(network: Omit<CustomNetwork, "isCustom">): boolean {
  if (typeof window === "undefined") return false;
  try {
    const customNetworks = getCustomNetworks();
    // Check if network with same id or chainId already exists
    const existsById = customNetworks.some((n) => n.id.toLowerCase() === network.id.toLowerCase());
    const existsByChainId = customNetworks.some((n) => n.chainId === network.chainId);
    const isDefaultNetwork = Object.keys(DEFAULT_NETWORKS).includes(network.id.toLowerCase());

    if (existsById || existsByChainId || isDefaultNetwork) {
      return false;
    }

    customNetworks.push({ ...network, isCustom: true });
    localStorage.setItem(CUSTOM_NETWORKS_KEY, JSON.stringify(customNetworks));
    return true;
  } catch (error) {
    console.error("Failed to save custom network:", error);
    return false;
  }
}

// Remove custom network from local storage
export function removeCustomNetwork(networkId: string): void {
  if (typeof window === "undefined") return;
  try {
    const customNetworks = getCustomNetworks();
    const filtered = customNetworks.filter((n) => n.id !== networkId);
    localStorage.setItem(CUSTOM_NETWORKS_KEY, JSON.stringify(filtered));
  } catch (error) {
    console.error("Failed to remove custom network:", error);
  }
}

// Convert CustomNetwork to viem Chain
function customNetworkToChain(network: CustomNetwork): Chain {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: {
      name: network.symbol,
      symbol: network.symbol,
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: [network.rpcUrl],
      },
    },
    blockExplorers: network.explorerUrl
      ? {
          default: {
            name: "Explorer",
            url: network.explorerUrl,
          },
        }
      : undefined,
  });
}

// Get all networks (default + custom)
export function getAllNetworks(): Record<string, Chain> {
  const customNetworks = getCustomNetworks();
  const allNetworks = { ...DEFAULT_NETWORKS };

  for (const customNet of customNetworks) {
    allNetworks[customNet.id] = customNetworkToChain(customNet);
  }

  return allNetworks;
}

// Get RPC URL for a network
export function getRpcUrl(networkId: string): string {
  // Check default RPC URLs first
  if (DEFAULT_RPC_URLS[networkId]) {
    return DEFAULT_RPC_URLS[networkId];
  }

  // Check custom networks
  const customNetworks = getCustomNetworks();
  const customNet = customNetworks.find((n) => n.id === networkId);
  if (customNet) {
    return customNet.rpcUrl;
  }

  return DEFAULT_RPC_URLS[DEFAULT_NETWORK];
}

// Network logos - using official chain logos
const NETWORK_LOGOS: Record<string, string> = {
  mainnet: "https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg",
  arbitrum: "https://icons.llamao.fi/icons/chains/rsz_arbitrum.jpg",
  base: "https://icons.llamao.fi/icons/chains/rsz_base.jpg",
  optimism: "https://icons.llamao.fi/icons/chains/rsz_optimism.jpg",
  linea: "https://icons.llamao.fi/icons/chains/rsz_linea.jpg",
  zksync: "https://icons.llamao.fi/icons/chains/rsz_zksync%20era.jpg",
  polygon: "https://icons.llamao.fi/icons/chains/rsz_polygon.jpg",
};

// Get network display info
export interface NetworkInfo {
  id: string;
  name: string;
  symbol: string;
  isCustom: boolean;
  logo?: string;
}

export function getNetworkInfo(networkId: string): NetworkInfo {
  // Check default networks
  if (DEFAULT_NETWORKS[networkId]) {
    const chain = DEFAULT_NETWORKS[networkId];
    return {
      id: networkId,
      name: chain.name,
      symbol: chain.nativeCurrency.symbol,
      isCustom: false,
      logo: NETWORK_LOGOS[networkId],
    };
  }

  // Check custom networks
  const customNetworks = getCustomNetworks();
  const customNet = customNetworks.find((n) => n.id === networkId);
  if (customNet) {
    return {
      id: networkId,
      name: customNet.name,
      symbol: customNet.symbol,
      isCustom: true,
    };
  }

  // Fallback to base
  return {
    id: "base",
    name: "Base",
    symbol: "ETH",
    isCustom: false,
    logo: NETWORK_LOGOS["base"],
  };
}

// Get all network IDs
export function getAllNetworkIds(): string[] {
  const defaultIds = Object.keys(DEFAULT_NETWORKS);
  const customIds = getCustomNetworks().map((n) => n.id);
  return [...defaultIds, ...customIds];
}

// Export NETWORKS for backward compatibility (will be dynamic)
export const NETWORKS: Record<string, Chain> = DEFAULT_NETWORKS;

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
  const networks = getAllNetworks();
  const chain = networks[networkId] || networks[DEFAULT_NETWORK];
  const rpcUrl = getRpcUrl(networkId);

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
  const networks = getAllNetworks();
  const chain = networks[networkId] || networks[DEFAULT_NETWORK];
  const rpcUrl = getRpcUrl(networkId);
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
    const networks = getAllNetworks();
    const chain = networks[networkId] || networks[DEFAULT_NETWORK];

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

// Default explorer URLs
const DEFAULT_EXPLORERS: Record<string, string> = {
  mainnet: "https://etherscan.io",
  arbitrum: "https://arbiscan.io",
  base: "https://basescan.org",
  optimism: "https://optimistic.etherscan.io",
  linea: "https://lineascan.build",
  zksync: "https://explorer.zksync.io",
  polygon: "https://polygonscan.com",
};

// Get explorer base URL for a network
export function getExplorerBaseUrl(networkId: string): string {
  if (DEFAULT_EXPLORERS[networkId]) {
    return DEFAULT_EXPLORERS[networkId];
  }

  // Check custom networks
  const customNetworks = getCustomNetworks();
  const customNet = customNetworks.find((n) => n.id === networkId);
  if (customNet?.explorerUrl) {
    return customNet.explorerUrl;
  }

  return DEFAULT_EXPLORERS.base;
}

// Get transaction explorer URL
export function getExplorerUrl(
  hash: string,
  networkId: string = DEFAULT_NETWORK
): string {
  const baseUrl = getExplorerBaseUrl(networkId);
  return `${baseUrl}/tx/${hash}`;
}

// Get address explorer URL
export function getAddressExplorerUrl(
  address: string,
  networkId: string = DEFAULT_NETWORK
): string {
  const baseUrl = getExplorerBaseUrl(networkId);
  return `${baseUrl}/address/${address}`;
}

// Check if input looks like an ENS name
export function isENSName(input: string): boolean {
  // ENS names end with .eth or other TLDs like .xyz, .com, etc.
  // Support subdomains like punk.austingriffith.eth
  // Each label can contain alphanumeric and hyphens
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z0-9][a-zA-Z0-9-]*)*\.eth$/i.test(
      input
    ) ||
    /^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z0-9][a-zA-Z0-9-]*)*\.[a-zA-Z]{2,}$/i.test(
      input
    )
  );
}

// Resolve ENS name to address
// ENS is only on Ethereum mainnet, so we always use mainnet for resolution
export async function resolveENS(
  ensName: string
): Promise<`0x${string}` | null> {
  // Create a client specifically for mainnet (where ENS lives)
  const mainnetClient = createPublicClient({
    chain: mainnet,
    transport: http(DEFAULT_RPC_URLS.mainnet),
  });

  try {
    // Normalize the ENS name (handles unicode, etc.)
    const normalizedName = normalize(ensName);

    // Resolve the ENS name to an address
    const address = await mainnetClient.getEnsAddress({
      name: normalizedName,
    });

    return address;
  } catch (error) {
    console.error("ENS resolution failed:", error);
    return null;
  }
}

// Get ENS name for an address (reverse resolution)
export async function getENSName(
  address: `0x${string}`
): Promise<string | null> {
  const mainnetClient = createPublicClient({
    chain: mainnet,
    transport: http(DEFAULT_RPC_URLS.mainnet),
  });

  try {
    const name = await mainnetClient.getEnsName({
      address,
    });
    return name;
  } catch (error) {
    console.error("ENS reverse resolution failed:", error);
    return null;
  }
}
