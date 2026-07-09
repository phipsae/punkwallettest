// The signer boundary. Every function here that touches key material runs
// its own passkey ceremony (strict per-action approval, no reuse window),
// derives/decrypts the key inside function scope, signs or executes exactly
// one request, and lets the key go out of scope. The UI receives only
// signatures, transaction results, addresses, or public wallet info.
//
// exportPrivateKey is the single sanctioned exception - it returns key
// material and exists only for the export screen.
//
// This module is the only allowed importer of unsafeWithSessionKey
// (enforced via no-restricted-imports in eslint.config.mjs).

import { privateKeyToAccount } from "viem/accounts";
import {
  unsafeWithSessionKey,
  unsafeWithSessionSecrets,
  unlockCurrentWallet,
  unlockWallet,
  type PublicWalletInfo,
  type StoredWallet,
} from "./passkey";
import { sendETH, sendRawTx, type TransactionResult } from "./wallet";
import { sendToken, type Token } from "./tokens";
import { executeSessionRequest, type SessionRequest } from "./walletconnect";
import { setKohakuSession, isPrivacyEnabled } from "./kohakuSession";

// The minimum a signer call needs to know about the wallet. address is used
// as an integrity check: the ceremony-derived key must match it or the call
// fails loudly before signing anything.
export type SignerTarget = Pick<
  PublicWalletInfo,
  "credentialId" | "address" | "isImported"
>;

// App open / account selection. One ceremony, address verification, no key
// retained. When the wallet has Kohaku privacy enabled, the same ceremony
// derives the privacy root and installs it into the session module, so
// enabled users pay zero extra biometric prompts.
export async function unlockIdentity(): Promise<PublicWalletInfo | null> {
  const stored = localStorage.getItem("punk_wallet_credential");
  const credentialId = stored
    ? (JSON.parse(stored) as { credentialId?: string }).credentialId
    : undefined;
  const wantsPrivacy = credentialId ? isPrivacyEnabled(credentialId) : false;
  return unlockCurrentWallet(
    wantsPrivacy && credentialId
      ? { onKohakuRoot: (root) => setKohakuSession(credentialId, root) }
      : undefined
  );
}

export async function unlockIdentityFor(
  stored: StoredWallet
): Promise<PublicWalletInfo | null> {
  const wantsPrivacy = isPrivacyEnabled(stored.credentialId);
  return unlockWallet(
    stored,
    wantsPrivacy
      ? {
          onKohakuRoot: (root) => setKohakuSession(stored.credentialId, root),
        }
      : undefined
  );
}

// First-time privacy opt-in mid-session: one dedicated ceremony that derives
// the Kohaku root and installs it. The caller flips the per-protocol enabled
// flag after this succeeds.
export async function enableKohakuPrivacy(
  wallet: SignerTarget
): Promise<void> {
  await unsafeWithSessionSecrets(wallet, async (key) => {
    setKohakuSession(wallet.credentialId, key.deriveKohakuRoot());
  });
}

// Send a raw prepared transaction (approve / shield / self-broadcast of a
// proved private operation). Fresh passkey prompt per call, same policy as
// every other signing action.
export async function signAndSendTransaction(args: {
  wallet: SignerTarget;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  networkId: string;
  waitForReceipt?: boolean;
}): Promise<TransactionResult> {
  return unsafeWithSessionKey(args.wallet, async (privateKey) => {
    const account = privateKeyToAccount(privateKey);
    return sendRawTx(
      account,
      { to: args.to, data: args.data, value: args.value },
      args.networkId,
      { waitForReceipt: args.waitForReceipt }
    );
  });
}

// Send native ETH. Fresh passkey prompt per call.
export async function signAndSendEth(args: {
  wallet: SignerTarget;
  to: `0x${string}`;
  amountEth: string;
  networkId: string;
}): Promise<TransactionResult> {
  return unsafeWithSessionKey(args.wallet, async (privateKey) => {
    const account = privateKeyToAccount(privateKey);
    return sendETH(account, args.to, args.amountEth, args.networkId);
  });
}

// Send an ERC-20 token. Fresh passkey prompt per call.
export async function signAndSendToken(args: {
  wallet: SignerTarget;
  token: Token;
  to: `0x${string}`;
  amount: string;
  networkId: string;
}): Promise<{ hash: `0x${string}`; success: boolean; error?: string }> {
  return unsafeWithSessionKey(args.wallet, async (privateKey) => {
    const account = privateKeyToAccount(privateKey);
    return sendToken(account, args.token, args.to, args.amount, args.networkId);
  });
}

// Approve a WalletConnect session request: fresh passkey prompt, then sign/
// execute and respond to the dApp. Throws UserCancelledError (no response
// sent) when the prompt is dismissed; rethrows signing errors after they
// have been responded to the dApp.
export async function approveWalletConnectRequest(
  wallet: SignerTarget,
  request: SessionRequest
): Promise<string> {
  return unsafeWithSessionKey(wallet, async (privateKey) => {
    const account = privateKeyToAccount(privateKey);
    return executeSessionRequest(request, account);
  });
}

// THE ONLY FUNCTION IN THE APP THAT RETURNS KEY MATERIAL. Used exclusively by
// the export screen, which must keep the value in short-lived state and wipe
// it on hide, view exit, timeout, and backgrounding. Fresh prompt per call.
export async function exportPrivateKey(
  wallet: SignerTarget
): Promise<`0x${string}`> {
  return unsafeWithSessionKey(wallet, async (privateKey) => privateKey);
}
