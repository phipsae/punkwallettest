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
import {
  getBalance,
  sendETH,
  isValidAddress,
  formatAddress,
  getExplorerUrl,
  getAddressExplorerUrl,
  NETWORKS,
} from "@/lib/wallet";

type View = "onboarding" | "wallet" | "send" | "receive";

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
  const [walletBalances, setWalletBalances] = useState<Record<string, string>>({});
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [selectedWalletIndex, setSelectedWalletIndex] = useState<number | null>(null);

  // Send form state
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);

  // Fetch balances for all stored wallets
  const fetchWalletBalances = useCallback(async (wallets: StoredWallet[]) => {
    if (wallets.length === 0) return;
    setLoadingBalances(true);
    const balances: Record<string, string> = {};

    await Promise.all(
      wallets.map(async (w) => {
        try {
          const result = await getBalance(w.address as `0x${string}`, network);
          balances[w.address] = result.formatted;
        } catch {
          balances[w.address] = "0";
        }
      })
    );

    setWalletBalances(balances);
    setLoadingBalances(false);
  }, [network]);

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

  useEffect(() => {
    if (wallet) {
      fetchBalance();
      const interval = setInterval(fetchBalance, 15000); // Refresh every 15s
      return () => clearInterval(interval);
    }
  }, [wallet, network, fetchBalance]);

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

  // Send ETH
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
      const result = await sendETH(
        wallet.privateKey,
        sendTo as `0x${string}`,
        sendAmount,
        network
      );

      if (result.success) {
        setTxHash(result.hash);
        setSuccess("Transaction sent successfully!");
        setSendTo("");
        setSendAmount("");
        fetchBalance();
      } else {
        setError(result.error || "Transaction failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setLoading(false);
    }
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

  // Copy address to clipboard
  const copyAddress = async () => {
    if (!wallet) return;
    await navigator.clipboard.writeText(wallet.address);
    setSuccess("Address copied!");
    setTimeout(() => setSuccess(null), 2000);
  };

  // Show loading state until mounted to prevent hydration mismatch
  if (!mounted) {
    return (
      <div className="min-h-screen gradient-bg cyber-grid flex items-center justify-center p-4">
        <div className="w-20 h-20 rounded-2xl bg-accent/20 glow animate-pulse-glow flex items-center justify-center">
          <svg
            className="w-10 h-10 text-accent-light"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
        </div>
      </div>
    );
  }

  // Render onboarding view
  if (view === "onboarding") {
    return (
      <div className="min-h-screen gradient-bg cyber-grid flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-8 animate-fade-in">
          {/* Logo */}
          <div className="text-center space-y-4">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-accent/20 glow animate-pulse-glow">
              <svg
                className="w-10 h-10 text-accent-light"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
            <h1 className="text-4xl font-bold tracking-tight">
              <span className="text-accent-light">Punk</span> Wallet
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
                      <svg
                        className="animate-spin h-5 w-5"
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
                <div className="text-center space-y-2">
                  <h2 className="text-xl font-semibold">Create your wallet</h2>
                  <p className="text-foreground/60">
                    Your wallet will be secured with a passkey
                  </p>
                </div>

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
                      <svg
                        className="animate-spin h-5 w-5"
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

                {/* Existing Wallets Section */}
                {storedWallets.length > 0 && (
                  <>
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-card-border"></div>
                      </div>
                      <div className="relative flex justify-center text-sm">
                        <span className="px-4 bg-card-bg text-foreground/40">
                          or select existing wallet
                        </span>
                      </div>
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
                              <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
                                <span className="text-accent-light font-semibold">
                                  {w.username.charAt(0).toUpperCase()}
                                </span>
                              </div>
                              <div>
                                <div className="font-medium">{w.username}</div>
                                <div className="font-mono text-xs text-foreground/40">
                                  {w.address.slice(0, 6)}...{w.address.slice(-4)}
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
                                    {parseFloat(walletBalances[w.address] || "0").toFixed(4)}
                                  </div>
                                  <div className="text-xs text-foreground/40">ETH</div>
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
                  </>
                )}

                {/* Recover from device passkeys (if no stored wallets) */}
                {storedWallets.length === 0 && (
                  <>
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-card-border"></div>
                      </div>
                      <div className="relative flex justify-center text-sm">
                        <span className="px-4 bg-card-bg text-foreground/40">or</span>
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
    <div className="min-h-screen gradient-bg cyber-grid">
      {/* Header */}
      <header className="border-b border-card-border bg-card-bg/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/20 flex items-center justify-center">
              <svg
                className="w-5 h-5 text-accent-light"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
            <span className="font-bold text-lg">
              <span className="text-accent-light">Punk</span> Wallet
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
            {/* Address */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center">
                  <svg
                    className="w-6 h-6 text-accent-light"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                    />
                  </svg>
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
          </div>
        )}

        {/* Send View */}
        {view === "send" && wallet && (
          <div className="bg-card-bg border border-card-border rounded-2xl p-6 space-y-6 glow-sm animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Send ETH</h2>
              <button
                onClick={() => {
                  setView("wallet");
                  setTxHash(null);
                  setError(null);
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
                    Amount (ETH)
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
                      onClick={() => setAmount(balance)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-accent-light hover:text-accent"
                    >
                      MAX
                    </button>
                  </div>
                  <p className="text-sm text-foreground/40 mt-2">
                    Balance: {parseFloat(balance).toFixed(6)} ETH
                  </p>
                </div>

                <button
                  onClick={handleSend}
                  disabled={loading || !sendTo || !sendAmount}
                  className="w-full py-4 px-6 rounded-xl bg-accent hover:bg-accent-dark transition-all duration-200 font-semibold text-white btn-glow disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg
                        className="animate-spin h-5 w-5"
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
                      Signing & Sending...
                    </span>
                  ) : (
                    "Send ETH"
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
              {/* QR Code */}
              <div className="inline-flex items-center justify-center bg-white rounded-2xl p-4 mx-auto">
                <QRCodeSVG
                  value={wallet.address}
                  size={180}
                  level="H"
                  includeMargin={false}
                />
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
                className="py-3 px-6 rounded-xl bg-card-border hover:bg-card-border/80 transition-all duration-200 font-semibold inline-flex items-center gap-2"
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

        {/* Info card */}
        <div className="bg-card-bg/50 border border-card-border rounded-xl p-4 text-center text-sm text-foreground/40">
          <p>
            🔐 Your keys are secured by passkeys and never leave your device
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
