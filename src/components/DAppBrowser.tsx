"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { DAppBrowser as NativeDAppBrowser } from "@/lib/nativeBrowser";
import {
  getFavoriteDApps,
  addFavoriteDApp,
  removeFavoriteDApp,
  addRecentDApp,
  getRecentDApps,
  getDAppFromUrl,
  isValidDAppUrl,
  formatDAppUrl,
  markDAppConnected,
  type DApp,
} from "@/lib/dappStorage";
import {
  generateInjectedProviderScript,
  generateStateUpdateScript,
  handleProviderRequest,
  getChainIdHex,
  getNetworkIdFromChainId,
  formatTransactionForDisplay,
  type ProviderRequest,
  type TransactionDisplay,
} from "@/lib/dappProvider";
import {
  getAllNetworks,
  getNetworkInfo,
  getRpcUrl,
  createWalletClientForNetwork,
} from "@/lib/wallet";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

interface DAppBrowserProps {
  walletAddress: string;
  privateKey: Hex;
  networkId: string;
  onNetworkChange: (networkId: string) => void;
  onClose: () => void;
}

type BrowserView = "grid" | "browser";

export default function DAppBrowser({
  walletAddress,
  privateKey,
  networkId,
  onNetworkChange,
  onClose,
}: DAppBrowserProps) {
  const [view, setView] = useState<BrowserView>("grid");
  const [currentUrl, setCurrentUrl] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [favoriteDApps, setFavoriteDApps] = useState<DApp[]>([]);
  const [recentDApps, setRecentDApps] = useState<DApp[]>([]);
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [showAddDApp, setShowAddDApp] = useState(false);
  const [newDAppUrl, setNewDAppUrl] = useState("");
  const [newDAppName, setNewDAppName] = useState("");
  const [pendingApproval, setPendingApproval] = useState<{
    display: TransactionDisplay;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [pendingNetworkSwitch, setPendingNetworkSwitch] = useState<{
    chainId: number;
    networkName: string;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editingDApp, setEditingDApp] = useState<DApp | null>(null);
  const [iframeBlocked, setIframeBlocked] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const historyStack = useRef<string[]>([]);
  const historyIndex = useRef(-1);

  // Load favorites and recents on mount
  useEffect(() => {
    setFavoriteDApps(getFavoriteDApps());
    setRecentDApps(getRecentDApps());
  }, []);

  // Auto-dismiss messages
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  // Handle messages from iframe
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.type !== "PUNK_WALLET_REQUEST") return;

      const request: ProviderRequest = {
        id: data.id,
        method: data.method,
        params: data.params,
      };

      // Handle approval-required methods
      const approvalMethods = [
        "eth_sendTransaction",
        "personal_sign",
        "eth_sign",
        "eth_signTypedData",
        "eth_signTypedData_v4",
      ];

      if (approvalMethods.includes(request.method)) {
        const response = await handleProviderRequest(
          request,
          walletAddress,
          privateKey,
          networkId,
          async (display) => {
            return new Promise<boolean>((resolve) => {
              setPendingApproval({ display, resolve });
            });
          },
          async (chainId) => {
            const targetNetworkId = getNetworkIdFromChainId(chainId);
            if (!targetNetworkId) return false;
            const info = getNetworkInfo(targetNetworkId);
            return new Promise<boolean>((resolve) => {
              setPendingNetworkSwitch({
                chainId,
                networkName: info.name,
                resolve,
              });
            });
          }
        );

        // Send response back to iframe
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: "PUNK_WALLET_RESPONSE",
            id: response.id,
            result: response.result,
            error: response.error,
          },
          "*"
        );
      } else if (request.method === "wallet_switchEthereumChain") {
        const chainParam = request.params?.[0] as { chainId: string };
        const targetChainId = parseInt(
          chainParam.chainId.replace("0x", ""),
          16
        );
        const targetNetworkId = getNetworkIdFromChainId(targetChainId);

        if (!targetNetworkId) {
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: "PUNK_WALLET_RESPONSE",
              id: request.id,
              error: { code: 4902, message: "Unrecognized chain ID" },
            },
            "*"
          );
          return;
        }

        const info = getNetworkInfo(targetNetworkId);
        const approved = await new Promise<boolean>((resolve) => {
          setPendingNetworkSwitch({
            chainId: targetChainId,
            networkName: info.name,
            resolve,
          });
        });

        if (approved) {
          onNetworkChange(targetNetworkId);
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: "PUNK_WALLET_RESPONSE",
              id: request.id,
              result: null,
            },
            "*"
          );
        } else {
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: "PUNK_WALLET_RESPONSE",
              id: request.id,
              error: { code: 4001, message: "User rejected the request" },
            },
            "*"
          );
        }
      } else {
        // Non-approval methods
        const response = await handleProviderRequest(
          request,
          walletAddress,
          privateKey,
          networkId,
          async () => true, // Auto-approve read methods
          async () => true
        );

        iframeRef.current?.contentWindow?.postMessage(
          {
            type: "PUNK_WALLET_RESPONSE",
            id: response.id,
            result: response.result,
            error: response.error,
          },
          "*"
        );
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [walletAddress, privateKey, networkId, onNetworkChange]);

  // Notify iframe of network changes
  useEffect(() => {
    if (view === "browser" && iframeRef.current?.contentWindow) {
      const script = generateStateUpdateScript(
        "chainChanged",
        getChainIdHex(networkId)
      );
      // We can't directly execute script in iframe due to sandbox, but the provider will get updates via postMessage
      iframeRef.current.contentWindow.postMessage(
        {
          type: "PUNK_WALLET_RESPONSE",
          event: {
            type: "chainChanged",
            payload: getChainIdHex(networkId),
          },
        },
        "*"
      );
    }
  }, [networkId, view]);

  const navigateTo = useCallback(
    async (url: string) => {
      if (!isValidDAppUrl(url)) {
        // Try adding https://
        if (!url.startsWith("http")) {
          url = "https://" + url;
        }
        if (!isValidDAppUrl(url)) {
          setError("Invalid URL");
          return;
        }
      }

      setCurrentUrl(url);
      setInputUrl(url);
      setIframeBlocked(false);

      // On native platform, open in native WKWebView browser
      if (Capacitor.isNativePlatform()) {
        try {
          console.log("Opening native browser for:", url);
          const result = await NativeDAppBrowser.open({
            url,
            title: getDAppFromUrl(url)?.name || formatDAppUrl(url),
            toolbarColor: "#0a0a0a",
            walletAddress,
            chainId: getChainIdHex(networkId),
            rpcUrl: getRpcUrl(networkId),

            // Handle transaction requests from dApp
            onTransactionRequest: async (tx) => {
              console.log("Transaction request from dApp:", tx);

              // TODO: Add proper confirmation UI
              // For now, auto-approve to test signing works
              console.log("Auto-approving transaction for testing...");

              // Sign and send the transaction
              const account = privateKeyToAccount(privateKey);
              const walletClient = createWalletClientForNetwork(
                privateKey,
                networkId
              );
              const networks = getAllNetworks();
              const chain = networks[networkId];

              const hash = await walletClient.sendTransaction({
                account,
                chain,
                to: tx.to as `0x${string}`,
                value: tx.value ? BigInt(tx.value) : undefined,
                data: tx.data as `0x${string}` | undefined,
                gas: tx.gas ? BigInt(tx.gas) : undefined,
              });

              console.log("Transaction sent:", hash);
              return hash;
            },

            // Handle sign requests from dApp
            onSignRequest: async (message, method) => {
              console.log("Sign request from dApp:", method, message);

              // TODO: Add proper confirmation UI
              // For now, auto-approve to test signing works
              console.log("Auto-approving sign request for testing...");

              // Sign the message
              const account = privateKeyToAccount(privateKey);
              const signature = await account.signMessage({
                message: message.startsWith("0x")
                  ? { raw: message as `0x${string}` }
                  : message,
              });

              console.log("Message signed:", signature);
              return signature;
            },
          });
          console.log("Native browser opened successfully:", result);

          // Add to recents after successful open
          const dapp = getDAppFromUrl(url);
          if (dapp) {
            addRecentDApp(dapp);
            setRecentDApps(getRecentDApps());
            markDAppConnected(walletAddress, {
              origin: new URL(url).origin,
              name: dapp.name,
              icon: dapp.icon,
            });
          }
        } catch (e) {
          console.error("Failed to open native browser:", e);
          setError("Failed to open browser. Please try again.");
        }
        // Stay on grid view - native browser handles the rest
        return;
      }

      // Web platform - use our iframe UI
      setView("browser");
      setLoading(true);

      // Update history
      if (historyIndex.current < historyStack.current.length - 1) {
        historyStack.current = historyStack.current.slice(
          0,
          historyIndex.current + 1
        );
      }
      historyStack.current.push(url);
      historyIndex.current = historyStack.current.length - 1;
      setCanGoBack(historyIndex.current > 0);
      setCanGoForward(false);

      // Add to recents
      const dapp = getDAppFromUrl(url);
      if (dapp) {
        addRecentDApp(dapp);
        setRecentDApps(getRecentDApps());
        markDAppConnected(walletAddress, {
          origin: new URL(url).origin,
          name: dapp.name,
          icon: dapp.icon,
        });
      }
    },
    [walletAddress]
  );

  const goBack = useCallback(() => {
    if (historyIndex.current > 0) {
      historyIndex.current--;
      const url = historyStack.current[historyIndex.current];
      setCurrentUrl(url);
      setInputUrl(url);
      setCanGoBack(historyIndex.current > 0);
      setCanGoForward(true);
    }
  }, []);

  const goForward = useCallback(() => {
    if (historyIndex.current < historyStack.current.length - 1) {
      historyIndex.current++;
      const url = historyStack.current[historyIndex.current];
      setCurrentUrl(url);
      setInputUrl(url);
      setCanGoBack(true);
      setCanGoForward(historyIndex.current < historyStack.current.length - 1);
    }
  }, []);

  const refresh = useCallback(() => {
    if (iframeRef.current) {
      setLoading(true);
      iframeRef.current.src = currentUrl;
    }
  }, [currentUrl]);

  const handleAddDApp = useCallback(() => {
    if (!newDAppUrl || !newDAppName) {
      setError("Please enter both name and URL");
      return;
    }

    let url = newDAppUrl;
    if (!url.startsWith("http")) {
      url = "https://" + url;
    }

    if (!isValidDAppUrl(url)) {
      setError("Invalid URL");
      return;
    }

    try {
      addFavoriteDApp({
        name: newDAppName,
        url,
        category: "other",
      });
      setFavoriteDApps(getFavoriteDApps());
      setShowAddDApp(false);
      setNewDAppUrl("");
      setNewDAppName("");
      setSuccess("dApp added!");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add dApp");
    }
  }, [newDAppUrl, newDAppName]);

  const handleRemoveDApp = useCallback((id: string) => {
    removeFavoriteDApp(id);
    setFavoriteDApps(getFavoriteDApps());
    setEditingDApp(null);
    setSuccess("dApp removed");
  }, []);

  const handleIframeLoad = useCallback(() => {
    setLoading(false);
    // Inject the provider script
    // Note: Due to iframe sandbox restrictions, we rely on postMessage communication
    // The injection script would need to be served from the dApp's domain or use a service worker
  }, []);

  const networkInfo = getNetworkInfo(networkId);

  // Render app grid
  const renderGrid = () => (
    <div className="flex-1 overflow-y-auto p-4 pb-24">
      {/* Search / URL Bar */}
      <div className="mb-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (inputUrl) navigateTo(inputUrl);
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="Enter dApp URL or search..."
            className="flex-1 px-4 py-3 bg-input-bg border border-card-border rounded-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
          />
          <button
            type="submit"
            className="px-4 py-3 bg-accent text-background rounded-sm font-medium hover:bg-accent-dark transition-colors"
          >
            Go
          </button>
        </form>
      </div>

      {/* Recent dApps */}
      {recentDApps.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-medium text-muted mb-3">Recent</h3>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {recentDApps.slice(0, 5).map((dapp) => (
              <button
                key={dapp.id}
                onClick={() => navigateTo(dapp.url)}
                className="flex-shrink-0 flex flex-col items-center gap-2 p-3 bg-card-bg border border-card-border rounded-sm hover:border-accent transition-colors w-20"
              >
                <div className="w-10 h-10 rounded-sm bg-input-bg flex items-center justify-center overflow-hidden">
                  {dapp.icon ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={dapp.icon}
                      alt=""
                      className="w-8 h-8 object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <span className="text-lg font-bold text-muted">
                      {dapp.name[0]}
                    </span>
                  )}
                </div>
                <span className="text-xs text-foreground truncate w-full text-center">
                  {dapp.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Favorite dApps Grid */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-muted">dApps</h3>
          <button
            onClick={() => setShowAddDApp(true)}
            className="text-xs text-accent hover:text-accent-dark transition-colors"
          >
            + Add Custom
          </button>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {favoriteDApps.map((dapp) => (
            <button
              key={dapp.id}
              onClick={() => navigateTo(dapp.url)}
              onContextMenu={(e) => {
                e.preventDefault();
                setEditingDApp(dapp);
              }}
              className="flex flex-col items-center gap-2 p-3 bg-card-bg border border-card-border rounded-sm hover:border-accent transition-colors group"
            >
              <div className="w-12 h-12 rounded-sm bg-input-bg flex items-center justify-center overflow-hidden">
                {dapp.icon ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={dapp.icon}
                    alt=""
                    className="w-10 h-10 object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <span className="text-xl font-bold text-muted">
                    {dapp.name[0]}
                  </span>
                )}
              </div>
              <span className="text-xs text-foreground truncate w-full text-center">
                {dapp.name}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Categories hint */}
      <div className="text-center text-xs text-muted mt-8">
        <p>Long-press any dApp to edit or remove</p>
      </div>
    </div>
  );

  // Render browser view
  const renderBrowser = () => (
    <div className="flex-1 flex flex-col">
      {/* URL Bar */}
      <div className="flex items-center gap-2 p-2 bg-card-bg border-b border-card-border">
        <button
          onClick={goBack}
          disabled={!canGoBack}
          className="p-2 rounded-sm hover:bg-input-bg disabled:opacity-30 transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>
        <button
          onClick={goForward}
          disabled={!canGoForward}
          className="p-2 rounded-sm hover:bg-input-bg disabled:opacity-30 transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
        </button>
        <button
          onClick={refresh}
          className="p-2 rounded-sm hover:bg-input-bg transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>

        <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-input-bg rounded-sm">
          {loading && (
            <svg
              className="w-4 h-4 animate-spin text-accent"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          )}
          <span className="text-sm text-foreground truncate flex-1">
            {formatDAppUrl(currentUrl)}
          </span>
          <div className="flex items-center gap-1 px-2 py-0.5 bg-card-bg rounded-sm">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                backgroundColor: networkInfo.logo ? undefined : "#10b981",
              }}
            />
            <span className="text-xs text-muted">{networkInfo.symbol}</span>
          </div>
        </div>

        <button
          onClick={() => {
            setView("grid");
            setCurrentUrl("");
          }}
          className="p-2 rounded-sm hover:bg-input-bg transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
            />
          </svg>
        </button>
      </div>

      {/* Browser content - Web only (native uses InAppBrowser overlay) */}
      <div className="flex-1 relative bg-white">
        {iframeBlocked ? (
          <div className="flex items-center justify-center h-full p-8 text-center bg-background">
            <div className="space-y-4">
              <svg
                className="w-16 h-16 mx-auto text-muted"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <p className="text-foreground font-medium">
                This dApp blocks embedded browsers
              </p>
              <p className="text-sm text-muted">
                Open in a new tab and use WalletConnect to connect
              </p>
              <button
                onClick={() => window.open(currentUrl, "_blank")}
                className="px-6 py-3 bg-accent text-background rounded-sm font-medium"
              >
                Open {formatDAppUrl(currentUrl)} in New Tab
              </button>
            </div>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={currentUrl}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-top-navigation"
            onLoad={() => {
              setLoading(false);
              // Check if iframe loaded correctly (some sites block with X-Frame-Options)
              try {
                // This will throw if cross-origin and blocked
                const doc = iframeRef.current?.contentDocument;
                if (doc === null) {
                  setIframeBlocked(true);
                }
              } catch {
                // Cross-origin, might still work
              }
            }}
            onError={() => {
              setLoading(false);
              setIframeBlocked(true);
            }}
            title="dApp Browser"
          />
        )}

        {loading && (
          <div className="absolute inset-0 bg-background/80 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <svg
                className="w-8 h-8 animate-spin text-accent"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span className="text-sm text-muted">Loading dApp...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-background flex flex-col z-40">
      {/* Header */}
      <header className="flex items-center justify-between p-4 border-b border-card-border safe-area-top">
        <button
          onClick={onClose}
          className="p-2 -ml-2 rounded-sm hover:bg-card-border transition-colors"
        >
          <svg
            className="w-6 h-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
        <h1 className="text-lg font-semibold tracking-tight">
          {view === "grid" ? "dApp Browser" : formatDAppUrl(currentUrl)}
        </h1>
        <div className="w-10" /> {/* Spacer */}
      </header>

      {/* Content */}
      {view === "grid" ? renderGrid() : renderBrowser()}

      {/* Add dApp Modal */}
      {showAddDApp && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div className="bg-card-bg border border-card-border rounded-sm p-6 max-w-md w-full space-y-4 animate-fade-in">
            <h3 className="text-lg font-semibold">Add Custom dApp</h3>
            <div className="space-y-3">
              <input
                type="text"
                value={newDAppName}
                onChange={(e) => setNewDAppName(e.target.value)}
                placeholder="dApp Name"
                className="w-full px-4 py-3 bg-input-bg border border-card-border rounded-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
              />
              <input
                type="url"
                value={newDAppUrl}
                onChange={(e) => setNewDAppUrl(e.target.value)}
                placeholder="https://example.com"
                className="w-full px-4 py-3 bg-input-bg border border-card-border rounded-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowAddDApp(false);
                  setNewDAppUrl("");
                  setNewDAppName("");
                }}
                className="flex-1 py-3 rounded-sm bg-card-border hover:bg-muted/20 transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleAddDApp}
                className="flex-1 py-3 rounded-sm bg-accent hover:bg-accent-dark transition-colors font-medium text-background"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit/Remove dApp Modal */}
      {editingDApp && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div className="bg-card-bg border border-card-border rounded-sm p-6 max-w-md w-full space-y-4 animate-fade-in">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-sm bg-input-bg flex items-center justify-center">
                {editingDApp.icon ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={editingDApp.icon}
                    alt=""
                    className="w-10 h-10 object-contain"
                  />
                ) : (
                  <span className="text-xl font-bold text-muted">
                    {editingDApp.name[0]}
                  </span>
                )}
              </div>
              <div>
                <h3 className="font-semibold">{editingDApp.name}</h3>
                <p className="text-sm text-muted">
                  {formatDAppUrl(editingDApp.url)}
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setEditingDApp(null)}
                className="flex-1 py-3 rounded-sm bg-card-border hover:bg-muted/20 transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRemoveDApp(editingDApp.id)}
                className="flex-1 py-3 rounded-sm bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors font-medium"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transaction Approval Modal */}
      {pendingApproval && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center p-4 z-50">
          <div className="bg-card-bg border border-card-border rounded-sm p-6 max-w-md w-full space-y-4 animate-fade-in">
            <div className="text-center">
              <div className="w-16 h-16 rounded-sm bg-warning/10 flex items-center justify-center mx-auto mb-4">
                <svg
                  className="w-8 h-8 text-warning"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
              </div>
              <h3 className="text-xl font-semibold">
                {pendingApproval.display.type === "transaction"
                  ? "Confirm Transaction"
                  : "Sign Message"}
              </h3>
              <p className="text-sm text-muted mt-1">
                {formatDAppUrl(currentUrl)}
              </p>
            </div>

            {pendingApproval.display.type === "transaction" && (
              <div className="p-4 rounded-sm bg-input-bg border border-card-border space-y-2">
                {pendingApproval.display.to && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">To</span>
                    <span className="font-mono">
                      {pendingApproval.display.to.slice(0, 8)}...
                      {pendingApproval.display.to.slice(-6)}
                    </span>
                  </div>
                )}
                {pendingApproval.display.valueETH &&
                  parseFloat(pendingApproval.display.valueETH) > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted">Value</span>
                      <span className="font-semibold">
                        {parseFloat(pendingApproval.display.valueETH).toFixed(
                          6
                        )}{" "}
                        {networkInfo.symbol}
                      </span>
                    </div>
                  )}
                {pendingApproval.display.data && (
                  <div className="text-xs text-muted mt-2">
                    Contract interaction
                  </div>
                )}
              </div>
            )}

            {(pendingApproval.display.type === "sign" ||
              pendingApproval.display.type === "signTypedData") && (
              <div className="p-4 rounded-sm bg-input-bg border border-card-border max-h-40 overflow-auto">
                <pre className="text-xs font-mono text-muted whitespace-pre-wrap break-all">
                  {pendingApproval.display.message?.slice(0, 500)}
                  {(pendingApproval.display.message?.length || 0) > 500 &&
                    "..."}
                </pre>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => {
                  pendingApproval.resolve(false);
                  setPendingApproval(null);
                }}
                className="py-4 rounded-sm bg-card-border hover:bg-muted/20 transition-colors font-medium"
              >
                Reject
              </button>
              <button
                onClick={() => {
                  pendingApproval.resolve(true);
                  setPendingApproval(null);
                }}
                className="py-4 rounded-sm bg-accent hover:bg-accent-dark transition-colors font-medium text-background text-lg"
              >
                Approve
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Network Switch Modal */}
      {pendingNetworkSwitch && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center p-4 z-50">
          <div className="bg-card-bg border border-card-border rounded-sm p-6 max-w-md w-full space-y-4 animate-fade-in">
            <div className="text-center">
              <div className="w-16 h-16 rounded-sm bg-blue-500/10 flex items-center justify-center mx-auto mb-4">
                <svg
                  className="w-8 h-8 text-blue-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                  />
                </svg>
              </div>
              <h3 className="text-xl font-semibold">Switch Network</h3>
              <p className="text-sm text-muted mt-2">
                This dApp wants to switch to{" "}
                <span className="text-foreground font-medium">
                  {pendingNetworkSwitch.networkName}
                </span>
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => {
                  pendingNetworkSwitch.resolve(false);
                  setPendingNetworkSwitch(null);
                }}
                className="py-3 rounded-sm bg-card-border hover:bg-muted/20 transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  pendingNetworkSwitch.resolve(true);
                  setPendingNetworkSwitch(null);
                }}
                className="py-3 rounded-sm bg-accent hover:bg-accent-dark transition-colors font-medium text-background"
              >
                Switch
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error Toast */}
      {error && (
        <div className="fixed bottom-20 left-4 right-4 p-4 bg-red-500/20 border border-red-500/50 rounded-sm text-red-400 text-center animate-fade-in z-50">
          {error}
        </div>
      )}

      {/* Success Toast */}
      {success && (
        <div className="fixed bottom-20 left-4 right-4 p-4 bg-green-500/20 border border-green-500/50 rounded-sm text-green-400 text-center animate-fade-in z-50">
          {success}
        </div>
      )}
    </div>
  );
}
