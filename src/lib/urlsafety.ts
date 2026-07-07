// Validation for image URLs that come from untrusted sources: dApp metadata
// icons (WalletConnect), ENS avatar records, and custom-token logos. Only
// https and data:image/* survive - anything else (javascript:, http:, blob:,
// file:, protocol-relative tricks) renders the local fallback instead.

export function safeImageUrl(
  url: string | null | undefined
): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return url;
    if (parsed.protocol === "data:" && /^data:image\//i.test(url)) return url;
    return null;
  } catch {
    // Not an absolute URL. Allow only local asset paths.
    return url.startsWith("/") && !url.startsWith("//") ? url : null;
  }
}
