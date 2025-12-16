import { createPublicClient, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";

// Uniswap V3 Pool ABI (only what we need)
const poolAbi = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() external view returns (address)",
]);

// Mainnet USDC/WETH 0.05% pool - most liquid for ETH price
const ETH_POOL_ADDRESS = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640" as const;

// Mainnet MATIC(POL)/WETH 0.3% pool for POL price
const POL_POOL_ADDRESS = "0x290A6a7460B308ee3F19023D2D00dE604bcf5B42" as const;

// Token addresses
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase();
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
const POL_ADDRESS = "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0".toLowerCase();

// Alchemy API Key
const ALCHEMY_API_KEY = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || "";
const RPC_URL = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

// Price cache for different tokens
const priceCache: Record<string, { price: number; timestamp: number }> = {};
const CACHE_DURATION = 30000; // 30 seconds

// Networks that use ETH as native currency
const ETH_NETWORKS = ["mainnet", "arbitrum", "base", "optimism", "linea", "zksync"];
// Networks that use POL as native currency
const POL_NETWORKS = ["polygon"];

/**
 * Convert Uniswap V3 tick to price
 * price = 1.0001^tick
 */
function tickToPrice(tick: number, token0IsUSDC: boolean): number {
  // price = 1.0001^tick gives us token1/token0 ratio
  const price = Math.pow(1.0001, tick);

  // Decimal adjustment: USDC has 6 decimals, WETH has 18
  const decimalAdjustment = Math.pow(10, 6 - 18); // 10^-12

  if (token0IsUSDC) {
    // token0 = USDC, token1 = WETH
    // price = WETH/USDC (raw), we want USDC/WETH (USD per ETH)
    return 1 / (price * decimalAdjustment);
  } else {
    // token0 = WETH, token1 = USDC
    return price * decimalAdjustment;
  }
}

/**
 * Get ETH price in USD from Uniswap V3 mainnet pool
 */
export async function getETHPrice(): Promise<number> {
  // Check cache first
  if (priceCache["eth"] && Date.now() - priceCache["eth"].timestamp < CACHE_DURATION) {
    return priceCache["eth"].price;
  }

  const client = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL),
  });

  try {
    // Get slot0 for current tick
    const slot0 = await client.readContract({
      address: ETH_POOL_ADDRESS,
      abi: poolAbi,
      functionName: "slot0",
    });

    const tick = Number(slot0[1]);

    // Get token0 to verify price direction
    const token0 = await client.readContract({
      address: ETH_POOL_ADDRESS,
      abi: poolAbi,
      functionName: "token0",
    });

    const token0IsUSDC = token0.toLowerCase() === USDC_ADDRESS;

    // Calculate price from tick
    const price = tickToPrice(tick, token0IsUSDC);

    // Sanity check - ETH should be between $100 and $100,000
    if (price < 100 || price > 100000) {
      console.warn(`ETH price seems off: $${price.toFixed(2)}`);
      if (priceCache["eth"]) return priceCache["eth"].price;
      return 0;
    }

    // Cache the result
    priceCache["eth"] = { price, timestamp: Date.now() };

    console.log(`ETH price: $${price.toFixed(2)} (tick: ${tick})`);
    return price;
  } catch (error) {
    console.error("Failed to get ETH price:", error);

    // Return cached price if available
    if (priceCache["eth"]) return priceCache["eth"].price;

    return 0;
  }
}

/**
 * Convert tick to price ratio for POL/WETH pool
 * Both tokens have 18 decimals so no decimal adjustment needed
 */
function tickToPOLRatio(tick: number, token0IsPOL: boolean): number {
  // price = 1.0001^tick gives us token1/token0 ratio
  const price = Math.pow(1.0001, tick);

  if (token0IsPOL) {
    // token0 = POL, token1 = WETH
    // price = WETH/POL, this is how much WETH per 1 POL
    return price;
  } else {
    // token0 = WETH, token1 = POL
    // price = POL/WETH, we want WETH/POL
    return 1 / price;
  }
}

/**
 * Get POL price in USD from Uniswap V3 mainnet pool
 * Uses POL/WETH pool and multiplies by ETH price
 */
export async function getPOLPrice(): Promise<number> {
  // Check cache first
  if (priceCache["pol"] && Date.now() - priceCache["pol"].timestamp < CACHE_DURATION) {
    return priceCache["pol"].price;
  }

  const client = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL),
  });

  try {
    // First get ETH price
    const ethPrice = await getETHPrice();
    if (ethPrice === 0) {
      throw new Error("Could not get ETH price");
    }

    // Get slot0 for current tick from POL/WETH pool
    const slot0 = await client.readContract({
      address: POL_POOL_ADDRESS,
      abi: poolAbi,
      functionName: "slot0",
    });

    const tick = Number(slot0[1]);

    // Get token0 to verify price direction
    const token0 = await client.readContract({
      address: POL_POOL_ADDRESS,
      abi: poolAbi,
      functionName: "token0",
    });

    const token0IsPOL = token0.toLowerCase() === POL_ADDRESS;

    // Calculate POL price in ETH (how much ETH is 1 POL worth)
    const polInEth = tickToPOLRatio(tick, token0IsPOL);

    // POL price in USD = POL/ETH ratio * ETH price
    const price = polInEth * ethPrice;

    // Sanity check - POL should be between $0.01 and $100
    if (price < 0.01 || price > 100) {
      console.warn(`POL price seems off: $${price.toFixed(4)}`);
      if (priceCache["pol"]) return priceCache["pol"].price;
      return 0;
    }

    // Cache the result
    priceCache["pol"] = { price, timestamp: Date.now() };

    console.log(`POL price: $${price.toFixed(4)} (tick: ${tick}, ETH: $${ethPrice.toFixed(2)})`);
    return price;
  } catch (error) {
    console.error("Failed to get POL price:", error);

    // Return cached price if available
    if (priceCache["pol"]) return priceCache["pol"].price;

    return 0;
  }
}

/**
 * Get native token price for a specific network
 */
export async function getNativeTokenPrice(networkId: string): Promise<number> {
  if (POL_NETWORKS.includes(networkId)) {
    return getPOLPrice();
  }
  // Default to ETH price for all ETH-based networks
  return getETHPrice();
}

/**
 * Get native token symbol for a network
 */
export function getNativeTokenSymbol(networkId: string): string {
  if (POL_NETWORKS.includes(networkId)) {
    return "POL";
  }
  return "ETH";
}

/**
 * Format USD value for display
 */
export function formatUSD(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  if (value < 1) return `$${value.toFixed(2)}`;
  if (value < 1000) return `$${value.toFixed(2)}`;
  if (value < 10000) return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (value < 1000000) return `$${(value / 1000).toFixed(1)}K`;
  return `$${(value / 1000000).toFixed(2)}M`;
}

/**
 * Calculate USD value of ETH amount
 */
export function calculateUSDValue(ethAmount: string, ethPrice: number): number {
  const amount = parseFloat(ethAmount) || 0;
  return amount * ethPrice;
}
