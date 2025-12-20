// Storage for favorite dApps and browser history

export interface DApp {
  id: string;
  name: string;
  url: string;
  icon?: string;
  category: 'defi' | 'nft' | 'gaming' | 'social' | 'utility' | 'other';
  isCustom: boolean;
  lastVisited?: number;
}

// Storage keys
const FAVORITE_DAPPS_KEY = 'punk_wallet_favorite_dapps';
const RECENT_DAPPS_KEY = 'punk_wallet_recent_dapps';
const CONNECTED_DAPPS_KEY = 'punk_wallet_connected_dapps';

// Default popular dApps
export const DEFAULT_DAPPS: DApp[] = [
  {
    id: 'uniswap',
    name: 'Uniswap',
    url: 'https://app.uniswap.org',
    icon: 'https://app.uniswap.org/favicon.ico',
    category: 'defi',
    isCustom: false,
  },
  {
    id: 'aave',
    name: 'Aave',
    url: 'https://app.aave.com',
    icon: 'https://app.aave.com/favicon.ico',
    category: 'defi',
    isCustom: false,
  },
  {
    id: '1inch',
    name: '1inch',
    url: 'https://app.1inch.io',
    icon: 'https://app.1inch.io/favicon.ico',
    category: 'defi',
    isCustom: false,
  },
  {
    id: 'opensea',
    name: 'OpenSea',
    url: 'https://opensea.io',
    icon: 'https://opensea.io/favicon.ico',
    category: 'nft',
    isCustom: false,
  },
  {
    id: 'lido',
    name: 'Lido',
    url: 'https://stake.lido.fi',
    icon: 'https://stake.lido.fi/favicon.ico',
    category: 'defi',
    isCustom: false,
  },
  {
    id: 'curve',
    name: 'Curve',
    url: 'https://curve.fi',
    icon: 'https://curve.fi/favicon.ico',
    category: 'defi',
    isCustom: false,
  },
  {
    id: 'compound',
    name: 'Compound',
    url: 'https://app.compound.finance',
    icon: 'https://app.compound.finance/favicon.ico',
    category: 'defi',
    isCustom: false,
  },
  {
    id: 'ens',
    name: 'ENS',
    url: 'https://app.ens.domains',
    icon: 'https://app.ens.domains/favicon.ico',
    category: 'utility',
    isCustom: false,
  },
  {
    id: 'zora',
    name: 'Zora',
    url: 'https://zora.co',
    icon: 'https://zora.co/favicon.ico',
    category: 'nft',
    isCustom: false,
  },
  {
    id: 'blur',
    name: 'Blur',
    url: 'https://blur.io',
    icon: 'https://blur.io/favicon.ico',
    category: 'nft',
    isCustom: false,
  },
  {
    id: 'gmx',
    name: 'GMX',
    url: 'https://app.gmx.io',
    icon: 'https://app.gmx.io/favicon.ico',
    category: 'defi',
    isCustom: false,
  },
  {
    id: 'balancer',
    name: 'Balancer',
    url: 'https://app.balancer.fi',
    icon: 'https://app.balancer.fi/favicon.ico',
    category: 'defi',
    isCustom: false,
  },
];

// Get all favorite dApps (defaults + custom)
export function getFavoriteDApps(): DApp[] {
  if (typeof window === 'undefined') return DEFAULT_DAPPS;

  try {
    const stored = localStorage.getItem(FAVORITE_DAPPS_KEY);
    if (!stored) {
      // Initialize with defaults
      localStorage.setItem(FAVORITE_DAPPS_KEY, JSON.stringify(DEFAULT_DAPPS));
      return DEFAULT_DAPPS;
    }
    return JSON.parse(stored) as DApp[];
  } catch {
    return DEFAULT_DAPPS;
  }
}

// Add a custom dApp to favorites
export function addFavoriteDApp(dapp: Omit<DApp, 'id' | 'isCustom'>): DApp {
  const favorites = getFavoriteDApps();

  // Generate ID from URL
  const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const newDApp: DApp = {
    ...dapp,
    id,
    isCustom: true,
  };

  // Check if URL already exists
  const exists = favorites.some(d => d.url === dapp.url);
  if (exists) {
    throw new Error('This dApp is already in your favorites');
  }

  favorites.push(newDApp);
  localStorage.setItem(FAVORITE_DAPPS_KEY, JSON.stringify(favorites));

  return newDApp;
}

// Remove a dApp from favorites
export function removeFavoriteDApp(id: string): void {
  const favorites = getFavoriteDApps();
  const filtered = favorites.filter(d => d.id !== id);
  localStorage.setItem(FAVORITE_DAPPS_KEY, JSON.stringify(filtered));
}

// Update a dApp in favorites
export function updateFavoriteDApp(id: string, updates: Partial<DApp>): void {
  const favorites = getFavoriteDApps();
  const index = favorites.findIndex(d => d.id === id);

  if (index !== -1) {
    favorites[index] = { ...favorites[index], ...updates };
    localStorage.setItem(FAVORITE_DAPPS_KEY, JSON.stringify(favorites));
  }
}

// Reset favorites to defaults
export function resetFavoriteDApps(): void {
  localStorage.setItem(FAVORITE_DAPPS_KEY, JSON.stringify(DEFAULT_DAPPS));
}

// Get recently visited dApps
export function getRecentDApps(): DApp[] {
  if (typeof window === 'undefined') return [];

  try {
    const stored = localStorage.getItem(RECENT_DAPPS_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as DApp[];
  } catch {
    return [];
  }
}

// Add to recent dApps (keeps last 10)
export function addRecentDApp(dapp: DApp): void {
  const recents = getRecentDApps();

  // Remove if already exists
  const filtered = recents.filter(d => d.url !== dapp.url);

  // Add to front with timestamp
  filtered.unshift({ ...dapp, lastVisited: Date.now() });

  // Keep only last 10
  const trimmed = filtered.slice(0, 10);

  localStorage.setItem(RECENT_DAPPS_KEY, JSON.stringify(trimmed));
}

// Clear recent dApps
export function clearRecentDApps(): void {
  localStorage.removeItem(RECENT_DAPPS_KEY);
}

// Connected dApps tracking (for session management)
export interface ConnectedDApp {
  origin: string;
  name: string;
  icon?: string;
  connectedAt: number;
  address: string;
}

// Get connected dApps for an address
export function getConnectedDApps(address: string): ConnectedDApp[] {
  if (typeof window === 'undefined') return [];

  try {
    const stored = localStorage.getItem(CONNECTED_DAPPS_KEY);
    if (!stored) return [];
    const all = JSON.parse(stored) as Record<string, ConnectedDApp[]>;
    return all[address.toLowerCase()] || [];
  } catch {
    return [];
  }
}

// Mark a dApp as connected
export function markDAppConnected(address: string, dapp: Omit<ConnectedDApp, 'connectedAt' | 'address'>): void {
  const stored = localStorage.getItem(CONNECTED_DAPPS_KEY);
  const all: Record<string, ConnectedDApp[]> = stored ? JSON.parse(stored) : {};

  const addressKey = address.toLowerCase();
  const connections = all[addressKey] || [];

  // Remove existing connection from same origin
  const filtered = connections.filter(d => d.origin !== dapp.origin);

  filtered.push({
    ...dapp,
    address: addressKey,
    connectedAt: Date.now(),
  });

  all[addressKey] = filtered;
  localStorage.setItem(CONNECTED_DAPPS_KEY, JSON.stringify(all));
}

// Disconnect a dApp
export function disconnectDApp(address: string, origin: string): void {
  const stored = localStorage.getItem(CONNECTED_DAPPS_KEY);
  if (!stored) return;

  const all: Record<string, ConnectedDApp[]> = JSON.parse(stored);
  const addressKey = address.toLowerCase();

  if (all[addressKey]) {
    all[addressKey] = all[addressKey].filter(d => d.origin !== origin);
    localStorage.setItem(CONNECTED_DAPPS_KEY, JSON.stringify(all));
  }
}

// Check if a dApp is connected for an address
export function isDAppConnected(address: string, origin: string): boolean {
  const connections = getConnectedDApps(address);
  return connections.some(d => d.origin === origin);
}

// Get dApp info from URL
export function getDAppFromUrl(url: string): DApp | null {
  try {
    const urlObj = new URL(url);
    const favorites = getFavoriteDApps();

    // Check if URL matches any favorite
    const match = favorites.find(d => {
      const dappUrl = new URL(d.url);
      return dappUrl.hostname === urlObj.hostname;
    });

    if (match) return match;

    // Return a generic dApp object for unknown URLs
    return {
      id: `unknown_${urlObj.hostname}`,
      name: urlObj.hostname.replace('www.', '').split('.')[0],
      url: urlObj.origin,
      category: 'other',
      isCustom: false,
    };
  } catch {
    return null;
  }
}

// Validate URL
export function isValidDAppUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'https:' || urlObj.protocol === 'http:';
  } catch {
    return false;
  }
}

// Format URL for display
export function formatDAppUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '');
  } catch {
    return url;
  }
}



