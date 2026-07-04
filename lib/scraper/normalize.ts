/**
 * Product URL normalisation for duplicate detection (BUILD-SPEC.md
 * §"Library — trade price capture & duplicate detection"):
 * "normalise it (lowercase host, strip query params/fragments/trailing
 * slash) and store product_url_normalized".
 *
 * Used whenever product_url is set/changed on an item or library item,
 * so a later paste of the "same" URL (different query string, trailing
 * slash, protocol, or www.) still matches.
 *
 * Returns null for empty/invalid input — callers should store null in
 * that case, not throw (duplicate detection must never block creation).
 */
export function normalizeProductUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || !rawUrl.trim()) return null;

  let parsed: URL;
  try {
    // Tolerate bare "example.com/product" input by assuming https.
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let path = parsed.pathname.replace(/\/+$/, ""); // strip trailing slash(es)
  if (path === "") path = "/";

  // Deliberately drop query string and fragment — they're the most common
  // source of "different URL, same product" (tracking params, variant
  // selectors that don't change the underlying page, etc.).
  return `${host}${path}`.toLowerCase();
}
