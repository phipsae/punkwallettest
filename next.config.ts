import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for Capacitor iOS/Android builds
  output: 'export',

  // Hide the Next.js dev indicator in bottom-left corner
  devIndicators: false,

  // Empty turbopack config to satisfy Next.js 16 requirement
  turbopack: {},

  webpack: (config) => {
    // Fix for WalletConnect dependencies that use Node.js modules
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };

    // Handle external dependencies
    config.externals.push("pino-pretty", "lokijs", "encoding");

    return config;
  },
};

export default nextConfig;
