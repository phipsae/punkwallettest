# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` starts the dev server (Turbopack) at http://localhost:3000
- `npm run build` builds the static export (uses webpack, required for the WalletConnect Node-module fallbacks in `next.config.ts`)
- `npm run lint` runs ESLint
- iOS: after `npm run build`, run `npx cap sync ios` to copy the `out/` export into the Capacitor iOS project, then open `ios/App` in Xcode
- `node scripts/generate-icon.js` and `node scripts/generate-og-image.js` regenerate the app icon and OG image

There are no tests.

## Environment

Requires a `.env.local` (gitignored) with:

- `NEXT_PUBLIC_ALCHEMY_API_KEY` (all default RPC URLs are Alchemy endpoints)
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`

Optional (Kohaku privacy features). All `NEXT_PUBLIC_` values are baked into the static export and ship to every client, so only rate-limited/public keys belong here:

- `NEXT_PUBLIC_ENABLE_TESTNETS=true` adds Sepolia to the network list (dev testing of the privacy plugins)
- `NEXT_PUBLIC_PIMLICO_API_KEY` 4337 bundler key for private Railgun transfers (0zk sends)
- `NEXT_PUBLIC_PRIVACY_POOLS_RELAYER_URL` 0xbow relayer for Privacy Pools withdrawals (deposits/balance/ragequit work without it)
- `NEXT_PUBLIC_BEACON_API_URL` Ethereum consensus/beacon endpoint enabling light-client "verified mode" (mainnet only)

## Architecture

Punk Wallet is a self-custodial Ethereum wallet secured by passkeys (no seed phrases). It is a Next.js 16 App Router app configured with `output: 'export'` in `next.config.ts`, so it is a fully static, client-only site. There is no server code, and the same build runs on Vercel (web) and inside a Capacitor shell (iOS). Never add server components, API routes, or anything else that breaks static export.

### UI layer

`src/app/page.tsx` renders `src/components/WalletApp.tsx`, a single ~4700-line client component that owns essentially all app state (~70 useState hooks) and contains every screen and modal (onboarding, send flow, receive, wallet list, settings, network/token management, WalletConnect prompts). New UI features usually go in this file. `PunkAvatar.tsx` deterministically renders a CryptoPunk-style avatar from an address hash. `QRScanner.tsx`/`PaymentScanner.tsx` handle QR scanning, using `@capacitor/barcode-scanner` on native and `html5-qrcode` in the browser (check `Capacitor.isNativePlatform()` for platform branching).

### Core logic in src/lib/

- `passkey.ts` is the security core. Wallet private keys are derived from WebAuthn passkey credentials (SHA-256 of credential data via `@noble/hashes`), so the passkey IS the wallet. Imported private keys are AES-GCM encrypted with a key derived from passkey authentication and stored in localStorage. Includes Mac Catalyst detection workarounds and multi-wallet management.
- `wallet.ts` wraps viem. Defines the seven default networks (Base is the default), custom user-added networks, public/wallet client factories, ETH sends, ENS resolution (always against mainnet), and explorer URLs.
- `tokens.ts` holds per-network ERC-20 token lists plus custom tokens, balance reads, and token transfers.
- `walletconnect.ts` is a singleton around Reown WalletKit for acting as a wallet toward dApps. Contains an IndexedDB availability check that works around an iOS 17 WebView bug.
- `price.ts` fetches ETH/POL prices by reading Uniswap V3 pool ticks on mainnet directly (no external price API), with a 30-second in-memory cache.

### Persistence

Everything persists in localStorage under `punk_wallet_*` keys (wallet list, encrypted keys, credential, custom networks, custom tokens, ENS avatar prefs/cache). There is no backend or database.

### Deployment notes

`vercel.json` sets the Content-Type header for `/.well-known/apple-app-site-association` (iOS universal links / passkey domain association). The passkey rpId logic in `passkey.ts` (`getPasskeyRpId`) ties credentials to the domain, so domain changes break existing passkeys.
