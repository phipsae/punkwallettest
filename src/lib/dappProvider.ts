// EIP-1193 Provider implementation for dApp Browser
// This creates an injected window.ethereum provider that bridges to our wallet

import { formatEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getAllNetworks, createWalletClientForNetwork } from './wallet';

// Message types for communication between iframe/webview and wallet
export interface ProviderRequest {
  id: number;
  method: string;
  params?: unknown[];
}

export interface ProviderResponse {
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface ProviderEvent {
  type: 'accountsChanged' | 'chainChanged' | 'connect' | 'disconnect';
  data: unknown;
}

// RPC Error codes per EIP-1193
export const RPC_ERRORS = {
  USER_REJECTED: { code: 4001, message: 'User rejected the request' },
  UNAUTHORIZED: { code: 4100, message: 'The requested method and/or account has not been authorized' },
  UNSUPPORTED_METHOD: { code: 4200, message: 'The Provider does not support the requested method' },
  DISCONNECTED: { code: 4900, message: 'The Provider is disconnected from all chains' },
  CHAIN_DISCONNECTED: { code: 4901, message: 'The Provider is not connected to the requested chain' },
  CHAIN_NOT_ADDED: { code: 4902, message: 'Unrecognized chain ID' },
};

// Supported methods
export const SUPPORTED_METHODS = [
  'eth_requestAccounts',
  'eth_accounts',
  'eth_chainId',
  'eth_sendTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'eth_getBalance',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'net_version',
];

// Get chain ID from network ID
export function getChainIdHex(networkId: string): string {
  const networks = getAllNetworks();
  const chain = networks[networkId];
  if (!chain) return '0x1'; // Default to mainnet
  return `0x${chain.id.toString(16)}`;
}

// Get chain ID number from network ID
export function getChainIdNumber(networkId: string): number {
  const networks = getAllNetworks();
  const chain = networks[networkId];
  if (!chain) return 1;
  return chain.id;
}

// Get network ID from chain ID
export function getNetworkIdFromChainId(chainId: number | string): string | null {
  const networks = getAllNetworks();
  const targetId = typeof chainId === 'string'
    ? parseInt(chainId.replace('0x', ''), 16)
    : chainId;

  for (const [networkId, chain] of Object.entries(networks)) {
    if (chain.id === targetId) {
      return networkId;
    }
  }
  return null;
}

// Format transaction request for display
export interface TransactionDisplay {
  type: 'transaction' | 'sign' | 'signTypedData';
  method: string;
  to?: string;
  value?: string;
  valueETH?: string;
  data?: string;
  message?: string;
  typedData?: unknown;
  gasEstimate?: string;
}

export function formatTransactionForDisplay(
  method: string,
  params: unknown[]
): TransactionDisplay {
  switch (method) {
    case 'eth_sendTransaction': {
      const tx = params[0] as {
        from?: string;
        to?: string;
        value?: string;
        data?: string;
        gas?: string;
      };
      const valueWei = tx.value ? BigInt(tx.value) : BigInt(0);
      return {
        type: 'transaction',
        method,
        to: tx.to,
        value: tx.value,
        valueETH: formatEther(valueWei),
        data: tx.data,
        gasEstimate: tx.gas,
      };
    }

    case 'personal_sign':
    case 'eth_sign': {
      const message = params[0] as string;
      let decodedMessage = message;
      try {
        if (message.startsWith('0x')) {
          decodedMessage = Buffer.from(message.slice(2), 'hex').toString('utf8');
        }
      } catch {
        // Keep original
      }
      return {
        type: 'sign',
        method,
        message: decodedMessage,
      };
    }

    case 'eth_signTypedData':
    case 'eth_signTypedData_v4': {
      const typedData = typeof params[1] === 'string'
        ? JSON.parse(params[1])
        : params[1];
      return {
        type: 'signTypedData',
        method,
        typedData,
        message: JSON.stringify(typedData.message || typedData, null, 2),
      };
    }

    default:
      return {
        type: 'sign',
        method,
        message: JSON.stringify(params),
      };
  }
}

// Handle provider requests
export async function handleProviderRequest(
  request: ProviderRequest,
  walletAddress: string,
  privateKey: Hex,
  networkId: string,
  onApprovalNeeded: (display: TransactionDisplay) => Promise<boolean>,
  onNetworkSwitch: (chainId: number) => Promise<boolean>
): Promise<ProviderResponse> {
  const { id, method, params = [] } = request;

  try {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts': {
        // Return connected accounts
        return { id, result: [walletAddress] };
      }

      case 'eth_chainId': {
        return { id, result: getChainIdHex(networkId) };
      }

      case 'net_version': {
        return { id, result: String(getChainIdNumber(networkId)) };
      }

      case 'wallet_switchEthereumChain': {
        const chainParam = params[0] as { chainId: string };
        const targetChainId = parseInt(chainParam.chainId.replace('0x', ''), 16);
        const targetNetworkId = getNetworkIdFromChainId(targetChainId);

        if (!targetNetworkId) {
          return {
            id,
            error: RPC_ERRORS.CHAIN_NOT_ADDED,
          };
        }

        const approved = await onNetworkSwitch(targetChainId);
        if (!approved) {
          return { id, error: RPC_ERRORS.USER_REJECTED };
        }

        return { id, result: null };
      }

      case 'wallet_addEthereumChain': {
        // For now, reject adding chains - user must add via settings
        return {
          id,
          error: {
            code: 4200,
            message: 'Please add custom networks through wallet settings',
          },
        };
      }

      case 'eth_sendTransaction': {
        const display = formatTransactionForDisplay(method, params);
        const approved = await onApprovalNeeded(display);

        if (!approved) {
          return { id, error: RPC_ERRORS.USER_REJECTED };
        }

        const tx = params[0] as {
          from?: string;
          to?: string;
          value?: string;
          data?: string;
          gas?: string;
        };

        const account = privateKeyToAccount(privateKey);
        const walletClient = createWalletClientForNetwork(privateKey, networkId);
        const networks = getAllNetworks();
        const chain = networks[networkId];

        const hash = await walletClient.sendTransaction({
          account,
          chain,
          to: tx.to as Hex,
          value: tx.value ? BigInt(tx.value) : undefined,
          data: tx.data as Hex | undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
        });

        return { id, result: hash };
      }

      case 'personal_sign': {
        const display = formatTransactionForDisplay(method, params);
        const approved = await onApprovalNeeded(display);

        if (!approved) {
          return { id, error: RPC_ERRORS.USER_REJECTED };
        }

        const message = params[0] as Hex;
        const account = privateKeyToAccount(privateKey);
        const signature = await account.signMessage({
          message: { raw: message },
        });

        return { id, result: signature };
      }

      case 'eth_sign': {
        const display = formatTransactionForDisplay(method, params);
        const approved = await onApprovalNeeded(display);

        if (!approved) {
          return { id, error: RPC_ERRORS.USER_REJECTED };
        }

        const message = params[1] as Hex;
        const account = privateKeyToAccount(privateKey);
        const signature = await account.signMessage({
          message: { raw: message },
        });

        return { id, result: signature };
      }

      case 'eth_signTypedData':
      case 'eth_signTypedData_v4': {
        const display = formatTransactionForDisplay(method, params);
        const approved = await onApprovalNeeded(display);

        if (!approved) {
          return { id, error: RPC_ERRORS.USER_REJECTED };
        }

        const typedData = typeof params[1] === 'string'
          ? JSON.parse(params[1])
          : params[1];
        const account = privateKeyToAccount(privateKey);
        const signature = await account.signTypedData(typedData);

        return { id, result: signature };
      }

      // Read-only methods - proxy to RPC
      case 'eth_getBalance':
      case 'eth_blockNumber':
      case 'eth_call':
      case 'eth_estimateGas':
      case 'eth_gasPrice':
      case 'eth_getTransactionReceipt':
      case 'eth_getTransactionByHash': {
        // These will be handled by the RPC proxy in the component
        return { id, error: { code: -32601, message: 'Method should be proxied to RPC' } };
      }

      default:
        return {
          id,
          error: RPC_ERRORS.UNSUPPORTED_METHOD,
        };
    }
  } catch (error) {
    console.error('Provider request error:', error);
    return {
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    };
  }
}

// Generate the JavaScript to inject into the WebView/iframe
// This creates the window.ethereum provider
export function generateInjectedProviderScript(
  walletAddress: string,
  chainId: string,
  networkId: string
): string {
  return `
(function() {
  // Prevent double injection
  if (window.__punkWalletInjected) return;
  window.__punkWalletInjected = true;

  // Request ID counter
  let requestId = 0;

  // Pending requests
  const pendingRequests = new Map();

  // Event listeners
  const eventListeners = {
    connect: [],
    disconnect: [],
    chainChanged: [],
    accountsChanged: [],
    message: [],
  };

  // Current state
  let currentChainId = '${chainId}';
  let currentAccounts = ['${walletAddress}'];
  let isConnected = true;

  // Send message to parent (wallet)
  function sendToWallet(message) {
    // For iframe
    if (window.parent !== window) {
      window.parent.postMessage({
        type: 'PUNK_WALLET_REQUEST',
        ...message,
      }, '*');
    }
    // For Capacitor WebView - will be handled via custom bridge
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.punkWallet) {
      window.webkit.messageHandlers.punkWallet.postMessage({
        type: 'PUNK_WALLET_REQUEST',
        ...message,
      });
    }
  }

  // Handle messages from wallet
  function handleWalletMessage(event) {
    const data = event.data;
    if (!data || data.type !== 'PUNK_WALLET_RESPONSE') return;

    // Handle response to request
    if (data.id !== undefined && pendingRequests.has(data.id)) {
      const { resolve, reject } = pendingRequests.get(data.id);
      pendingRequests.delete(data.id);

      if (data.error) {
        const error = new Error(data.error.message);
        error.code = data.error.code;
        error.data = data.error.data;
        reject(error);
      } else {
        resolve(data.result);
      }
    }

    // Handle events
    if (data.event) {
      const { type, payload } = data.event;

      switch (type) {
        case 'chainChanged':
          currentChainId = payload;
          eventListeners.chainChanged.forEach(cb => cb(payload));
          break;
        case 'accountsChanged':
          currentAccounts = payload;
          eventListeners.accountsChanged.forEach(cb => cb(payload));
          break;
        case 'connect':
          isConnected = true;
          eventListeners.connect.forEach(cb => cb({ chainId: currentChainId }));
          break;
        case 'disconnect':
          isConnected = false;
          eventListeners.disconnect.forEach(cb => cb({ code: 4900, message: 'Disconnected' }));
          break;
      }
    }
  }

  window.addEventListener('message', handleWalletMessage);

  // The EIP-1193 Provider
  const provider = {
    isMetaMask: true, // For compatibility with dApps that check this
    isPunkWallet: true,
    isConnected: () => isConnected,

    // EIP-1193 request method
    request: async function({ method, params }) {
      const id = ++requestId;

      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });

        sendToWallet({
          id,
          method,
          params: params || [],
        });

        // Timeout after 5 minutes
        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error('Request timed out'));
          }
        }, 300000);
      });
    },

    // Event handling
    on: function(event, callback) {
      if (eventListeners[event]) {
        eventListeners[event].push(callback);
      }
      return this;
    },

    removeListener: function(event, callback) {
      if (eventListeners[event]) {
        const index = eventListeners[event].indexOf(callback);
        if (index > -1) {
          eventListeners[event].splice(index, 1);
        }
      }
      return this;
    },

    // Deprecated methods for compatibility
    enable: async function() {
      return this.request({ method: 'eth_requestAccounts' });
    },

    send: function(methodOrPayload, paramsOrCallback) {
      // Handle different call signatures
      if (typeof methodOrPayload === 'string') {
        return this.request({ method: methodOrPayload, params: paramsOrCallback });
      }

      // Legacy callback style
      if (typeof paramsOrCallback === 'function') {
        this.request(methodOrPayload)
          .then(result => paramsOrCallback(null, { result }))
          .catch(error => paramsOrCallback(error));
        return;
      }

      return this.request(methodOrPayload);
    },

    sendAsync: function(payload, callback) {
      this.request(payload)
        .then(result => callback(null, { id: payload.id, jsonrpc: '2.0', result }))
        .catch(error => callback(error));
    },

    // Chain and account info
    chainId: currentChainId,
    networkVersion: String(parseInt(currentChainId, 16)),
    selectedAddress: currentAccounts[0],
  };

  // Make chainId and selectedAddress reactive
  Object.defineProperty(provider, 'chainId', {
    get: () => currentChainId,
    enumerable: true,
  });

  Object.defineProperty(provider, 'selectedAddress', {
    get: () => currentAccounts[0] || null,
    enumerable: true,
  });

  Object.defineProperty(provider, 'networkVersion', {
    get: () => String(parseInt(currentChainId, 16)),
    enumerable: true,
  });

  // Inject as window.ethereum
  Object.defineProperty(window, 'ethereum', {
    value: provider,
    writable: false,
    configurable: false,
  });

  // Also announce via EIP-6963 for modern dApps
  const announceProvider = () => {
    const info = {
      uuid: 'punk-wallet-' + Date.now(),
      name: 'Punk Wallet',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23FF6B6B" width="100" height="100"/></svg>',
      rdns: 'io.punkwallet',
    };

    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      })
    );
  };

  window.addEventListener('eip6963:requestProvider', announceProvider);
  announceProvider();

  // Emit connect event
  setTimeout(() => {
    eventListeners.connect.forEach(cb => cb({ chainId: currentChainId }));
  }, 0);

  console.log('[Punk Wallet] Provider injected successfully');
})();
`;
}

// Generate a simpler script for updating state (chain/account changes)
export function generateStateUpdateScript(
  eventType: 'chainChanged' | 'accountsChanged',
  payload: string | string[]
): string {
  return `
(function() {
  if (window.ethereum && window.ethereum.isPunkWallet) {
    window.postMessage({
      type: 'PUNK_WALLET_RESPONSE',
      event: {
        type: '${eventType}',
        payload: ${JSON.stringify(payload)},
      },
    }, '*');
  }
})();
`;
}
