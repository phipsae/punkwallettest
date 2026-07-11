"use client";

import { useEffect, useRef } from "react";

interface WebQrScannerProps {
  onResult: (text: string) => void;
  onError: (message: string) => void;
}

// Browser camera QR scanner backed by html5-qrcode. Native builds use the
// Capacitor barcode-scanner plugin instead, so this only mounts on web.
export default function WebQrScanner({ onResult, onError }: WebQrScannerProps) {
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  onResultRef.current = onResult;
  onErrorRef.current = onError;

  useEffect(() => {
    let scanner: { stop: () => Promise<void>; clear: () => void } | null = null;
    let unmounted = false;
    let delivered = false;

    (async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (unmounted) return;
        const instance = new Html5Qrcode("web-qr-scanner");
        scanner = instance;
        await instance.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (text) => {
            // html5-qrcode keeps decoding frames until stopped; hand the
            // result to the parent only once
            if (delivered) return;
            delivered = true;
            onResultRef.current(text);
          },
          () => {
            // per-frame decode misses are expected; ignore
          }
        );
        if (unmounted) {
          scanner = null;
          await instance.stop();
          instance.clear();
        }
      } catch (err) {
        if (!unmounted) {
          onErrorRef.current(
            err instanceof Error ? err.message : "Camera unavailable"
          );
        }
      }
    })();

    return () => {
      unmounted = true;
      if (scanner) {
        const s = scanner;
        s.stop()
          .then(() => s.clear())
          .catch(() => {});
      }
    };
  }, []);

  return (
    <div
      id="web-qr-scanner"
      className="w-full max-w-sm overflow-hidden rounded-sm"
    />
  );
}
