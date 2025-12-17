import { InAppBrowser, ToolBarType, BackgroundColor } from '@capgo/inappbrowser';
import type { PluginListenerHandle } from '@capacitor/core';

export interface DAppBrowserOptions {
  url: string;
  title?: string;
  toolbarColor?: string;
  walletAddress?: string;
  chainId?: string;
  rpcUrl?: string;
  onTransactionRequest?: (tx: TransactionRequest) => Promise<string>; // Returns tx hash
  onSignRequest?: (message: string, method: string) => Promise<string>; // Returns signature
}

export interface TransactionRequest {
  from: string;
  to?: string;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
}

let messageListener: PluginListenerHandle | null = null;

// Provider script to inject - with RPC URL for blockchain calls
function getProviderScript(address: string, chainId: string, rpcUrl: string): string {
  return `
(function() {
  if (window.ethereum && window.ethereum.isPunkWallet) return;

  const accounts = ['${address}'];
  let currentChainId = '${chainId}';
  const rpcUrl = '${rpcUrl}';
  const listeners = {};
  let requestId = 0;
  const pendingTxs = new Map();

  // RPC call helper
  async function rpcCall(method, params) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })
    });
    const json = await res.json();
    if (json.error) throw json.error;
    return json.result;
  }

  const provider = {
    isMetaMask: true,
    isPunkWallet: true,
    chainId: currentChainId,
    networkVersion: String(parseInt(currentChainId, 16)),
    selectedAddress: accounts[0],
    isConnected: () => true,

    request: async function({ method, params }) {
      console.log('[PunkWallet] request:', method, params);

      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return accounts;

        case 'eth_chainId':
          return currentChainId;

        case 'net_version':
          return String(parseInt(currentChainId, 16));

        case 'wallet_switchEthereumChain':
          // Store for later - would need native handling
          return null;

        case 'eth_sendTransaction':
          // Show confirmation and send to native app
          const tx = params[0];
          const txId = 'tx_' + Date.now();

          return new Promise((resolve, reject) => {
            pendingTxs.set(txId, { resolve, reject });

            // Post message to native app
            if (window.mobileApp && window.mobileApp.postMessage) {
              window.mobileApp.postMessage({
                type: 'PUNK_TX_REQUEST',
                id: txId,
                method: 'eth_sendTransaction',
                params: [tx]
              });
            } else {
              // Fallback: show alert with tx details for now
              const confirmed = confirm(
                'Approve Transaction?\\n\\n' +
                'To: ' + (tx.to || 'Contract Creation') + '\\n' +
                'Value: ' + (tx.value ? (parseInt(tx.value, 16) / 1e18).toFixed(6) + ' ETH' : '0 ETH') + '\\n' +
                'Gas: ' + (tx.gas ? parseInt(tx.gas, 16) : 'auto')
              );

              if (!confirmed) {
                reject({ code: 4001, message: 'User rejected' });
                return;
              }

              // For now, reject with message - full signing requires native integration
              reject({ code: -32603, message: 'Transaction signing requires full wallet integration. Please use WalletConnect for now.' });
            }
          });

        case 'personal_sign':
        case 'eth_sign':
          return new Promise((resolve, reject) => {
            const msg = params[0];
            const confirmed = confirm('Sign Message?\\n\\n' + msg.substring(0, 100) + (msg.length > 100 ? '...' : ''));
            if (!confirmed) {
              reject({ code: 4001, message: 'User rejected' });
              return;
            }
            reject({ code: -32603, message: 'Message signing requires full wallet integration. Please use WalletConnect for now.' });
          });

        // Pass through to RPC
        case 'eth_getBalance':
        case 'eth_blockNumber':
        case 'eth_call':
        case 'eth_estimateGas':
        case 'eth_gasPrice':
        case 'eth_maxPriorityFeePerGas':
        case 'eth_getTransactionCount':
        case 'eth_getTransactionReceipt':
        case 'eth_getTransactionByHash':
        case 'eth_getBlockByNumber':
        case 'eth_getBlockByHash':
        case 'eth_getLogs':
        case 'eth_getCode':
        case 'eth_getStorageAt':
          return rpcCall(method, params);

        default:
          console.log('[PunkWallet] Unknown method:', method);
          throw { code: 4200, message: 'Method not supported: ' + method };
      }
    },

    on: function(event, cb) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
      return this;
    },

    removeListener: function(event, cb) {
      if (listeners[event]) listeners[event] = listeners[event].filter(l => l !== cb);
      return this;
    },

    emit: function(event, data) {
      if (listeners[event]) listeners[event].forEach(cb => cb(data));
    },

    enable: async function() { return this.request({ method: 'eth_requestAccounts' }); },
    send: function(m, p) { return typeof m === 'string' ? this.request({ method: m, params: p }) : this.request(m); },
    sendAsync: function(p, cb) { this.request(p).then(r => cb(null, { id: p.id, jsonrpc: '2.0', result: r })).catch(e => cb(e)); }
  };

  // Handle responses from native app
  window.addEventListener('punkWalletResponse', (e) => {
    const { id, result, error } = e.detail;
    if (pendingTxs.has(id)) {
      const { resolve, reject } = pendingTxs.get(id);
      pendingTxs.delete(id);
      if (error) reject(error);
      else resolve(result);
    }
  });

  Object.defineProperty(window, 'ethereum', { value: provider, writable: false, configurable: false });

  // EIP-6963
  const info = { uuid: 'punk-wallet', name: 'Punk Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23d6f550" width="100" height="100" rx="20"/><text x="50" y="70" font-size="60" text-anchor="middle">P</text></svg>', rdns: 'app.punkwallet' };
  function announce() { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: Object.freeze(info), provider }) })); }
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  setTimeout(() => provider.emit('connect', { chainId: currentChainId }), 1);
  console.log('[PunkWallet] Provider ready:', accounts[0], 'Chain:', currentChainId);
})();
`;
}

export const DAppBrowser = {
  async open(options: DAppBrowserOptions): Promise<{ success: boolean }> {
    try {
      // Set up listener for page load to inject script
      if (options.walletAddress && options.chainId) {
        const rpcUrl = options.rpcUrl || 'https://eth.llamarpc.com';
        const script = getProviderScript(options.walletAddress, options.chainId, rpcUrl);

        // Listen for page load and inject
        const listener = await InAppBrowser.addListener('browserPageLoaded', async () => {
          console.log('[DAppBrowser] Page loaded, injecting provider...');
          try {
            await InAppBrowser.executeScript({ code: script });
            console.log('[DAppBrowser] Provider injected!');
          } catch (e) {
            console.error('[DAppBrowser] Injection failed:', e);
          }
        });

        // Clean up listener when browser closes
        InAppBrowser.addListener('closeEvent', () => {
          listener.remove();
        });
      }

      await InAppBrowser.openWebView({
        url: options.url,
        title: options.title || 'Browser',
        toolbarType: ToolBarType.NAVIGATION,
        backgroundColor: BackgroundColor.BLACK,
        toolbarColor: options.toolbarColor || '#0a0a0a',
        toolbarTextColor: '#ffffff',
        showReloadButton: true,
        activeNativeNavigationForWebview: true,
        preventDeeplink: true,
        isAnimated: true,
      });

      return { success: true };
    } catch (error) {
      console.error('InAppBrowser error:', error);
      throw error;
    }
  },

  async close(): Promise<void> {
    await InAppBrowser.close();
  },
};
