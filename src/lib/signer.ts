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
  unlockCurrentWallet,
  unlockWallet,
  type PublicWalletInfo,
  type StoredWallet,
} from "./passkey";
import { sendETH, type TransactionResult } from "./wallet";
import { sendToken, type Token } from "./tokens";
import { executeSessionRequest, type SessionRequest } from "./walletconnect";

// The minimum a signer call needs to know about the wallet. address is used
// as an integrity check: the ceremony-derived key must match it or the call
// fails loudly before signing anything.
export type SignerTarget = Pick<
  PublicWalletInfo,
  "credentialId" | "address" | "isImported"
>;

// App open / account selection. One ceremony, address verification, no key
// retained. Thin re-exports so the UI has a single auth entry point.
export async function unlockIdentity(): Promise<PublicWalletInfo | null> {
  return unlockCurrentWallet();
}

export async function unlockIdentityFor(
  stored: StoredWallet
): Promise<PublicWalletInfo | null> {
  return unlockWallet(stored);
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
