import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Content-Security-Policy, delivered two ways: this meta tag (covers the
// Capacitor build, which serves from capacitor://localhost with no HTTP
// headers) and vercel.json headers for the web (which additionally set
// frame-ancestors - not expressible via meta). Keep both in sync.
//
// Trade-offs, deliberate:
// - script-src 'unsafe-inline': the static export emits build-varying inline
//   bootstrap scripts; per-build hashes would need a post-build injection
//   step (future hardening). The real win here is no remote script origins
//   and no unsafe-eval.
// - connect-src https: wss:: user-added custom RPC URLs are arbitrary, so
//   origins cannot be enumerated. Still blocks http: exfil and downgrades.
// - script-src 'wasm-unsafe-eval': instantiate the Railgun zk-prover
//   WebAssembly.
// - script-src 'unsafe-eval': REQUIRED by the snarkjs/ffjavascript prover
//   used by Privacy Pools, which JITs field arithmetic via `new Function`.
//   This is a real relaxation (it re-enables JS eval). A Railgun-only build
//   (Railgun proves in WASM) could drop it.
const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https: wss:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Punk Wallet | Passkey-Secured Ethereum Wallet",
  description:
    "A self-custodial Ethereum wallet secured by passkeys. No seed phrases, just Face ID or Touch ID.",
  openGraph: {
    title: "Punk Wallet",
    description:
      "Self-custodial Ethereum wallet secured by passkeys. No seed phrases needed.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Punk Wallet - Passkey-secured Ethereum wallet",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Punk Wallet",
    description:
      "Self-custodial Ethereum wallet secured by passkeys. No seed phrases needed.",
    images: ["/og-image.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta httpEquiv="Content-Security-Policy" content={CSP} />
      </head>
      <body
        className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
