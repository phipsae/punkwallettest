"use client";

// TEMP Phase-0 smoke check: force the Kohaku wasm into the client bundle
// graph and prove it instantiates under the production CSP
export default function KohakuSmoke() {
  if (typeof window !== "undefined" && window.location.hash === "#__kohaku_smoke__") {
    import("@kohaku-eth/railgun")
      .then(async (m) => {
        console.log("kohaku railgun module loaded", Object.keys(m).length);
        const wasmUrl = new URL("@kohaku-railgun-wasm", import.meta.url);
        await m.ensureInitialized(await fetch(wasmUrl), "Off");
        const cfg = m.chainConfig(BigInt(1));
        console.log("kohaku wasm initialized, mainnet config:", cfg ? "ok" : "missing");
      })
      .catch((e) => console.log("kohaku smoke FAILED:", e?.message ?? e));
  }
  return null;
}
