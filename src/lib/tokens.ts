import {
  createPublicClient,
  http,
  formatUnits,
  parseUnits,
  type Hex,
  erc20Abi,
} from "viem";
import { createWalletClientForNetwork, getAllNetworks, getRpcUrl } from "./wallet";
import { privateKeyToAccount } from "viem/accounts";

// Token interface
export interface Token {
  address: Hex;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

// Token balance with token info
export interface TokenBalance {
  token: Token;
  balance: string;
  balanceRaw: bigint;
}

// Default tokens per network - popular tokens on each chain
export const DEFAULT_TOKENS: Record<string, Token[]> = {
  mainnet: [
    {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
      logoURI: "https://assets.coingecko.com/coins/images/325/small/Tether.png",
    },
    {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      logoURI: "https://assets.coingecko.com/coins/images/6319/small/usdc.png",
    },
    {
      address: "0x6B175474E89094C44Da98b954EecdecCB5BE1b6B",
      symbol: "DAI",
      name: "Dai Stablecoin",
      decimals: 18,
      logoURI:
        "https://assets.coingecko.com/coins/images/9956/small/Badge_Dai.png",
    },
    {
      address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      symbol: "WBTC",
      name: "Wrapped BTC",
      decimals: 8,
      logoURI:
        "https://assets.coingecko.com/coins/images/7598/small/wrapped_bitcoin_wbtc.png",
    },
    {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
      logoURI: "https://assets.coingecko.com/coins/images/2518/small/weth.png",
    },
  ],
  arbitrum: [
    {
      address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
      logoURI: "https://assets.coingecko.com/coins/images/325/small/Tether.png",
    },
    {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      logoURI: "https://assets.coingecko.com/coins/images/6319/small/usdc.png",
    },
    {
      address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
      symbol: "USDC.e",
      name: "Bridged USDC",
      decimals: 6,
      logoURI: "https://assets.coingecko.com/coins/images/6319/small/usdc.png",
    },
    {
      address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      symbol: "DAI",
      name: "Dai Stablecoin",
      decimals: 18,
      logoURI:
        "https://assets.coingecko.com/coins/images/9956/small/Badge_Dai.png",
    },
    {
      address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
      symbol: "WBTC",
      name: "Wrapped BTC",
      decimals: 8,
      logoURI:
        "https://assets.coingecko.com/coins/images/7598/small/wrapped_bitcoin_wbtc.png",
    },
    {
      address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
      logoURI: "https://assets.coingecko.com/coins/images/2518/small/weth.png",
    },
    {
      address: "0x912CE59144191C1204E64559FE8253a0e49E6548",
      symbol: "ARB",
      name: "Arbitrum",
      decimals: 18,
      logoURI:
        "https://assets.coingecko.com/coins/images/16547/small/photo_2023-03-29_21.47.00.jpeg",
    },
  ],
  base: [
    {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      logoURI: "https://assets.coingecko.com/coins/images/6319/small/usdc.png",
    },
    {
      address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
      symbol: "USDbC",
      name: "USD Base Coin",
      decimals: 6,
      logoURI: "https://assets.coingecko.com/coins/images/6319/small/usdc.png",
    },
    {
      address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      symbol: "DAI",
      name: "Dai Stablecoin",
      decimals: 18,
      logoURI:
        "https://assets.coingecko.com/coins/images/9956/small/Badge_Dai.png",
    },
    {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
      logoURI: "https://assets.coingecko.com/coins/images/2518/small/weth.png",
    },
  ],
};

// Note: RPC URLs are now managed centrally in wallet.ts via getRpcUrl()

// Local storage key for custom tokens
const CUSTOM_TOKENS_KEY = "punk_wallet_custom_tokens";

// Get custom tokens from local storage
export function getCustomTokens(networkId: string): Token[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(CUSTOM_TOKENS_KEY);
    if (!stored) return [];
    const allCustomTokens = JSON.parse(stored) as Record<string, Token[]>;
    return allCustomTokens[networkId] || [];
  } catch {
    return [];
  }
}

// Save custom token to local storage
export function addCustomToken(networkId: string, token: Token): void {
  if (typeof window === "undefined") return;
  try {
    const stored = localStorage.getItem(CUSTOM_TOKENS_KEY);
    const allCustomTokens = stored ? JSON.parse(stored) : {};
    if (!allCustomTokens[networkId]) {
      allCustomTokens[networkId] = [];
    }
    // Check if token already exists
    const exists = allCustomTokens[networkId].some(
      (t: Token) => t.address.toLowerCase() === token.address.toLowerCase()
    );
    if (!exists) {
      allCustomTokens[networkId].push(token);
      localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(allCustomTokens));
    }
  } catch (error) {
    console.error("Failed to save custom token:", error);
  }
}

// Remove custom token from local storage
export function removeCustomToken(
  networkId: string,
  tokenAddress: string
): void {
  if (typeof window === "undefined") return;
  try {
    const stored = localStorage.getItem(CUSTOM_TOKENS_KEY);
    if (!stored) return;
    const allCustomTokens = JSON.parse(stored) as Record<string, Token[]>;
    if (allCustomTokens[networkId]) {
      allCustomTokens[networkId] = allCustomTokens[networkId].filter(
        (t: Token) => t.address.toLowerCase() !== tokenAddress.toLowerCase()
      );
      localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(allCustomTokens));
    }
  } catch (error) {
    console.error("Failed to remove custom token:", error);
  }
}

// Get all tokens for a network (default + custom)
export function getTokensForNetwork(networkId: string): Token[] {
  const defaultTokens = DEFAULT_TOKENS[networkId] || [];
  const customTokens = getCustomTokens(networkId);
  return [...defaultTokens, ...customTokens];
}

// Create public client for a network
function getPublicClient(networkId: string) {
  const networks = getAllNetworks();
  const chain = networks[networkId] || networks["base"];
  const rpcUrl = getRpcUrl(networkId);

  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

// Get token balance for a single token
export async function getTokenBalance(
  address: Hex,
  token: Token,
  networkId: string
): Promise<TokenBalance> {
  const client = getPublicClient(networkId);

  try {
    const balance = await client.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });

    return {
      token,
      balance: formatUnits(balance, token.decimals),
      balanceRaw: balance,
    };
  } catch (error) {
    console.error(`Failed to get balance for ${token.symbol}:`, error);
    return {
      token,
      balance: "0",
      balanceRaw: BigInt(0),
    };
  }
}

// Get all token balances for a network
export async function getAllTokenBalances(
  address: Hex,
  networkId: string
): Promise<TokenBalance[]> {
  const tokens = getTokensForNetwork(networkId);

  const balances = await Promise.all(
    tokens.map((token) => getTokenBalance(address, token, networkId))
  );

  // Filter out zero balances for cleaner display, but keep all tokens available
  return balances;
}

// Get token info from contract (for adding custom tokens)
export async function getTokenInfo(
  tokenAddress: Hex,
  networkId: string
): Promise<Token | null> {
  const client = getPublicClient(networkId);

  try {
    const [name, symbol, decimals] = await Promise.all([
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "name",
      }),
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "symbol",
      }),
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    ]);

    return {
      address: tokenAddress,
      name: name as string,
      symbol: symbol as string,
      decimals: decimals as number,
    };
  } catch (error) {
    console.error("Failed to get token info:", error);
    return null;
  }
}

// Send ERC20 tokens
export async function sendToken(
  privateKey: Hex,
  token: Token,
  to: Hex,
  amount: string,
  networkId: string
): Promise<{ hash: Hex; success: boolean; error?: string }> {
  try {
    const account = privateKeyToAccount(privateKey);
    const walletClient = createWalletClientForNetwork(privateKey, networkId);
    const publicClient = getPublicClient(networkId);

    // Parse amount to token units
    const value = parseUnits(amount, token.decimals);

    // Estimate gas for the transfer
    const gasEstimate = await publicClient.estimateContractGas({
      address: token.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, value],
      account: account.address,
    });

    // Send the transaction
    const networks = getAllNetworks();
    const hash = await walletClient.writeContract({
      address: token.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, value],
      account,
      chain: networks[networkId],
      gas: gasEstimate,
    });

    return {
      hash,
      success: true,
    };
  } catch (error) {
    console.error("Token transfer failed:", error);
    return {
      hash: "0x0" as Hex,
      success: false,
      error: error instanceof Error ? error.message : "Token transfer failed",
    };
  }
}

// Format token amount for display
export function formatTokenAmount(amount: string): string {
  const num = parseFloat(amount);
  if (num === 0) return "0";
  if (num < 0.0001) return "<0.0001";
  if (num < 1) return num.toFixed(4);
  if (num < 1000) return num.toFixed(2);
  if (num < 1000000) return (num / 1000).toFixed(2) + "K";
  return (num / 1000000).toFixed(2) + "M";
}
