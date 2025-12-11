import { createPublicClient, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";

// Uniswap V3 Pool ABI (only what we need)
const poolAbi = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() external view returns (address)",
]);

// Mainnet USDC/WETH 0.05% pool - most liquid
const POOL_ADDRESS = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640" as const;

// USDC is token0 in this pool
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase();

// Alchemy API Key
const ALCHEMY_API_KEY = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || "";
const RPC_URL = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

// Price cache
let priceCache: { price: number; timestamp: number } | null = null;
const CACHE_DURATION = 30000; // 30 seconds

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
  if (priceCache && Date.now() - priceCache.timestamp < CACHE_DURATION) {
    return priceCache.price;
  }

  const client = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL),
  });

  try {
    // Get slot0 for current tick
    const slot0 = await client.readContract({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "slot0",
    });

    const tick = Number(slot0[1]);

    // Get token0 to verify price direction
    const token0 = await client.readContract({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "token0",
    });

    const token0IsUSDC = token0.toLowerCase() === USDC_ADDRESS;

    // Calculate price from tick
    const price = tickToPrice(tick, token0IsUSDC);

    // Sanity check - ETH should be between $100 and $100,000
    if (price < 100 || price > 100000) {
      console.warn(`ETH price seems off: $${price.toFixed(2)}`);
      if (priceCache) return priceCache.price;
      return 0;
    }

    // Cache the result
    priceCache = { price, timestamp: Date.now() };

    console.log(`ETH price: $${price.toFixed(2)} (tick: ${tick})`);
    return price;
  } catch (error) {
    console.error("Failed to get ETH price:", error);

    // Return cached price if available
    if (priceCache) return priceCache.price;

    return 0;
  }
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
