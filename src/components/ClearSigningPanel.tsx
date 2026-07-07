"use client";

import type {
  ClearSigningEntry,
  ClearSigningResult,
} from "@/lib/clearsigning";

// Human-readable (ERC-7730) breakdown of a WalletConnect request,
// shown above the raw details in the session request modal

const FALLBACK_REASON_TEXT: Record<string, string> = {
  descriptorNotFound:
    "No ERC-7730 descriptor exists for this contract, so the transaction could not be fully verified.",
  formatNotFound:
    "The contract is known, but this specific call has no display format.",
  nestedCallNotClearSigned:
    "Part of this transaction contains a nested call that could not be decoded.",
  insufficientContext:
    "Some data needed to fully decode this transaction was unavailable.",
};

function EntryList({ entries }: { entries: ClearSigningEntry[] }) {
  return (
    <div className="space-y-1.5">
      {entries.map((entry, i) => {
        if (entry.kind === "item") {
          return (
            <div key={i} className="flex justify-between gap-3 text-sm">
              <span className="text-muted shrink-0">{entry.label}</span>
              <span className="font-mono text-right break-all">
                {entry.value}
              </span>
            </div>
          );
        }
        if (entry.kind === "group") {
          return (
            <div key={i} className="text-sm">
              <div className="text-muted">{entry.label}</div>
              <div className="pl-3 border-l border-card-border mt-1 space-y-1">
                {entry.items.map((item, j) => (
                  <div key={j} className="flex justify-between gap-3">
                    <span className="text-muted shrink-0">{item.label}</span>
                    <span className="font-mono text-right break-all">
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        }
        return (
          <div key={i} className="text-sm">
            <div className="text-muted">
              {entry.label}
              {entry.intent ? ` - ${entry.intent}` : ""}
            </div>
            <div className="pl-3 border-l border-card-border mt-1">
              <EntryList entries={entry.entries} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ClearSigningPanel({
  loading,
  result,
}: {
  loading: boolean;
  result: ClearSigningResult | null;
}) {
  if (loading) {
    return (
      <div className="p-4 rounded-sm bg-input-bg border border-card-border">
        <div className="flex items-center gap-2 text-sm text-muted">
          <span className="w-3 h-3 rounded-full border-2 border-muted border-t-transparent animate-spin" />
          Decoding transaction...
        </div>
      </div>
    );
  }

  if (!result) return null;

  // Nothing to decode for this request type - the raw details suffice
  if (result.status === "notApplicable") return null;

  if (result.status === "webOnly") {
    return (
      <div className="p-3 rounded-sm bg-input-bg border border-card-border text-xs text-muted">
        Human-readable transaction decoding (ERC-7730) is available in the
        Punk Wallet iOS app.
      </div>
    );
  }

  if (result.status === "error") {
    return (
      <div className="p-3 rounded-sm bg-input-bg border border-card-border text-xs text-muted">
        Could not decode this transaction
        {result.errorMessage ? ` (${result.errorMessage})` : ""}. Review the
        raw details below.
      </div>
    );
  }

  const warnings =
    result.diagnostics?.filter((d) => d.severity === "warning") ?? [];

  if (result.status === "clearSigned") {
    return (
      <div className="p-4 rounded-sm bg-accent/5 border border-accent/40 space-y-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-accent mb-1">
            Verified intent
          </div>
          <div className="font-medium">
            {result.interpolatedIntent || result.intent}
          </div>
          {(result.contractName || result.owner) && (
            <div className="text-xs text-muted mt-0.5">
              {[result.contractName, result.owner]
                .filter(Boolean)
                .join(" by ")}
            </div>
          )}
        </div>
        {result.entries && result.entries.length > 0 && (
          <EntryList entries={result.entries} />
        )}
        {warnings.length > 0 && (
          <div className="text-xs text-warning">
            {warnings.map((w) => w.message).join(" ")}
          </div>
        )}
      </div>
    );
  }

  // fallback
  return (
    <div className="p-4 rounded-sm bg-warning/5 border border-warning/40 space-y-2">
      <div className="text-xs uppercase tracking-wide text-warning">
        Could not fully verify
      </div>
      <div className="text-sm text-muted">
        {(result.fallbackReason && FALLBACK_REASON_TEXT[result.fallbackReason]) ||
          "This transaction could not be fully decoded. Review the raw details below."}
      </div>
      {result.entries && result.entries.length > 0 && (
        <EntryList entries={result.entries} />
      )}
    </div>
  );
}
