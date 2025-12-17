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
          const tx = params[0];
          const txId = 'tx_' + Date.now();

          console.log('[PunkWallet] eth_sendTransaction called!');
          console.log('[PunkWallet] TX data:', JSON.stringify(tx));
          console.log('[PunkWallet] window.mobileApp exists:', !!window.mobileApp);
          console.log('[PunkWallet] window.mobileApp.postMessage exists:', !!(window.mobileApp && window.mobileApp.postMessage));

          return new Promise((resolve, reject) => {
            pendingTxs.set(txId, { resolve, reject, type: 'tx' });

            // Send to native app via mobileApp bridge - MUST wrap in detail object
            if (window.mobileApp && window.mobileApp.postMessage) {
              const msg = {
                detail: {
                  type: 'PUNK_WALLET_TX',
                  id: txId,
                  method: 'eth_sendTransaction',
                  tx: tx
                }
              };
              console.log('[PunkWallet] Sending message:', JSON.stringify(msg));
              window.mobileApp.postMessage(msg);
              console.log('[PunkWallet] TX request sent:', txId);
            } else {
              console.log('[PunkWallet] No mobileApp bridge!');
              pendingTxs.delete(txId);
              reject({ code: -32603, message: 'Native bridge not available' });
            }
          });

        case 'personal_sign':
          const signId = 'sign_' + Date.now();
          const message = params[0];

          return new Promise((resolve, reject) => {
            pendingTxs.set(signId, { resolve, reject, type: 'sign' });

            if (window.mobileApp && window.mobileApp.postMessage) {
              window.mobileApp.postMessage({
                detail: {
                  type: 'PUNK_WALLET_SIGN',
                  id: signId,
                  method: 'personal_sign',
                  message: message
                }
              });
              console.log('[PunkWallet] Sign request sent:', signId);
            } else {
              pendingTxs.delete(signId);
              reject({ code: -32603, message: 'Native bridge not available' });
            }
          });

        case 'eth_sign':
          const ethSignId = 'sign_' + Date.now();

          return new Promise((resolve, reject) => {
            pendingTxs.set(ethSignId, { resolve, reject, type: 'sign' });

            if (window.mobileApp && window.mobileApp.postMessage) {
              window.mobileApp.postMessage({
                detail: {
                  type: 'PUNK_WALLET_SIGN',
                  id: ethSignId,
                  method: 'eth_sign',
                  message: params[1]
                }
              });
            } else {
              pendingTxs.delete(ethSignId);
              reject({ code: -32603, message: 'Native bridge not available' });
            }
          });

        case 'eth_signTypedData':
        case 'eth_signTypedData_v4':
          const typedId = 'typed_' + Date.now();

          return new Promise((resolve, reject) => {
            pendingTxs.set(typedId, { resolve, reject, type: 'signTyped' });

            if (window.mobileApp && window.mobileApp.postMessage) {
              window.mobileApp.postMessage({
                detail: {
                  type: 'PUNK_WALLET_SIGN_TYPED',
                  id: typedId,
                  method: method,
                  data: params[1]
                }
              });
            } else {
              pendingTxs.delete(typedId);
              reject({ code: -32603, message: 'Native bridge not available' });
            }
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

  // Handle responses from native app via messageFromNative event
  console.log('[PunkWallet] Setting up messageFromNative listener...');
  window.addEventListener('messageFromNative', (e) => {
    console.log('[PunkWallet] *** RECEIVED messageFromNative event ***');
    console.log('[PunkWallet] Event:', e);
    console.log('[PunkWallet] Event detail:', JSON.stringify(e.detail));

    const { id, result, error } = e.detail || {};
    console.log('[PunkWallet] Parsed - id:', id, 'result:', result, 'error:', error);
    console.log('[PunkWallet] Pending TXs:', [...pendingTxs.keys()]);

    if (id && pendingTxs.has(id)) {
      const { resolve, reject } = pendingTxs.get(id);
      pendingTxs.delete(id);
      if (error) {
        console.log('[PunkWallet] TX rejected:', error);
        reject(error);
      } else {
        console.log('[PunkWallet] TX success:', result);
        resolve(result);
      }
    } else {
      console.log('[PunkWallet] No pending TX found for id:', id);
    }
  });
  console.log('[PunkWallet] messageFromNative listener registered');

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
      // Clean up any existing listener
      if (messageListener) {
        await messageListener.remove();
        messageListener = null;
      }

      // Set up listener for messages from webview (tx requests, sign requests)
      messageListener = await InAppBrowser.addListener('messageFromWebview', async (event) => {
        console.log('[DAppBrowser] Raw message event:', JSON.stringify(event));

        // The event structure from @capgo/inappbrowser: event.detail contains the message
        // But we also wrapped our data in detail, so it may be event.detail.detail or event.detail
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let data: any = event?.detail;

        // If our data is nested in another detail, unwrap it
        if (data && data.detail && data.detail.type) {
          data = data.detail;
        }

        // Also handle if event itself contains our data (different plugin versions)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!data?.type && (event as any)?.type) {
          data = event;
        }

        console.log('[DAppBrowser] Parsed data:', JSON.stringify(data));

        if (!data || !data.type) {
          console.log('[DAppBrowser] No valid data type found, ignoring');
          return;
        }

        try {
          if (data.type === 'PUNK_WALLET_TX' && options.onTransactionRequest) {
            console.log('[DAppBrowser] Transaction request:', data.tx);
            const txHash = await options.onTransactionRequest(data.tx);

            // Send result back to webview
            await InAppBrowser.postMessage({
              detail: { id: data.id, result: txHash }
            });
          } else if ((data.type === 'PUNK_WALLET_SIGN' || data.type === 'PUNK_WALLET_SIGN_TYPED') && options.onSignRequest) {
            console.log('[DAppBrowser] Sign request:', data.message || data.data);
            const signature = await options.onSignRequest(data.message || data.data, data.method);

            await InAppBrowser.postMessage({
              detail: { id: data.id, result: signature }
            });
          }
        } catch (error: unknown) {
          console.error('[DAppBrowser] Handler error:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const errorCode = (error as { code?: number })?.code || -32603;

          await InAppBrowser.postMessage({
            detail: {
              id: data.id,
              error: { code: errorCode, message: errorMessage }
            }
          });
        }
      });

      // Set up listener for page load to inject script
      if (options.walletAddress && options.chainId) {
        const rpcUrl = options.rpcUrl || 'https://eth.llamarpc.com';
        const script = getProviderScript(options.walletAddress, options.chainId, rpcUrl);

        // Listen for page load and inject
        const pageListener = await InAppBrowser.addListener('browserPageLoaded', async () => {
          console.log('[DAppBrowser] Page loaded, injecting provider...');
          try {
            await InAppBrowser.executeScript({ code: script });
            console.log('[DAppBrowser] Provider injected!');
          } catch (e) {
            console.error('[DAppBrowser] Injection failed:', e);
          }
        });

        // Clean up listeners when browser closes
        InAppBrowser.addListener('closeEvent', async () => {
          await pageListener.remove();
          if (messageListener) {
            await messageListener.remove();
            messageListener = null;
          }
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
    if (messageListener) {
      await messageListener.remove();
      messageListener = null;
    }
    await InAppBrowser.close();
  },
};
