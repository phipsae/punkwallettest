"use client";

import { useState, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  registerPasskey,
  authenticateAndDeriveWallet,
  hasStoredCredential,
  clearStoredCredential,
  recoverWallet,
  getStoredWallets,
  authenticateWithWallet,
  type PasskeyWallet,
  type StoredWallet,
} from "@/lib/passkey";
import PunkAvatar, { PunkBlockie } from "./PunkAvatar";
import {
  getBalance,
  sendETH,
  isValidAddress,
  formatAddress,
  getExplorerUrl,
  getAddressExplorerUrl,
  NETWORKS,
} from "@/lib/wallet";
import {
  getAllTokenBalances,
  sendToken,
  getTokenInfo,
  addCustomToken,
  removeCustomToken,
  getTokensForNetwork,
  formatTokenAmount,
  type Token,
  type TokenBalance,
} from "@/lib/tokens";
import {
  initWalletConnect,
  setEventCallbacks,
  connectWithUri,
  approveSession,
  rejectSession,
  getActiveSessions,
  disconnectSession,
  handleSessionRequest,
  formatRequestDisplay,
  type SessionProposal,
  type SessionRequest,
  type ActiveSession,
} from "@/lib/walletconnect";

type View =
  | "onboarding"
  | "wallet"
  | "send"
  | "receive"
  | "connect"
  | "sessions"
  | "tokens"
  | "export";

export default function WalletApp() {
  const [view, setView] = useState<View>("onboarding");
  const [wallet, setWallet] = useState<PasskeyWallet | null>(null);
  const [balance, setBalance] = useState<string>("0");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [network, setNetwork] = useState("sepolia");
  const [username, setUsername] = useState("");
  const [hasCredential, setHasCredential] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [storedWallets, setStoredWallets] = useState<StoredWallet[]>([]);
  const [walletBalances, setWalletBalances] = useState<Record<string, string>>(
    {}
  );
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [selectedWalletIndex, setSelectedWalletIndex] = useState<number | null>(
    null
  );

  // Send form state
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [selectedToken, setSelectedToken] = useState<Token | null>(null); // null = ETH

  // Token state
  const [tokenBalances, setTokenBalances] = useState<TokenBalance[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [showAddToken, setShowAddToken] = useState(false);
  const [customTokenAddress, setCustomTokenAddress] = useState("");
  const [addingToken, setAddingToken] = useState(false);

  // WalletConnect state
  const [wcUri, setWcUri] = useState("");
  const [wcConnecting, setWcConnecting] = useState(false);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [sessionProposal, setSessionProposal] =
    useState<SessionProposal | null>(null);
  const [sessionRequest, setSessionRequest] = useState<SessionRequest | null>(
    null
  );
  const [wcInitialized, setWcInitialized] = useState(false);

  // Export private key state
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [exportConfirmed, setExportConfirmed] = useState(false);

  // Fetch balances for all stored wallets
  const fetchWalletBalances = useCallback(
    async (wallets: StoredWallet[]) => {
      if (wallets.length === 0) return;
      setLoadingBalances(true);
      const balances: Record<string, string> = {};

      await Promise.all(
        wallets.map(async (w) => {
          try {
            const result = await getBalance(
              w.address as `0x${string}`,
              network
            );
            balances[w.address] = result.formatted;
          } catch {
            balances[w.address] = "0";
          }
        })
      );

      setWalletBalances(balances);
      setLoadingBalances(false);
    },
    [network]
  );

  // Check for existing credential on mount
  useEffect(() => {
    setMounted(true);
    const hasStored = hasStoredCredential();
    setHasCredential(hasStored);
    const wallets = getStoredWallets();
    setStoredWallets(wallets);
    fetchWalletBalances(wallets);
    if (hasStored) {
      setView("wallet");
    }
  }, [fetchWalletBalances]);

  // Initialize WalletConnect when wallet is available
  useEffect(() => {
    if (!wallet || wcInitialized) return;

    const init = async () => {
      try {
        await initWalletConnect();

        // Set up event callbacks
        setEventCallbacks({
          onSessionProposal: (proposal) => {
            setSessionProposal(proposal);
          },
          onSessionRequest: (request) => {
            setSessionRequest(request);
          },
          onSessionDelete: async () => {
            const sessions = await getActiveSessions();
            setActiveSessions(sessions);
          },
        });

        // Load existing sessions
        const sessions = await getActiveSessions();
        setActiveSessions(sessions);
        setWcInitialized(true);
      } catch (err) {
        console.error("Failed to initialize WalletConnect:", err);
      }
    };

    init();
  }, [wallet, wcInitialized]);

  // Fetch balance when wallet changes
  const fetchBalance = useCallback(async () => {
    if (!wallet) return;
    try {
      const result = await getBalance(wallet.address, network);
      setBalance(result.formatted);
    } catch (err) {
      console.error("Failed to fetch balance:", err);
    }
  }, [wallet, network]);

  // Fetch token balances
  const fetchTokenBalances = useCallback(async () => {
    if (!wallet) return;
    setLoadingTokens(true);
    try {
      const balances = await getAllTokenBalances(wallet.address, network);
      setTokenBalances(balances);
    } catch (err) {
      console.error("Failed to fetch token balances:", err);
    } finally {
      setLoadingTokens(false);
    }
  }, [wallet, network]);

  useEffect(() => {
    if (wallet) {
      fetchBalance();
      fetchTokenBalances();
      const interval = setInterval(() => {
        fetchBalance();
        fetchTokenBalances();
      }, 15000); // Refresh every 15s
      return () => clearInterval(interval);
    }
  }, [wallet, network, fetchBalance, fetchTokenBalances]);

  // Create new wallet
  const handleCreateWallet = async () => {
    if (!username.trim()) {
      setError("Please enter a username");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await registerPasskey(username);
      const walletData = await authenticateAndDeriveWallet();
      if (walletData) {
        setWallet(walletData);
        setHasCredential(true);
        setView("wallet");
        setSuccess("Wallet created successfully!");
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create wallet");
    } finally {
      setLoading(false);
    }
  };

  // Unlock existing wallet
  const handleUnlockWallet = async () => {
    setLoading(true);
    setError(null);

    try {
      const walletData = await authenticateAndDeriveWallet();
      if (walletData) {
        setWallet(walletData);
        setView("wallet");
      } else {
        setError("Failed to unlock wallet");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlock wallet");
    } finally {
      setLoading(false);
    }
  };

  // Send ETH or Token
  const handleSend = async () => {
    if (!wallet) return;

    if (!isValidAddress(sendTo)) {
      setError("Invalid recipient address");
      return;
    }

    if (!sendAmount || parseFloat(sendAmount) <= 0) {
      setError("Invalid amount");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let result;

      if (selectedToken) {
        // Send ERC20 token
        result = await sendToken(
          wallet.privateKey,
          selectedToken,
          sendTo as `0x${string}`,
          sendAmount,
          network
        );
      } else {
        // Send ETH
        result = await sendETH(
          wallet.privateKey,
          sendTo as `0x${string}`,
          sendAmount,
          network
        );
      }

      if (result.success) {
        setTxHash(result.hash);
        setSuccess(
          `${selectedToken ? selectedToken.symbol : "ETH"} sent successfully!`
        );
        setSendTo("");
        setSendAmount("");
        setSelectedToken(null);
        fetchBalance();
        fetchTokenBalances();
      } else {
        setError(result.error || "Transaction failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setLoading(false);
    }
  };

  // Add custom token
  const handleAddCustomToken = async () => {
    if (!customTokenAddress || !isValidAddress(customTokenAddress)) {
      setError("Invalid token address");
      return;
    }

    setAddingToken(true);
    setError(null);

    try {
      const tokenInfo = await getTokenInfo(
        customTokenAddress as `0x${string}`,
        network
      );
      if (tokenInfo) {
        addCustomToken(network, tokenInfo);
        setCustomTokenAddress("");
        setShowAddToken(false);
        setSuccess(`Added ${tokenInfo.symbol} to your token list!`);
        setTimeout(() => setSuccess(null), 3000);
        fetchTokenBalances();
      } else {
        setError(
          "Could not find token information. Make sure the address is correct."
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add token");
    } finally {
      setAddingToken(false);
    }
  };

  // Remove custom token
  const handleRemoveToken = (tokenAddress: string) => {
    removeCustomToken(network, tokenAddress);
    fetchTokenBalances();
    setSuccess("Token removed from list");
    setTimeout(() => setSuccess(null), 2000);
  };

  // Reset wallet
  const handleReset = () => {
    clearStoredCredential();
    setWallet(null);
    setView("onboarding");
    setBalance("0");
    setUsername("");
    setHasCredential(false);
  };

  // Recover wallet using discoverable credentials
  const handleRecoverWallet = async () => {
    setLoading(true);
    setError(null);

    try {
      const walletData = await recoverWallet();
      if (walletData) {
        setWallet(walletData);
        setHasCredential(true);
        setStoredWallets(getStoredWallets());
        setView("wallet");
        setSuccess("Wallet recovered successfully!");
        setTimeout(() => setSuccess(null), 3000);
      } else {
        setError("Failed to recover wallet");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to recover wallet");
    } finally {
      setLoading(false);
    }
  };

  // Select and authenticate with a specific wallet
  const handleSelectWallet = async (walletInfo: StoredWallet) => {
    setLoading(true);
    setError(null);

    try {
      const walletData = await authenticateWithWallet(walletInfo);
      if (walletData) {
        setWallet(walletData);
        setHasCredential(true);
        setView("wallet");
        setSuccess(`Logged in as ${walletInfo.username}`);
        setTimeout(() => setSuccess(null), 3000);
      } else {
        setError("Failed to authenticate");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to authenticate");
    } finally {
      setLoading(false);
      setSelectedWalletIndex(null);
    }
  };

  // WalletConnect: Connect to dApp
  const handleWcConnect = async () => {
    if (!wcUri.trim()) {
      setError("Please enter a WalletConnect URI");
      return;
    }

    setWcConnecting(true);
    setError(null);

    try {
      await connectWithUri(wcUri);
      setWcUri("");
      // Session proposal will come via the callback
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setWcConnecting(false);
    }
  };

  // WalletConnect: Approve session
  const handleApproveSession = async () => {
    if (!sessionProposal || !wallet) return;

    setLoading(true);
    try {
      const session = await approveSession(
        sessionProposal.id,
        sessionProposal.params,
        wallet.address
      );
      setActiveSessions((prev) => [...prev, session]);
      setSessionProposal(null);
      setSuccess("Connected to dApp!");
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to approve session"
      );
    } finally {
      setLoading(false);
    }
  };

  // WalletConnect: Reject session
  const handleRejectSession = async () => {
    if (!sessionProposal) return;

    try {
      await rejectSession(sessionProposal.id);
      setSessionProposal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject session");
    }
  };

  // WalletConnect: Handle request (approve/reject)
  const handleWcRequest = async (approve: boolean) => {
    if (!sessionRequest || !wallet) return;

    setLoading(true);
    try {
      const result = await handleSessionRequest(
        sessionRequest,
        wallet.privateKey,
        approve
      );
      if (result && approve) {
        setSuccess("Request approved!");
        setTimeout(() => setSuccess(null), 3000);
      }
      setSessionRequest(null);
      fetchBalance(); // Refresh balance after transaction
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to process request"
      );
    } finally {
      setLoading(false);
    }
  };

  // WalletConnect: Disconnect session
  const handleDisconnectSession = async (topic: string) => {
    try {
      await disconnectSession(topic);
      setActiveSessions((prev) => prev.filter((s) => s.topic !== topic));
      setSuccess("Disconnected from dApp");
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    }
  };

  // Copy address to clipboard
  const copyAddress = async () => {
    if (!wallet) return;
    await navigator.clipboard.writeText(wallet.address);
    setSuccess("Address copied!");
    setTimeout(() => setSuccess(null), 2000);
  };

  const copyPrivateKey = async () => {
    if (!wallet) return;
    await navigator.clipboard.writeText(wallet.privateKey);
    setSuccess("Private key copied to clipboard!");
    setTimeout(() => setSuccess(null), 3000);
  };

  // Show loading state until mounted to prevent hydration mismatch
  if (!mounted) {
    return (
      <div className="min-h-screen gradient-bg cyber-grid flex items-center justify-center p-4 safe-area-all">
        <div className="flex flex-col items-center gap-4 animate-pulse-glow">
          <div className="punk-loader">
            <svg
              width="80"
              height="80"
              viewBox="0 0 24 24"
              className="punk-icon"
            >
              <rect width="24" height="24" fill="#639bff" rx="3" />
              {/* Simple punk face */}
              <rect x="8" y="10" width="8" height="8" fill="#ffd8b1" />
              <rect x="7" y="12" width="1" height="3" fill="#ffd8b1" />
              <rect x="16" y="12" width="1" height="3" fill="#ffd8b1" />
              <rect x="9" y="12" width="1" height="1" fill="#000" />
              <rect x="14" y="12" width="1" height="1" fill="#000" />
              <rect x="11" y="15" width="2" height="1" fill="#000" />
              {/* Mohawk */}
              <rect x="11" y="4" width="2" height="6" fill="#ff1493" />
              <rect x="10" y="8" width="4" height="2" fill="#ff1493" />
            </svg>
          </div>
          <div className="text-accent-light font-bold text-lg">Loading...</div>
        </div>
      </div>
    );
  }

  // Render onboarding view
  if (view === "onboarding") {
    return (
      <div className="min-h-screen gradient-bg cyber-grid flex items-center justify-center p-4 safe-area-all">
        <div className="w-full max-w-md space-y-8 animate-fade-in">
          {/* Logo with Punk */}
          <div className="text-center space-y-4">
            <div className="inline-block glow animate-pulse-glow rounded-2xl overflow-hidden">
              <svg
                width="96"
                height="96"
                viewBox="0 0 24 24"
                className="punk-logo"
              >
                <rect width="24" height="24" fill="#639bff" rx="3" />
                {/* Punk face */}
                <rect x="8" y="10" width="8" height="8" fill="#ffd8b1" />
                <rect x="7" y="12" width="1" height="3" fill="#ffd8b1" />
                <rect x="16" y="12" width="1" height="3" fill="#ffd8b1" />
                <rect x="10" y="18" width="4" height="3" fill="#ffd8b1" />
                {/* Eyes */}
                <rect x="9" y="12" width="1" height="1" fill="#000" />
                <rect x="14" y="12" width="1" height="1" fill="#000" />
                {/* Mouth */}
                <rect x="11" y="15" width="2" height="1" fill="#000" />
                {/* Pink Mohawk */}
                <rect x="11" y="3" width="2" height="7" fill="#ff1493" />
                <rect x="10" y="8" width="4" height="2" fill="#ff1493" />
                {/* Sunglasses */}
                <rect x="8" y="11" width="3" height="2" fill="#000" />
                <rect x="13" y="11" width="3" height="2" fill="#000" />
                <rect x="11" y="11" width="2" height="1" fill="#000" />
              </svg>
            </div>
            <h1 className="text-4xl font-bold tracking-tight">
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-pink-500 via-purple-500 to-cyan-500">
                Punk
              </span>{" "}
              Wallet
            </h1>
            <p className="text-foreground/60 text-lg">
              Self-custodial Ethereum wallet secured by passkeys
            </p>
          </div>

          {/* Card */}
          <div className="bg-card-bg border border-card-border rounded-2xl p-8 space-y-6 glow-sm">
            {hasCredential ? (
              <>
                <div className="text-center space-y-2">
                  <h2 className="text-xl font-semibold">Welcome back</h2>
                  <p className="text-foreground/60">
                    Unlock your wallet with your passkey
                  </p>
                </div>

                <button
                  onClick={handleUnlockWallet}
                  disabled={loading}
                  className="w-full py-4 px-6 rounded-xl bg-accent hover:bg-accent-dark transition-all duration-200 font-semibold text-white btn-glow disabled:opacity-50"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
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
                      Authenticating...
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2">
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
                          d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4"
                        />
                      </svg>
                      Unlock with Passkey
                    </span>
                  )}
                </button>

                <button
                  onClick={handleReset}
                  className="w-full py-3 text-foreground/60 hover:text-foreground transition-colors"
                >
                  Use a different wallet
                </button>
              </>
            ) : (
              <>
                {/* Existing Wallets Section - Show first if there are wallets */}
                {storedWallets.length > 0 && (
                  <>
                    <div className="text-center space-y-2">
                      <h2 className="text-xl font-semibold">Your Wallets</h2>
                      <p className="text-foreground/60">
                        Select a wallet to unlock
                      </p>
                    </div>

                    <div className="space-y-2">
                      {storedWallets.map((w, i) => (
                        <button
                          key={i}
                          onClick={() => {
                            setSelectedWalletIndex(i);
                            handleSelectWallet(w);
                          }}
                          disabled={loading}
                          className={`w-full p-4 rounded-xl border transition-all duration-200 text-left disabled:opacity-50 ${
                            selectedWalletIndex === i
                              ? "bg-accent/20 border-accent"
                              : "bg-input-bg border-card-border hover:border-accent/50 hover:bg-card-border/30"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <PunkAvatar address={w.address} size={48} />
                              <div>
                                <div className="font-medium">{w.username}</div>
                                <div className="font-mono text-xs text-foreground/40">
                                  {w.address.slice(0, 6)}...
                                  {w.address.slice(-4)}
                                </div>
                              </div>
                            </div>
                            <div className="text-right">
                              {loadingBalances ? (
                                <div className="text-sm text-foreground/40">
                                  Loading...
                                </div>
                              ) : (
                                <>
                                  <div className="font-semibold tabular-nums">
                                    {parseFloat(
                                      walletBalances[w.address] || "0"
                                    ).toFixed(4)}
                                  </div>
                                  <div className="text-xs text-foreground/40">
                                    ETH
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                          {selectedWalletIndex === i && loading && (
                            <div className="mt-3 flex items-center justify-center gap-2 text-sm text-accent-light">
                              <svg
                                className="animate-spin h-4 w-4"
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
                              Authenticating with passkey...
                            </div>
                          )}
                        </button>
                      ))}
                    </div>

                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-card-border"></div>
                      </div>
                      <div className="relative flex justify-center text-sm">
                        <span className="px-4 bg-card-bg text-foreground/40">
                          or create a new wallet
                        </span>
                      </div>
                    </div>
                  </>
                )}

                {/* Create wallet section - Show header only if no existing wallets */}
                {storedWallets.length === 0 && (
                  <div className="text-center space-y-2">
                    <h2 className="text-xl font-semibold">
                      Create your wallet
                    </h2>
                    <p className="text-foreground/60">
                      Your wallet will be secured with a passkey
                    </p>
                  </div>
                )}

                <input
                  type="text"
                  placeholder="Enter a username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-4 py-4 rounded-xl bg-input-bg border border-card-border text-foreground placeholder-foreground/40 focus:border-accent transition-colors"
                />

                <button
                  onClick={handleCreateWallet}
                  disabled={loading}
                  className="w-full py-4 px-6 rounded-xl bg-accent hover:bg-accent-dark transition-all duration-200 font-semibold text-white btn-glow disabled:opacity-50"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
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
                      Creating...
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2">
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
                          d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                        />
                      </svg>
                      Create Wallet
                    </span>
                  )}
                </button>

                {/* Recover from device passkeys */}
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-card-border"></div>
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-4 bg-card-bg text-foreground/40">
                      or
                    </span>
                  </div>
                </div>

                <button
                  onClick={handleRecoverWallet}
                  disabled={loading}
                  className="w-full py-4 px-6 rounded-xl bg-card-border hover:bg-card-border/80 transition-all duration-200 font-semibold disabled:opacity-50"
                >
                  <span className="flex items-center justify-center gap-2">
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
                    Recover from Passkey
                  </span>
                </button>
              </>
            )}

            {error && (
              <div className="p-4 rounded-xl bg-error/20 border border-error/40 text-error text-sm">
                {error}
              </div>
            )}
          </div>

          {/* Info */}
          <div className="text-center text-foreground/40 text-sm space-y-1">
            <p>Powered by EIP-7951 secp256r1 verification</p>
            <p>Your keys never leave your device</p>
          </div>
        </div>
      </div>
    );
  }

  // Render wallet view
  return (
    <div className="min-h-screen gradient-bg cyber-grid safe-area-all">
      {/* Header */}
      <header className="border-b border-card-border bg-card-bg/50 backdrop-blur-sm sticky top-0 z-10 safe-area-top">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl overflow-hidden">
              <svg width="40" height="40" viewBox="0 0 24 24">
                <rect width="24" height="24" fill="#639bff" rx="2" />
                <rect x="8" y="10" width="8" height="8" fill="#ffd8b1" />
                <rect x="7" y="12" width="1" height="3" fill="#ffd8b1" />
                <rect x="16" y="12" width="1" height="3" fill="#ffd8b1" />
                <rect x="9" y="12" width="1" height="1" fill="#000" />
                <rect x="14" y="12" width="1" height="1" fill="#000" />
                <rect x="11" y="15" width="2" height="1" fill="#000" />
                <rect x="11" y="4" width="2" height="6" fill="#ff1493" />
                <rect x="10" y="8" width="4" height="2" fill="#ff1493" />
              </svg>
            </div>
            <span className="font-bold text-lg">
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-pink-500 to-cyan-500">
                Punk
              </span>{" "}
              Wallet
            </span>
          </div>

          <div className="flex items-center gap-3">
            <select
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
              className="px-3 py-2 rounded-lg bg-input-bg border border-card-border text-sm cursor-pointer"
            >
              {Object.keys(NETWORKS).map((net) => (
                <option key={net} value={net}>
                  {net.charAt(0).toUpperCase() + net.slice(1)}
                </option>
              ))}
            </select>

            <button
              onClick={() => {
                setView("export");
                setShowPrivateKey(false);
                setExportConfirmed(false);
              }}
              className="p-2 rounded-lg hover:bg-card-border/50 transition-colors"
              title="Export private key"
            >
              <svg
                className="w-5 h-5 text-foreground/60"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                />
              </svg>
            </button>

            <button
              onClick={handleReset}
              className="p-2 rounded-lg hover:bg-card-border/50 transition-colors"
              title="Lock wallet"
            >
              <svg
                className="w-5 h-5 text-foreground/60"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Notifications */}
        {success && (
          <div className="p-4 rounded-xl bg-success/20 border border-success/40 text-success text-sm animate-fade-in">
            {success}
          </div>
        )}

        {error && (
          <div className="p-4 rounded-xl bg-error/20 border border-error/40 text-error text-sm animate-fade-in">
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-2 text-error/60 hover:text-error"
            >
              ×
            </button>
          </div>
        )}

        {/* Balance Card */}
        {view === "wallet" && wallet && (
          <div className="bg-card-bg border border-card-border rounded-2xl p-6 space-y-6 glow-sm animate-fade-in">
            {/* Address with Punk Avatar */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <PunkAvatar
                    address={wallet.address}
                    size={64}
                    className="glow-sm"
                  />
                  <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-success border-2 border-card-bg flex items-center justify-center">
                    <svg
                      className="w-3 h-3 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={3}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                </div>
                <div>
                  <button
                    onClick={copyAddress}
                    className="font-mono text-lg hover:text-accent-light transition-colors flex items-center gap-2"
                  >
                    {formatAddress(wallet.address)}
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                  </button>
                  <a
                    href={getAddressExplorerUrl(wallet.address, network)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-foreground/40 hover:text-accent-light transition-colors"
                  >
                    View on Explorer ↗
                  </a>
                </div>
              </div>

              <button
                onClick={fetchBalance}
                className="p-2 rounded-lg hover:bg-card-border/50 transition-colors"
                title="Refresh balance"
              >
                <svg
                  className="w-5 h-5 text-foreground/60"
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
            </div>

            {/* Balance */}
            <div className="text-center py-8">
              <div className="text-5xl font-bold tabular-nums">
                {parseFloat(balance).toFixed(6)}
              </div>
              <div className="text-xl text-foreground/60 mt-2">ETH</div>
            </div>

            {/* Action buttons */}
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => setView("send")}
                className="py-4 px-6 rounded-xl bg-accent hover:bg-accent-dark transition-all duration-200 font-semibold text-white btn-glow flex items-center justify-center gap-2"
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
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                </svg>
                Send
              </button>
              <button
                onClick={() => setView("receive")}
                className="py-4 px-6 rounded-xl bg-card-border hover:bg-card-border/80 transition-all duration-200 font-semibold flex items-center justify-center gap-2"
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
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  />
                </svg>
                Receive
              </button>
            </div>

            {/* WalletConnect button */}
            <button
              onClick={() => setView("connect")}
              className="w-full py-4 px-6 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 transition-all duration-200 font-semibold text-white flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6.09 10.11c3.26-3.19 8.56-3.19 11.82 0l.39.38a.4.4 0 010 .58l-1.35 1.32a.21.21 0 01-.3 0l-.54-.53c-2.27-2.22-5.96-2.22-8.23 0l-.58.56a.21.21 0 01-.3 0L5.66 11.1a.4.4 0 010-.58l.43-.41zm14.6 2.71l1.2 1.18a.4.4 0 010 .58l-5.42 5.3a.42.42 0 01-.59 0l-3.85-3.76a.1.1 0 00-.15 0l-3.85 3.77a.42.42 0 01-.59 0L2.02 14.6a.4.4 0 010-.58l1.2-1.18a.42.42 0 01.59 0l3.85 3.77a.1.1 0 00.15 0l3.85-3.77a.42.42 0 01.59 0l3.85 3.77a.1.1 0 00.15 0l3.85-3.77a.42.42 0 01.59 0z" />
              </svg>
              Connect to dApp
              {activeSessions.length > 0 && (
                <span className="ml-2 px-2 py-0.5 rounded-full bg-white/20 text-xs">
                  {activeSessions.length}
                </span>
              )}
            </button>

            {/* Token Balances Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-foreground/60">
                  Tokens
                </h3>
                <button
                  onClick={() => setView("tokens")}
                  className="text-xs text-accent-light hover:text-accent transition-colors"
                >
                  Manage Tokens
                </button>
              </div>

              {loadingTokens ? (
                <div className="text-center py-4 text-foreground/40 text-sm">
                  Loading tokens...
                </div>
              ) : tokenBalances.length === 0 ? (
                <div className="text-center py-4 text-foreground/40 text-sm">
                  No tokens found
                </div>
              ) : (
                <div className="space-y-2">
                  {tokenBalances
                    .filter((tb) => parseFloat(tb.balance) > 0)
                    .map((tb) => (
                      <div
                        key={tb.token.address}
                        className="flex items-center justify-between p-3 rounded-xl bg-input-bg border border-card-border hover:border-accent/30 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          {tb.token.logoURI ? (
                            <img
                              src={tb.token.logoURI}
                              alt={tb.token.symbol}
                              className="w-8 h-8 rounded-full"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display =
                                  "none";
                              }}
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center">
                              <span className="text-xs font-bold text-accent-light">
                                {tb.token.symbol.slice(0, 2)}
                              </span>
                            </div>
                          )}
                          <div>
                            <div className="font-medium">{tb.token.symbol}</div>
                            <div className="text-xs text-foreground/40">
                              {tb.token.name}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold tabular-nums">
                            {formatTokenAmount(tb.balance)}
                          </div>
                        </div>
                      </div>
                    ))}
                  {tokenBalances.filter((tb) => parseFloat(tb.balance) > 0)
                    .length === 0 && (
                    <div className="text-center py-4 text-foreground/40 text-sm">
                      No token balances
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Send View */}
        {view === "send" && wallet && (
          <div className="bg-card-bg border border-card-border rounded-2xl p-6 space-y-6 glow-sm animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">
                Send {selectedToken ? selectedToken.symbol : "ETH"}
              </h2>
              <button
                onClick={() => {
                  setView("wallet");
                  setTxHash(null);
                  setError(null);
                  setSelectedToken(null);
                }}
                className="p-2 rounded-lg hover:bg-card-border/50 transition-colors"
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
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {txHash ? (
              <div className="space-y-4 py-8 text-center">
                <div className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center mx-auto">
                  <svg
                    className="w-8 h-8 text-success"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold">Transaction Sent!</h3>
                <a
                  href={getExplorerUrl(txHash, network)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-light hover:text-accent transition-colors text-sm"
                >
                  View on Explorer ↗
                </a>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Token Selection */}
                <div>
                  <label className="block text-sm text-foreground/60 mb-2">
                    Asset
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    <button
                      onClick={() => setSelectedToken(null)}
                      className={`p-3 rounded-xl border transition-all ${
                        selectedToken === null
                          ? "bg-accent/20 border-accent"
                          : "bg-input-bg border-card-border hover:border-accent/50"
                      }`}
                    >
                      <div className="text-center">
                        <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center mx-auto mb-1">
                          <span className="text-xs font-bold">Ξ</span>
                        </div>
                        <div className="text-xs font-medium">ETH</div>
                      </div>
                    </button>
                    {tokenBalances
                      .filter((tb) => parseFloat(tb.balance) > 0)
                      .slice(0, 7)
                      .map((tb) => (
                        <button
                          key={tb.token.address}
                          onClick={() => setSelectedToken(tb.token)}
                          className={`p-3 rounded-xl border transition-all ${
                            selectedToken?.address === tb.token.address
                              ? "bg-accent/20 border-accent"
                              : "bg-input-bg border-card-border hover:border-accent/50"
                          }`}
                        >
                          <div className="text-center">
                            {tb.token.logoURI ? (
                              <img
                                src={tb.token.logoURI}
                                alt={tb.token.symbol}
                                className="w-8 h-8 rounded-full mx-auto mb-1"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display =
                                    "none";
                                }}
                              />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center mx-auto mb-1">
                                <span className="text-xs font-bold">
                                  {tb.token.symbol.slice(0, 2)}
                                </span>
                              </div>
                            )}
                            <div className="text-xs font-medium truncate">
                              {tb.token.symbol}
                            </div>
                          </div>
                        </button>
                      ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-foreground/60 mb-2">
                    Recipient Address
                  </label>
                  <input
                    type="text"
                    placeholder="0x..."
                    value={sendTo}
                    onChange={(e) => setSendTo(e.target.value)}
                    className="w-full px-4 py-4 rounded-xl bg-input-bg border border-card-border text-foreground placeholder-foreground/40 font-mono text-sm"
                  />
                </div>

                <div>
                  <label className="block text-sm text-foreground/60 mb-2">
                    Amount ({selectedToken ? selectedToken.symbol : "ETH"})
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      placeholder="0.0"
                      value={sendAmount}
                      onChange={(e) => setSendAmount(e.target.value)}
                      step="0.0001"
                      min="0"
                      className="w-full px-4 py-4 rounded-xl bg-input-bg border border-card-border text-foreground placeholder-foreground/40 pr-16"
                    />
                    <button
                      onClick={() => {
                        if (selectedToken) {
                          const tokenBal = tokenBalances.find(
                            (tb) => tb.token.address === selectedToken.address
                          );
                          if (tokenBal) setSendAmount(tokenBal.balance);
                        } else {
                          setAmount(balance);
                        }
                      }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-accent-light hover:text-accent"
                    >
                      MAX
                    </button>
                  </div>
                  <p className="text-sm text-foreground/40 mt-2">
                    Balance:{" "}
                    {selectedToken
                      ? formatTokenAmount(
                          tokenBalances.find(
                            (tb) => tb.token.address === selectedToken.address
                          )?.balance || "0"
                        )
                      : parseFloat(balance).toFixed(6)}{" "}
                    {selectedToken ? selectedToken.symbol : "ETH"}
                  </p>
                </div>

                <button
                  onClick={handleSend}
                  disabled={loading || !sendTo || !sendAmount}
                  className="w-full py-4 px-6 rounded-xl bg-accent hover:bg-accent-dark transition-all duration-200 font-semibold text-white btn-glow disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
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
                      Signing & Sending...
                    </span>
                  ) : (
                    `Send ${selectedToken ? selectedToken.symbol : "ETH"}`
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Receive View */}
        {view === "receive" && wallet && (
          <div className="bg-card-bg border border-card-border rounded-2xl p-6 space-y-6 glow-sm animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Receive ETH</h2>
              <button
                onClick={() => setView("wallet")}
                className="p-2 rounded-lg hover:bg-card-border/50 transition-colors"
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
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="text-center space-y-6 py-4">
              {/* Punk Avatar */}
              <div className="flex justify-center">
                <PunkAvatar
                  address={wallet.address}
                  size={80}
                  className="glow"
                />
              </div>

              {/* QR Code */}
              <div className="inline-flex items-center justify-center bg-white rounded-2xl p-4 mx-auto relative">
                <QRCodeSVG
                  value={wallet.address}
                  size={180}
                  level="H"
                  includeMargin={false}
                />
                {/* Punk overlay in center of QR */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="bg-white p-1 rounded-lg">
                    <PunkBlockie address={wallet.address} size={36} />
                  </div>
                </div>
              </div>

              <div>
                <p className="text-foreground/60 text-sm mb-2">Your Address</p>
                <div className="bg-input-bg border border-card-border rounded-xl p-4">
                  <code className="font-mono text-sm break-all">
                    {wallet.address}
                  </code>
                </div>
              </div>

              <button
                onClick={copyAddress}
                className="py-3 px-6 rounded-xl bg-gradient-to-r from-pink-500 to-purple-500 hover:from-pink-600 hover:to-purple-600 transition-all duration-200 font-semibold text-white inline-flex items-center gap-2"
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
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
                Copy Address
              </button>

              <p className="text-foreground/40 text-sm">
                Send only ETH or ERC-20 tokens to this address on{" "}
                {network.charAt(0).toUpperCase() + network.slice(1)}
              </p>
            </div>
          </div>
        )}

        {/* Export Private Key View */}
        {view === "export" && wallet && (
          <div className="bg-card-bg border border-card-border rounded-2xl p-6 space-y-6 glow-sm animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Export Private Key</h2>
              <button
                onClick={() => {
                  setView("wallet");
                  setShowPrivateKey(false);
                  setExportConfirmed(false);
                }}
                className="p-2 rounded-lg hover:bg-card-border/50 transition-colors"
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
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {!exportConfirmed ? (
              <div className="space-y-6">
                {/* Warning Box */}
                <div className="p-4 rounded-xl bg-error/10 border border-error/30">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-10 h-10 rounded-full bg-error/20 flex items-center justify-center">
                      <svg
                        className="w-6 h-6 text-error"
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
                    <div className="space-y-2">
                      <h3 className="font-semibold text-error">
                        Security Warning
                      </h3>
                      <ul className="text-sm text-foreground/70 space-y-1 list-disc list-inside">
                        <li>
                          Your private key grants full access to your wallet
                        </li>
                        <li>Anyone with this key can steal all your funds</li>
                        <li>
                          Never share it with anyone or enter it on websites
                        </li>
                        <li>
                          Store it securely offline if you must back it up
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>

                {/* Wallet info */}
                <div className="flex items-center gap-4 p-4 rounded-xl bg-input-bg border border-card-border">
                  <PunkAvatar address={wallet.address} size={48} />
                  <div>
                    <div className="font-medium">
                      {wallet.credential.username || "Wallet"}
                    </div>
                    <div className="text-sm text-foreground/50 font-mono">
                      {formatAddress(wallet.address)}
                    </div>
                  </div>
                </div>

                {/* Confirmation checkbox */}
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportConfirmed}
                    onChange={(e) => setExportConfirmed(e.target.checked)}
                    className="mt-1 w-5 h-5 rounded border-card-border bg-input-bg accent-accent cursor-pointer"
                  />
                  <span className="text-sm text-foreground/70">
                    I understand the risks and take full responsibility for
                    keeping my private key secure
                  </span>
                </label>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Private Key Display */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-foreground/60">
                      Private Key
                    </label>
                    <button
                      onClick={() => setShowPrivateKey(!showPrivateKey)}
                      className="text-sm text-accent-light hover:text-accent transition-colors flex items-center gap-1"
                    >
                      {showPrivateKey ? (
                        <>
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                            />
                          </svg>
                          Hide
                        </>
                      ) : (
                        <>
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                            />
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                            />
                          </svg>
                          Reveal
                        </>
                      )}
                    </button>
                  </div>

                  <div className="relative">
                    <div className="bg-input-bg border border-card-border rounded-xl p-4 pr-12">
                      <code className="font-mono text-sm break-all select-all">
                        {showPrivateKey
                          ? wallet.privateKey
                          : "••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••"}
                      </code>
                    </div>
                    {showPrivateKey && (
                      <button
                        onClick={copyPrivateKey}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg hover:bg-card-border/50 transition-colors"
                        title="Copy private key"
                      >
                        <svg
                          className="w-5 h-5 text-foreground/60"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>

                {/* Warning reminder */}
                <div className="p-3 rounded-lg bg-warning/10 border border-warning/30 flex items-center gap-2">
                  <svg
                    className="w-5 h-5 text-warning flex-shrink-0"
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
                  <span className="text-xs text-foreground/60">
                    Never paste this key into websites or share it with anyone
                  </span>
                </div>

                {/* Copy button */}
                {showPrivateKey && (
                  <button
                    onClick={copyPrivateKey}
                    className="w-full py-3 px-6 rounded-xl bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 transition-all duration-200 font-semibold text-white flex items-center justify-center gap-2"
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
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                    Copy Private Key
                  </button>
                )}

                {/* Back to safety */}
                <button
                  onClick={() => {
                    setShowPrivateKey(false);
                    setExportConfirmed(false);
                  }}
                  className="w-full py-3 px-6 rounded-xl bg-card-border hover:bg-card-border/80 transition-all duration-200 font-medium"
                >
                  Hide & Go Back
                </button>
              </div>
            )}
          </div>
        )}

        {/* Connect View */}
        {view === "connect" && wallet && (
          <div className="bg-card-bg border border-card-border rounded-2xl p-6 space-y-6 glow-sm animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Connect to dApp</h2>
              <button
                onClick={() => setView("wallet")}
                className="p-2 rounded-lg hover:bg-card-border/50 transition-colors"
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
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-foreground/60 mb-2">
                  WalletConnect URI
                </label>
                <input
                  type="text"
                  placeholder="wc:..."
                  value={wcUri}
                  onChange={(e) => setWcUri(e.target.value)}
                  className="w-full px-4 py-4 rounded-xl bg-input-bg border border-card-border text-foreground placeholder-foreground/40 font-mono text-sm"
                />
                <p className="text-xs text-foreground/40 mt-2">
                  Copy the WalletConnect URI from the dApp and paste it here
                </p>
              </div>

              <button
                onClick={handleWcConnect}
                disabled={wcConnecting || !wcUri.trim()}
                className="w-full py-4 px-6 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 transition-all duration-200 font-semibold text-white disabled:opacity-50"
              >
                {wcConnecting ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
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
                    Connecting...
                  </span>
                ) : (
                  "Connect"
                )}
              </button>
            </div>

            {/* Active Sessions */}
            {activeSessions.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-foreground/60">
                  Connected dApps
                </h3>
                {activeSessions.map((session) => (
                  <div
                    key={session.topic}
                    className="flex items-center justify-between p-4 rounded-xl bg-input-bg border border-card-border"
                  >
                    <div className="flex items-center gap-3">
                      {session.peerMeta.icons[0] && (
                        <img
                          src={session.peerMeta.icons[0]}
                          alt=""
                          className="w-10 h-10 rounded-lg"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display =
                              "none";
                          }}
                        />
                      )}
                      <div>
                        <div className="font-medium">
                          {session.peerMeta.name}
                        </div>
                        <div className="text-xs text-foreground/40">
                          {session.peerMeta.url}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDisconnectSession(session.topic)}
                      className="p-2 rounded-lg hover:bg-error/20 text-error transition-colors"
                      title="Disconnect"
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
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tokens Management View */}
        {view === "tokens" && wallet && (
          <div className="bg-card-bg border border-card-border rounded-2xl p-6 space-y-6 glow-sm animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Manage Tokens</h2>
              <button
                onClick={() => {
                  setView("wallet");
                  setShowAddToken(false);
                }}
                className="p-2 rounded-lg hover:bg-card-border/50 transition-colors"
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
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Add Custom Token Section */}
            {showAddToken ? (
              <div className="space-y-4 p-4 rounded-xl bg-input-bg border border-card-border">
                <h3 className="font-medium">Add Custom Token</h3>
                <div>
                  <label className="block text-sm text-foreground/60 mb-2">
                    Token Contract Address
                  </label>
                  <input
                    type="text"
                    placeholder="0x..."
                    value={customTokenAddress}
                    onChange={(e) => setCustomTokenAddress(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-card-bg border border-card-border text-foreground placeholder-foreground/40 font-mono text-sm"
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setShowAddToken(false);
                      setCustomTokenAddress("");
                    }}
                    className="flex-1 py-3 px-4 rounded-xl bg-card-border hover:bg-card-border/80 transition-all font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddCustomToken}
                    disabled={addingToken || !customTokenAddress}
                    className="flex-1 py-3 px-4 rounded-xl bg-accent hover:bg-accent-dark transition-all font-medium text-white disabled:opacity-50"
                  >
                    {addingToken ? "Adding..." : "Add Token"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAddToken(true)}
                className="w-full py-3 px-4 rounded-xl border border-dashed border-card-border hover:border-accent/50 transition-all text-foreground/60 hover:text-foreground flex items-center justify-center gap-2"
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
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
                Add Custom Token
              </button>
            )}

            {/* Token List */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-foreground/60">
                All Tokens on{" "}
                {network.charAt(0).toUpperCase() + network.slice(1)}
              </h3>

              {loadingTokens ? (
                <div className="text-center py-8 text-foreground/40">
                  Loading tokens...
                </div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {tokenBalances.map((tb) => {
                    const isCustom = !getTokensForNetwork(network)
                      .slice(0, 10)
                      .some(
                        (t) =>
                          t.address.toLowerCase() ===
                          tb.token.address.toLowerCase()
                      );
                    return (
                      <div
                        key={tb.token.address}
                        className="flex items-center justify-between p-4 rounded-xl bg-input-bg border border-card-border"
                      >
                        <div className="flex items-center gap-3">
                          {tb.token.logoURI ? (
                            <img
                              src={tb.token.logoURI}
                              alt={tb.token.symbol}
                              className="w-10 h-10 rounded-full"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display =
                                  "none";
                              }}
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
                              <span className="text-sm font-bold text-accent-light">
                                {tb.token.symbol.slice(0, 2)}
                              </span>
                            </div>
                          )}
                          <div>
                            <div className="font-medium flex items-center gap-2">
                              {tb.token.symbol}
                              {isCustom && (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-accent/20 text-accent-light">
                                  Custom
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-foreground/40">
                              {tb.token.name}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <div className="font-semibold tabular-nums">
                              {formatTokenAmount(tb.balance)}
                            </div>
                            <div className="text-xs text-foreground/40 font-mono">
                              {tb.token.address.slice(0, 6)}...
                              {tb.token.address.slice(-4)}
                            </div>
                          </div>
                          {isCustom && (
                            <button
                              onClick={() =>
                                handleRemoveToken(tb.token.address)
                              }
                              className="p-2 rounded-lg hover:bg-error/20 text-error/60 hover:text-error transition-colors"
                              title="Remove token"
                            >
                              <svg
                                className="w-4 h-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              onClick={() => fetchTokenBalances()}
              className="w-full py-3 px-4 rounded-xl bg-card-border hover:bg-card-border/80 transition-all font-medium flex items-center justify-center gap-2"
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
              Refresh Balances
            </button>
          </div>
        )}

        {/* Session Proposal Modal */}
        {sessionProposal && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
            <div className="bg-card-bg border border-card-border rounded-2xl p-6 max-w-md w-full space-y-6 animate-fade-in">
              <div className="text-center space-y-4">
                {sessionProposal.params.proposer.metadata.icons[0] && (
                  <img
                    src={sessionProposal.params.proposer.metadata.icons[0]}
                    alt=""
                    className="w-16 h-16 rounded-xl mx-auto"
                  />
                )}
                <div>
                  <h3 className="text-xl font-semibold">
                    {sessionProposal.params.proposer.metadata.name}
                  </h3>
                  <p className="text-sm text-foreground/40">
                    {sessionProposal.params.proposer.metadata.url}
                  </p>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-input-bg border border-card-border">
                <p className="text-sm text-foreground/60">
                  This dApp wants to connect to your wallet
                </p>
                <p className="text-xs text-foreground/40 mt-2">
                  {sessionProposal.params.proposer.metadata.description}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={handleRejectSession}
                  className="py-3 px-6 rounded-xl bg-card-border hover:bg-card-border/80 transition-all duration-200 font-semibold"
                >
                  Reject
                </button>
                <button
                  onClick={handleApproveSession}
                  disabled={loading}
                  className="py-3 px-6 rounded-xl bg-accent hover:bg-accent-dark transition-all duration-200 font-semibold text-white disabled:opacity-50"
                >
                  {loading ? "Connecting..." : "Approve"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Session Request Modal */}
        {sessionRequest && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
            <div className="bg-card-bg border border-card-border rounded-2xl p-6 max-w-md w-full space-y-6 animate-fade-in">
              {(() => {
                const display = formatRequestDisplay(sessionRequest);
                return (
                  <>
                    <div className="text-center">
                      <div className="w-16 h-16 rounded-xl bg-warning/20 flex items-center justify-center mx-auto mb-4">
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
                        {display.method}
                      </h3>
                      <p className="text-sm text-foreground/60 mt-2">
                        {display.description}
                      </p>
                    </div>

                    <div className="p-4 rounded-xl bg-input-bg border border-card-border max-h-40 overflow-auto">
                      <pre className="text-xs font-mono text-foreground/60 whitespace-pre-wrap break-all">
                        {display.details}
                      </pre>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <button
                        onClick={() => handleWcRequest(false)}
                        disabled={loading}
                        className="py-3 px-6 rounded-xl bg-card-border hover:bg-card-border/80 transition-all duration-200 font-semibold disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => handleWcRequest(true)}
                        disabled={loading}
                        className="py-3 px-6 rounded-xl bg-accent hover:bg-accent-dark transition-all duration-200 font-semibold text-white disabled:opacity-50"
                      >
                        {loading ? "Signing..." : "Approve"}
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* Info card - Punk themed */}
        <div className="bg-card-bg/50 border border-card-border rounded-xl p-4 text-center text-sm text-foreground/40">
          <p className="flex items-center justify-center gap-2">
            <span className="text-punk-pink">🤘</span>
            <span>
              Your keys are secured by passkeys and never leave your device
            </span>
            <span className="text-punk-cyan">🤘</span>
          </p>
        </div>

        {/* Punk Gallery Footer */}
        <div className="py-4 text-center">
          <p className="text-xs text-foreground/30">
            Powered by <span className="text-punk-pink">EIP-7951</span>{" "}
            secp256r1 verification
          </p>
        </div>
      </main>
    </div>
  );

  // Helper function for MAX button
  function setAmount(value: string) {
    const maxAmount = Math.max(0, parseFloat(value) - 0.001); // Leave some for gas
    setSendAmount(maxAmount > 0 ? maxAmount.toString() : "0");
  }
}
