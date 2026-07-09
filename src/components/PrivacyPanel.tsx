"use client";

// The "Private" side of the wallet home. Renders only on privacy-supported
// networks (Ethereum mainnet, plus Sepolia in dev). Owns all privacy UI
// state; never touches key material (signing goes through signer.ts) and
// never holds SDK plugin objects (those live in kohaku.ts).

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { QRCodeSVG } from "qrcode.react";
import type { PublicWalletInfo } from "@/lib/passkey";
import { UserCancelledError } from "@/lib/passkey";
import {
  enableKohakuPrivacy,
  signAndSendBatch,
  broadcastPrivateTransfer,
} from "@/lib/signer";
import { isValidAddress, formatAddress } from "@/lib/wallet";
import {
  initPrivacy,
  getPrivateBalances,
  getRailgunAddress,
  prepareShield,
  prepareUnshield,
  prepareRailgunPrivateTransfer,
  isRailgunPrivateSendAvailable,
  isPrivacyReady,
  getPrivacyInitError,
  getAvailableProtocols,
  type ProtocolId,
  type PrivateBalanceRow,
} from "@/lib/kohaku";
import {
  isPrivacyEnabled,
  isKohakuUnlocked,
  hasAcknowledgedPrivacyRisk,
  setAcknowledgedPrivacyRisk,
  setProtocolEnabled,
} from "@/lib/kohakuSession";
import {
  isVerifiedModeEnabled,
  setVerifiedModeEnabled,
  isVerifiedModeConfigured,
  getVerifiedStatus,
  onVerifiedStatus,
  type VerifiedStatus,
} from "@/lib/verifiedMode";

type PanelView =
  | "overview"
  | "shield"
  | "unshield"
  | "receive"
  | "privateSend";

const PROTOCOL_LABELS: Record<ProtocolId, string> = {
  railgun: "Railgun",
  "privacy-pools": "Privacy Pools",
  tornado: "Tornado Cash",
};

const PROTOCOL_BLURBS: Record<ProtocolId, string> = {
  railgun: "Any amount, ETH and tokens. Most flexible.",
  "privacy-pools": "ETH, compliance-friendly via approval sets.",
  tornado: "Fixed denominations, battle-tested pools.",
};

export default function PrivacyPanel({
  wallet,
  network,
  onError,
  onSuccess,
}: {
  wallet: PublicWalletInfo;
  network: string;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}) {
  const [panelView, setPanelView] = useState<PanelView>("overview");
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [balances, setBalances] = useState<PrivateBalanceRow[]>([]);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proving, setProving] = useState(false);
  const [showRiskModal, setShowRiskModal] = useState(false);
  const [zkAddress, setZkAddress] = useState<string | null>(null);

  // Form state
  const [shieldAmount, setShieldAmount] = useState("");
  const [shieldProtocol, setShieldProtocol] = useState<ProtocolId>("railgun");
  const [unshieldAmount, setUnshieldAmount] = useState("");
  const [unshieldTo, setUnshieldTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendTo0zk, setSendTo0zk] = useState("");
  const [activeRow, setActiveRow] = useState<PrivateBalanceRow | null>(null);
  const [verifiedStatus, setVerifiedStatusState] = useState<VerifiedStatus>(
    getVerifiedStatus()
  );

  const enabled = isPrivacyEnabled(wallet.credentialId);
  const unlocked = isKohakuUnlocked(wallet.credentialId);

  useEffect(() => onVerifiedStatus(setVerifiedStatusState), []);

  const refreshBalances = useCallback(async () => {
    if (!isPrivacyReady(wallet.credentialId, network)) return;
    setLoadingBalances(true);
    try {
      const rows = await getPrivateBalances();
      setBalances(rows);
    } catch (err) {
      console.error("Failed to load private balances", err);
    } finally {
      setLoadingBalances(false);
    }
  }, [wallet.credentialId, network]);

  // Bring the plugins up when enabled + unlocked; surface a degraded reason
  // otherwise instead of blocking.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setUnavailable(null);
    if (!enabled) return;
    if (!unlocked) {
      setUnavailable("locked");
      return;
    }
    (async () => {
      try {
        await initPrivacy(wallet.credentialId, network);
        if (cancelled) return;
        setReady(true);
        refreshBalances();
      } catch {
        if (cancelled) return;
        setUnavailable(getPrivacyInitError() ?? "Privacy features unavailable.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, unlocked, wallet.credentialId, network, refreshBalances]);

  const totalSpendable = useMemo(
    () => balances.reduce((sum, r) => sum + r.spendable, BigInt(0)),
    [balances]
  );

  // Enable = one biometric prompt to derive the privacy root, then bring up
  // the plugins. Railgun is the first protocol enabled.
  const handleEnable = useCallback(async () => {
    setShowRiskModal(false);
    setBusy(true);
    try {
      await enableKohakuPrivacy({
        credentialId: wallet.credentialId,
        address: wallet.address,
        isImported: wallet.isImported,
      });
      setAcknowledgedPrivacyRisk();
      // One gate enables every protocol available in this build; they all
      // share the same passkey-derived root and session.
      for (const p of getAvailableProtocols()) {
        setProtocolEnabled(wallet.credentialId, p, true);
      }
      await initPrivacy(wallet.credentialId, network);
      setReady(true);
      onSuccess("Private balance enabled.");
      refreshBalances();
    } catch (err) {
      if (err instanceof UserCancelledError) return;
      onError(err instanceof Error ? err.message : "Failed to enable privacy.");
    } finally {
      setBusy(false);
    }
  }, [wallet, network, onError, onSuccess, refreshBalances]);

  const handleShield = useCallback(async () => {
    const row = activeRow;
    // Privacy Pools only supports ETH deposits in this version
    const contract = shieldProtocol === "privacy-pools" ? null : row?.contract ?? null;
    const decimals = contract === null ? 18 : row?.decimals ?? 18;
    let amount: bigint;
    try {
      amount = parseUnits(shieldAmount, decimals);
    } catch {
      onError("Invalid amount.");
      return;
    }
    if (amount <= BigInt(0)) {
      onError("Invalid amount.");
      return;
    }
    setBusy(true);
    try {
      const prepared = await prepareShield(shieldProtocol, {
        contract,
        amount,
        owner: wallet.address,
      });
      const result = await signAndSendBatch({
        wallet: {
          credentialId: wallet.credentialId,
          address: wallet.address,
          isImported: wallet.isImported,
        },
        txs: prepared.txs,
        networkId: network,
      });
      if (!result.success) {
        onError(result.error ?? "Shield failed.");
        return;
      }
      onSuccess("Shielded. Balance will appear after the next sync.");
      setShieldAmount("");
      setPanelView("overview");
      refreshBalances();
    } catch (err) {
      if (err instanceof UserCancelledError) return;
      onError(err instanceof Error ? err.message : "Shield failed.");
    } finally {
      setBusy(false);
    }
  }, [activeRow, shieldAmount, shieldProtocol, wallet, network, onError, onSuccess, refreshBalances]);

  const handleUnshield = useCallback(async () => {
    const row = activeRow;
    if (!row) {
      onError("Select a balance to unshield.");
      return;
    }
    const destination =
      unshieldTo.trim() === "" ? wallet.address : unshieldTo.trim();
    if (!isValidAddress(destination)) {
      onError("Invalid destination address.");
      return;
    }
    let amount: bigint;
    try {
      amount = parseUnits(unshieldAmount, row.decimals);
    } catch {
      onError("Invalid amount.");
      return;
    }
    if (amount <= BigInt(0) || amount > row.spendable) {
      onError("Amount exceeds your spendable private balance.");
      return;
    }
    setBusy(true);
    setProving(true);
    try {
      const isOwnAddress =
        destination.toLowerCase() === wallet.address.toLowerCase();
      const prepared = await prepareUnshield(row.protocol, {
        contract: row.contract,
        amount,
        to: destination as `0x${string}`,
        isOwnAddress,
      });
      setProving(false);
      if (prepared.relayed) {
        // Relayed (Privacy Pools/Tornado): the relayer submits, no EOA signing
        await prepared.relayed.broadcast();
      } else if (prepared.selfBroadcast) {
        const txs = [...prepared.selfBroadcast.txs];
        if (prepared.selfBroadcast.unwrapTx)
          txs.push(prepared.selfBroadcast.unwrapTx);
        const result = await signAndSendBatch({
          wallet: {
            credentialId: wallet.credentialId,
            address: wallet.address,
            isImported: wallet.isImported,
          },
          txs,
          networkId: network,
        });
        if (!result.success) {
          onError(result.error ?? "Unshield failed.");
          return;
        }
      }
      onSuccess("Unshielded successfully.");
      setUnshieldAmount("");
      setUnshieldTo("");
      setPanelView("overview");
      refreshBalances();
    } catch (err) {
      if (err instanceof UserCancelledError) return;
      onError(err instanceof Error ? err.message : "Unshield failed.");
    } finally {
      setBusy(false);
      setProving(false);
    }
  }, [activeRow, unshieldAmount, unshieldTo, wallet, network, onError, onSuccess, refreshBalances]);

  const handlePrivateSend = useCallback(async () => {
    const row = activeRow;
    if (!row || !row.contract) {
      onError("Private send requires a shielded token balance.");
      return;
    }
    if (!sendTo0zk.startsWith("0zk")) {
      onError("Enter a valid Railgun (0zk) recipient address.");
      return;
    }
    let amount: bigint;
    try {
      amount = parseUnits(sendAmount, row.decimals);
    } catch {
      onError("Invalid amount.");
      return;
    }
    if (amount <= BigInt(0) || amount > row.spendable) {
      onError("Amount exceeds your spendable private balance.");
      return;
    }
    setBusy(true);
    setProving(true);
    try {
      await prepareRailgunPrivateTransfer({
        to0zk: sendTo0zk.trim(),
        contract: row.contract,
        amount,
      });
      setProving(false);
      // Relayed via bundler; the passkey prompt authorizes the fee UserOp
      await broadcastPrivateTransfer({
        credentialId: wallet.credentialId,
        address: wallet.address,
        isImported: wallet.isImported,
      });
      onSuccess("Private transfer sent.");
      setSendAmount("");
      setSendTo0zk("");
      setPanelView("overview");
      refreshBalances();
    } catch (err) {
      if (err instanceof UserCancelledError) return;
      onError(err instanceof Error ? err.message : "Private send failed.");
    } finally {
      setBusy(false);
      setProving(false);
    }
  }, [activeRow, sendAmount, sendTo0zk, wallet, onError, onSuccess, refreshBalances]);

  const openReceive = useCallback(async () => {
    setPanelView("receive");
    if (!zkAddress) {
      try {
        setZkAddress(await getRailgunAddress());
      } catch {
        /* leave null, shown as unavailable */
      }
    }
  }, [zkAddress]);

  // -------------------------------------------------------------------------
  // Render states

  if (!enabled) {
    return (
      <>
        <div className="rounded-sm border border-punk-purple/40 bg-punk-purple/5 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Private Balance</span>
            <span className="px-1.5 py-0.5 rounded-sm bg-punk-purple/20 text-punk-purple text-[10px] font-bold tracking-wide">
              ALPHA
            </span>
          </div>
          <p className="text-sm text-muted">
            Shield funds into a privacy pool so your balance and transfers are
            hidden on-chain. Powered by the Ethereum Foundation&apos;s Kohaku
            SDKs.
          </p>
          <button
            onClick={() => setShowRiskModal(true)}
            disabled={busy}
            className="w-full py-3 px-6 rounded-sm bg-punk-purple hover:bg-punk-purple/90 transition-all font-medium text-white disabled:opacity-50"
          >
            {busy ? "Enabling…" : "Enable Private Balance"}
          </button>
        </div>
        {showRiskModal && (
          <RiskModal
            onConfirm={handleEnable}
            onCancel={() => setShowRiskModal(false)}
            firstTime={!hasAcknowledgedPrivacyRisk()}
          />
        )}
      </>
    );
  }

  if (unavailable === "locked") {
    return (
      <div className="rounded-sm border border-card-border bg-card-bg p-5 text-sm text-muted">
        Private balance is locked. Re-unlock your wallet to view it.
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="rounded-sm border border-card-border bg-card-bg p-5 text-sm text-muted">
        {unavailable}
      </div>
    );
  }

  if (proving) {
    return (
      <div className="rounded-sm border border-punk-purple/40 bg-punk-purple/5 p-8 text-center space-y-3">
        <div className="mx-auto w-8 h-8 border-2 border-punk-purple border-t-transparent rounded-full animate-spin" />
        <p className="text-sm font-medium">Generating zero-knowledge proof</p>
        <p className="text-xs text-muted">
          This runs on your device and can take up to a minute. Keep the app
          open.
        </p>
      </div>
    );
  }

  if (panelView === "shield") {
    return (
      <ShieldForm
        protocol={shieldProtocol}
        setProtocol={setShieldProtocol}
        tokenRow={activeRow}
        amount={shieldAmount}
        setAmount={setShieldAmount}
        busy={busy}
        onSubmit={handleShield}
        onBack={() => setPanelView("overview")}
      />
    );
  }

  if (panelView === "unshield") {
    return (
      <UnshieldForm
        rows={balances.filter((r) => r.spendable > BigInt(0))}
        activeRow={activeRow}
        setActiveRow={setActiveRow}
        amount={unshieldAmount}
        setAmount={setUnshieldAmount}
        to={unshieldTo}
        setTo={setUnshieldTo}
        ownAddress={wallet.address}
        busy={busy}
        onSubmit={handleUnshield}
        onBack={() => setPanelView("overview")}
      />
    );
  }

  if (panelView === "privateSend") {
    const tokenRows = balances.filter(
      (r) => r.protocol === "railgun" && r.contract && r.spendable > BigInt(0)
    );
    return (
      <div className="rounded-sm border border-card-border bg-card-bg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Private send (Railgun)</h3>
          <button
            onClick={() => setPanelView("overview")}
            className="text-xs text-accent"
          >
            Back
          </button>
        </div>
        {tokenRows.length === 0 ? (
          <p className="text-sm text-muted">
            You need a shielded ERC-20 token balance to send privately. Native
            ETH private transfers are not supported in this version.
          </p>
        ) : (
          <>
            <select
              value={
                activeRow
                  ? `${activeRow.protocol}-${activeRow.contract ?? "native"}`
                  : ""
              }
              onChange={(e) =>
                setActiveRow(
                  tokenRows.find(
                    (r) =>
                      `${r.protocol}-${r.contract ?? "native"}` === e.target.value
                  ) ?? null
                )
              }
              className="w-full p-3 rounded-sm bg-input-bg border border-card-border"
            >
              {tokenRows.map((r) => (
                <option
                  key={`${r.protocol}-${r.contract ?? "native"}`}
                  value={`${r.protocol}-${r.contract ?? "native"}`}
                >
                  {r.symbol} ({formatUnits(r.spendable, r.decimals)})
                </option>
              ))}
            </select>
            <input
              type="text"
              value={sendTo0zk}
              onChange={(e) => setSendTo0zk(e.target.value)}
              placeholder="Recipient 0zk address"
              className="w-full p-3 rounded-sm bg-input-bg border border-card-border font-mono text-sm"
            />
            <input
              type="text"
              inputMode="decimal"
              value={sendAmount}
              onChange={(e) => setSendAmount(e.target.value)}
              placeholder="Amount"
              className="w-full p-3 rounded-sm bg-input-bg border border-card-border font-mono"
            />
            <p className="text-[11px] text-muted">
              Sent privately through a relayer, your public address never
              appears on-chain.
            </p>
            <button
              onClick={handlePrivateSend}
              disabled={busy || !sendAmount || !sendTo0zk}
              className="w-full py-3 rounded-sm bg-punk-purple text-white font-medium disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send privately"}
            </button>
          </>
        )}
      </div>
    );
  }

  if (panelView === "receive") {
    return (
      <div className="rounded-sm border border-card-border bg-card-bg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Private receive address</h3>
          <button
            onClick={() => setPanelView("overview")}
            className="text-xs text-accent"
          >
            Back
          </button>
        </div>
        {zkAddress ? (
          <>
            <div className="bg-white p-4 rounded-sm flex justify-center">
              <QRCodeSVG value={zkAddress} size={180} />
            </div>
            <p className="text-xs font-mono break-all text-muted">{zkAddress}</p>
            <p className="text-xs text-muted">
              This is your Railgun (0zk) address. Funds sent here arrive as
              private balance.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">Loading your private address…</p>
        )}
      </div>
    );
  }

  // Overview
  return (
    <div className="rounded-sm border border-punk-purple/40 bg-punk-purple/5 p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Private Balance</span>
          <span className="px-1.5 py-0.5 rounded-sm bg-punk-purple/20 text-punk-purple text-[10px] font-bold tracking-wide">
            ALPHA
          </span>
        </div>
        <button
          onClick={refreshBalances}
          className="text-xs text-accent hover:text-accent-light"
        >
          Refresh
        </button>
      </div>

      <div className="text-center py-2">
        <div className="text-3xl font-bold tabular-nums">
          {formatUnits(totalSpendable, 18)}
        </div>
        <div className="text-sm text-muted">ETH equivalent, spendable</div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => {
            setActiveRow(null);
            setPanelView("shield");
          }}
          disabled={!ready}
          className="py-3 px-4 rounded-sm bg-punk-purple hover:bg-punk-purple/90 text-white font-medium disabled:opacity-50"
        >
          Shield ↓
        </button>
        <button
          onClick={() => {
            setActiveRow(balances.find((r) => r.spendable > BigInt(0)) ?? null);
            setPanelView("unshield");
          }}
          disabled={!ready || totalSpendable === BigInt(0)}
          className="py-3 px-4 rounded-sm bg-card-border hover:bg-muted/20 font-medium disabled:opacity-50"
        >
          Unshield ↑
        </button>
      </div>
      {isRailgunPrivateSendAvailable() && (
        <button
          onClick={() => {
            setActiveRow(
              balances.find(
                (r) =>
                  r.protocol === "railgun" &&
                  r.contract &&
                  r.spendable > BigInt(0)
              ) ?? null
            );
            setPanelView("privateSend");
          }}
          disabled={!ready}
          className="w-full py-2.5 px-4 rounded-sm bg-punk-purple/80 hover:bg-punk-purple text-white text-sm font-medium disabled:opacity-50"
        >
          Private send (0zk) →
        </button>
      )}
      <button
        onClick={openReceive}
        disabled={!ready}
        className="w-full py-2.5 px-4 rounded-sm border border-punk-purple/40 text-punk-purple text-sm font-medium hover:bg-punk-purple/10 disabled:opacity-50"
      >
        Show private receive address
      </button>

      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted uppercase tracking-wide">
          By protocol
        </h4>
        {loadingBalances ? (
          <p className="text-sm text-muted text-center py-3">Syncing…</p>
        ) : balances.length === 0 ? (
          <p className="text-sm text-muted text-center py-3">
            No private balance yet. Shield funds to get started.
          </p>
        ) : (
          balances.map((row) => (
            <div
              key={`${row.protocol}-${row.contract ?? "native"}`}
              className="flex items-center justify-between p-3 rounded-sm bg-input-bg border border-card-border"
            >
              <div>
                <div className="font-medium text-sm">
                  {PROTOCOL_LABELS[row.protocol]}
                </div>
                <div className="text-xs text-muted">
                  {row.symbol}
                  {row.noteCount !== undefined
                    ? ` · ${row.noteCount} note${row.noteCount === 1 ? "" : "s"}`
                    : ""}
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold tabular-nums text-sm">
                  {formatUnits(row.spendable, row.decimals)}
                </div>
                {row.pending > BigInt(0) && (
                  <div className="text-[11px] text-punk-yellow">
                    +{formatUnits(row.pending, row.decimals)}{" "}
                    {row.pendingLabel ?? "pending"}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {isVerifiedModeConfigured() && network === "mainnet" && (
        <div className="flex items-center justify-between border-t border-card-border pt-3">
          <div className="text-xs">
            <span className="font-medium">⚡ Verified mode</span>
            <span
              className={`ml-2 ${
                verifiedStatus === "synced"
                  ? "text-punk-green"
                  : verifiedStatus === "syncing"
                    ? "text-muted"
                    : verifiedStatus === "unavailable"
                      ? "text-punk-yellow"
                      : "text-muted"
              }`}
            >
              {verifiedStatus === "synced"
                ? "synced ✓"
                : verifiedStatus === "syncing"
                  ? "syncing…"
                  : verifiedStatus === "unavailable"
                    ? "unavailable, using RPC"
                    : "off"}
            </span>
          </div>
          <button
            onClick={() => {
              setVerifiedModeEnabled(!isVerifiedModeEnabled());
              // Re-init picks up the new provider on next unlock/refresh
              onSuccess(
                isVerifiedModeEnabled()
                  ? "Verified mode on. Reopen the wallet to apply."
                  : "Verified mode off."
              );
            }}
            className="text-xs text-accent hover:text-accent-light"
          >
            {isVerifiedModeEnabled() ? "Turn off" : "Turn on"}
          </button>
        </div>
      )}

      <p className="text-[11px] text-muted">
        Unaudited alpha software. Only shield amounts you can afford to lose.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RiskModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  firstTime: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const available = getAvailableProtocols();
  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-end justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-card-bg border-t border-card-border w-full max-w-lg rounded-t-2xl p-6 pb-10 animate-slide-up safe-area-bottom space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">Enable private balance</h3>
        <div className="space-y-3 text-sm text-muted">
          <p>
            Private balances use the Ethereum Foundation&apos;s Kohaku privacy
            SDKs ({available.map((p) => PROTOCOL_LABELS[p]).join(", ")}).
          </p>
          <p className="text-punk-yellow">
            This is unaudited alpha software. Bugs in the SDKs or their smart
            contracts could make shielded funds unrecoverable. Privacy tools
            also carry regulatory uncertainty in some jurisdictions.
          </p>
          <p>
            Your private keys are derived from your passkey, the same as your
            regular wallet, and never leave your device.
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-1"
          />
          <span>
            I understand this is experimental and I could lose the funds I
            shield.
          </span>
        </label>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-3 rounded-sm bg-card-border font-medium"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!confirmed}
            className="flex-1 py-3 rounded-sm bg-punk-purple text-white font-medium disabled:opacity-50"
          >
            Enable
          </button>
        </div>
      </div>
    </div>
  );
}

function ShieldForm({
  protocol,
  setProtocol,
  tokenRow,
  amount,
  setAmount,
  busy,
  onSubmit,
  onBack,
}: {
  protocol: ProtocolId;
  setProtocol: (p: ProtocolId) => void;
  tokenRow: PrivateBalanceRow | null;
  amount: string;
  setAmount: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const available = getAvailableProtocols();
  const asset =
    protocol === "railgun" && tokenRow?.contract ? tokenRow.symbol : "ETH";
  return (
    <div className="rounded-sm border border-card-border bg-card-bg p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Shield into privacy pool</h3>
        <button onClick={onBack} className="text-xs text-accent">
          Back
        </button>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted">Protocol</label>
        {available.map((p) => (
          <button
            key={p}
            onClick={() => setProtocol(p)}
            className={`w-full text-left p-3 rounded-sm border transition-colors ${
              protocol === p
                ? "border-punk-purple bg-punk-purple/10"
                : "border-card-border bg-input-bg hover:border-muted"
            }`}
          >
            <div className="font-medium text-sm">{PROTOCOL_LABELS[p]}</div>
            <div className="text-[11px] text-muted">{PROTOCOL_BLURBS[p]}</div>
          </button>
        ))}
      </div>

      {protocol === "tornado" ? (
        <div className="space-y-2">
          <label className="text-xs text-muted">Denomination (ETH)</label>
          <div className="grid grid-cols-4 gap-2">
            {["0.1", "1", "10", "100"].map((d) => (
              <button
                key={d}
                onClick={() => setAmount(d)}
                className={`py-2 rounded-sm text-sm font-medium border transition-colors ${
                  amount === d
                    ? "border-punk-purple bg-punk-purple/10 text-punk-purple"
                    : "border-card-border bg-input-bg hover:border-muted"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted">
            Tornado uses fixed denominations. Larger, older pools have bigger
            anonymity sets.
          </p>
        </div>
      ) : (
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={`Amount (${asset})`}
          className="w-full p-3 rounded-sm bg-input-bg border border-card-border font-mono"
        />
      )}
      {protocol === "privacy-pools" && (
        <p className="text-[11px] text-muted">
          Deposits must be approved into an association set before they can be
          spent privately. A vetting fee applies.
        </p>
      )}
      <button
        onClick={onSubmit}
        disabled={busy || !amount}
        className="w-full py-3 rounded-sm bg-punk-purple text-white font-medium disabled:opacity-50"
      >
        {busy ? "Shielding…" : "Shield"}
      </button>
    </div>
  );
}

function UnshieldForm({
  rows,
  activeRow,
  setActiveRow,
  amount,
  setAmount,
  to,
  setTo,
  ownAddress,
  busy,
  onSubmit,
  onBack,
}: {
  rows: PrivateBalanceRow[];
  activeRow: PrivateBalanceRow | null;
  setActiveRow: (r: PrivateBalanceRow | null) => void;
  amount: string;
  setAmount: (v: string) => void;
  to: string;
  setTo: (v: string) => void;
  ownAddress: string;
  busy: boolean;
  onSubmit: () => void;
  onBack: () => void;
}) {
  return (
    <div className="rounded-sm border border-card-border bg-card-bg p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Unshield to a public address</h3>
        <button onClick={onBack} className="text-xs text-accent">
          Back
        </button>
      </div>
      {rows.length > 1 && (
        <select
          value={activeRow ? `${activeRow.protocol}-${activeRow.contract ?? "native"}` : ""}
          onChange={(e) =>
            setActiveRow(
              rows.find(
                (r) => `${r.protocol}-${r.contract ?? "native"}` === e.target.value
              ) ?? null
            )
          }
          className="w-full p-3 rounded-sm bg-input-bg border border-card-border"
        >
          {rows.map((r) => (
            <option
              key={`${r.protocol}-${r.contract ?? "native"}`}
              value={`${r.protocol}-${r.contract ?? "native"}`}
            >
              {r.symbol} ({formatUnits(r.spendable, r.decimals)})
            </option>
          ))}
        </select>
      )}
      <input
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder={`Amount (${activeRow?.symbol ?? "ETH"})`}
        className="w-full p-3 rounded-sm bg-input-bg border border-card-border font-mono"
      />
      <input
        type="text"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder={`Destination (default: your wallet ${formatAddress(ownAddress)})`}
        className="w-full p-3 rounded-sm bg-input-bg border border-card-border font-mono text-sm"
      />
      <p className="text-[11px] text-muted">
        Railgun adds a 0.025% unshield fee on top so the recipient receives the
        exact amount. Unshielding to your own address links it to this
        withdrawal on-chain.
      </p>
      <button
        onClick={onSubmit}
        disabled={busy || !amount}
        className="w-full py-3 rounded-sm bg-punk-purple text-white font-medium disabled:opacity-50"
      >
        {busy ? "Working…" : "Unshield"}
      </button>
    </div>
  );
}
