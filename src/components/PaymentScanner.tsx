"use client";

import { useEffect, useState, useCallback } from "react";
import { Capacitor } from "@capacitor/core";

interface PaymentScannerProps {
  onScan: (address: string, amount?: string, tokenAddress?: string) => void;
  onClose: () => void;
}

// Parse EIP-681 payment URI
// ETH format: ethereum:address[@chainId]?value=amountInWei
// ERC-20 format: ethereum:tokenAddress[@chainId]/transfer?address=recipient&uint256=amount
function parsePaymentUri(
  uri: string
): { address: string; amount?: string; tokenAddress?: string } | null {
  // Plain address
  if (/^0x[a-fA-F0-9]{40}$/.test(uri)) {
    return { address: uri };
  }

  // ethereum: URI
  if (!uri.startsWith("ethereum:")) {
    return null;
  }

  try {
    // Remove the ethereum: prefix
    const rest = uri.slice(9);

    // Check if it's an ERC-20 transfer (contains /transfer)
    if (rest.includes("/transfer")) {
      // ERC-20 format: tokenAddress@chainId/transfer?address=recipient&uint256=amount
      const [pathPart, paramsPart] = rest.split("?");
      const [addressChainPart] = pathPart.split("/transfer");
      const [tokenAddress] = addressChainPart.split("@");

      if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
        return null;
      }

      const params = new URLSearchParams(paramsPart || "");
      const recipientAddress = params.get("address");
      const amount = params.get("uint256");

      if (!recipientAddress || !/^0x[a-fA-F0-9]{40}$/.test(recipientAddress)) {
        return null;
      }

      const result: {
        address: string;
        amount?: string;
        tokenAddress?: string;
      } = {
        address: recipientAddress,
        tokenAddress: tokenAddress,
      };

      if (amount) {
        // Return raw amount - the receiver will need to know the token decimals
        result.amount = amount;
      }

      return result;
    } else {
      // ETH format: address@chainId?value=amountInWei
      const [addressPart, paramsPart] = rest.split("?");
      const [address] = addressPart.split("@");

      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return null;
      }

      const result: { address: string; amount?: string } = { address };

      if (paramsPart) {
        const params = new URLSearchParams(paramsPart);
        const value = params.get("value");

        if (value) {
          // Convert wei to ETH
          try {
            const weiValue = BigInt(value);
            const ethValue = Number(weiValue) / 1e18;
            result.amount = ethValue.toString();
          } catch {
            // If parsing fails, ignore the amount
          }
        }
      }

      return result;
    }
  } catch {
    return null;
  }
}

export default function PaymentScanner({
  onScan,
  onClose,
}: PaymentScannerProps) {
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // Start the scanner
  const startScanner = useCallback(async () => {
    setScanning(true);
    setError(null);

    try {
      const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } =
        await import("@capacitor/barcode-scanner");

      console.log(
        "Starting payment scanner, platform:",
        Capacitor.getPlatform()
      );

      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: "Point at a payment QR code",
        scanButton: false,
        cameraDirection: 1, // BACK camera
      });

      console.log("Scan result:", result);

      if (result.ScanResult) {
        const parsed = parsePaymentUri(result.ScanResult);
        if (parsed) {
          onScan(parsed.address, parsed.amount, parsed.tokenAddress);
        } else {
          setError("Invalid payment QR code. Expected an Ethereum address.");
          setScanning(false);
        }
      } else {
        // Scan was cancelled
        onClose();
      }
    } catch (err) {
      console.error("Scanner error:", err);
      setError(err instanceof Error ? err.message : "Failed to scan");
      setScanning(false);
    }
  }, [onScan, onClose]);

  // Start scanning on mount
  useEffect(() => {
    startScanner();
  }, [startScanner]);

  const handleClose = () => {
    onClose();
  };

  const handleRetry = () => {
    setError(null);
    startScanner();
  };

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col safe-area-all">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-card-border">
        <h2 className="text-lg font-semibold">Scan Payment QR</h2>
        <button
          onClick={handleClose}
          className="p-2 rounded-sm hover:bg-card-border transition-colors"
        >
          <svg
            className="w-6 h-6"
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

      {/* Scanner area */}
      <div className="flex-1 flex flex-col items-center justify-center p-4">
        {error ? (
          <div className="text-center space-y-4 p-6">
            <div className="w-16 h-16 mx-auto rounded-full bg-error/20 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-error"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <p className="text-error font-medium">{error}</p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={handleClose}
                className="px-6 py-3 bg-card-border hover:bg-muted/20 rounded-sm transition-colors"
              >
                Go Back
              </button>
              <button
                onClick={handleRetry}
                className="px-6 py-3 bg-accent hover:bg-accent-dark text-background rounded-sm transition-colors font-medium"
              >
                Try Again
              </button>
            </div>
          </div>
        ) : scanning ? (
          <div className="text-center space-y-4">
            <div className="w-16 h-16 mx-auto rounded-full bg-accent/20 flex items-center justify-center animate-pulse">
              <svg
                className="w-8 h-8 text-accent"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
                />
              </svg>
            </div>
            <p className="text-muted">Opening camera...</p>
            <p className="text-xs text-muted">
              Point your camera at a payment QR code
            </p>
          </div>
        ) : null}
      </div>

      {/* Footer hint */}
      <div className="p-4 border-t border-card-border text-center">
        <p className="text-xs text-muted">
          Scan an Ethereum address or payment request QR code
        </p>
      </div>
    </div>
  );
}
