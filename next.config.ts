import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for Capacitor iOS/Android builds
  output: 'export',

  // Hide the Next.js dev indicator in bottom-left corner
  devIndicators: false,

  // Empty turbopack config to satisfy Next.js 16 requirement
  turbopack: {},

  webpack: (config, { webpack }) => {
    // Fix for WalletConnect dependencies that use Node.js modules
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      path: false,
      url: false,
      "fs/promises": false,
    };

    // The Railgun package's exports field blocks deep imports, but the
    // browser must pass the wasm asset URL to ensureInitialized explicitly
    // (Next defines `process`, so the SDK would otherwise take its Node
    // fs-loading branch and crash). Alias a virtual specifier to the file.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@kohaku-railgun-wasm": path.join(
        process.cwd(),
        "node_modules/@kohaku-eth/railgun/dist/pkg/index_bg.wasm"
      ),
    };

    // The Kohaku SDKs dynamically import node:fs/promises etc. on their
    // Node-only wasm-loading path (never taken in the browser, where the
    // wasm is passed in explicitly). Strip the node: scheme so the imports
    // resolve into the fallbacks above instead of failing the build.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
        resource.request = resource.request.replace(/^node:/, "");
      })
    );

    // Handle external dependencies
    config.externals.push("pino-pretty", "lokijs", "encoding");

    // Kohaku plugins ship a wasm-bindgen prover loaded via
    // `new URL('index_bg.wasm', import.meta.url)`; the export must emit
    // the .wasm as a static asset for capacitor://localhost to fetch
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };

    return config;
  },
};

export default nextConfig;
