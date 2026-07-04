import dns from "node:dns/promises";
import net from "node:net";

/**
 * SSRF guard for the product-page scraper (BUILD-SPEC.md §Security:
 * "Scrape route: http/https only, resolve + block private/link-local
 * IPs, cap redirects and response size").
 *
 * This is deliberately its own module under lib/scraper/ (rather than
 * reusing lib/safe-fetch.ts, which is outside this feature's file
 * boundary and used elsewhere in the app) but mirrors the same
 * hardening approach: scheme allowlist, DNS-resolve + block private /
 * loopback / link-local / CGNAT / multicast / reserved ranges on
 * every hop (defends against DNS rebinding — a redirect target is
 * re-resolved and re-checked, never trusted from the first check),
 * manual redirect following with a hop cap, a byte cap enforced while
 * streaming (not just trusting content-length), and a request timeout
 * via AbortController.
 */

const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — page scrape (documents use a separate, larger cap)
const TIMEOUT_MS = 5_000;

// A realistic desktop browser UA — many supplier sites block/soft-fail
// on obvious bot/empty user agents.
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class UnsafeUrlError extends Error {}

function ipv4ToLong(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToLong(ip);
  const inRange = (base: string, bits: number) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToLong(base) & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // "this" network
    inRange("10.0.0.0", 8) || // private (10/8)
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback (127/8)
    inRange("169.254.0.0", 16) || // link-local (169.254/16)
    inRange("172.16.0.0", 12) || // private (172.16/12)
    inRange("192.168.0.0", 16) || // private (192.168/16)
    inRange("192.0.0.0", 24) ||
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved
  );
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe80")) return true; // link-local (fe80::/10)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local (fc00::/7)
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4 address too.
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}

async function assertHostAllowed(hostname: string): Promise<void> {
  const literal = net.isIP(hostname);
  if (literal === 4) {
    if (isBlockedIpv4(hostname)) throw new UnsafeUrlError("Blocked IP address");
    return;
  }
  if (literal === 6) {
    if (isBlockedIpv6(hostname)) throw new UnsafeUrlError("Blocked IP address");
    return;
  }

  let results;
  try {
    results = await dns.lookup(hostname, { all: true });
  } catch {
    throw new UnsafeUrlError("Host did not resolve");
  }
  if (results.length === 0) throw new UnsafeUrlError("Host did not resolve");
  for (const { address, family } of results) {
    if (family === 4 && isBlockedIpv4(address)) {
      throw new UnsafeUrlError("Blocked IP address");
    }
    if (family === 6 && isBlockedIpv6(address)) {
      throw new UnsafeUrlError("Blocked IP address");
    }
  }
}

/**
 * Validates a single URL is safe to fetch server-side: http/https only,
 * hostname resolves, and none of its addresses fall in a private /
 * loopback / link-local range. Throws UnsafeUrlError otherwise.
 *
 * Callers that follow redirects MUST call this again for every hop —
 * see fetchSafely() below, which does that for you.
 */
export async function assertSafeUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeUrlError("Only http/https URLs are allowed");
  }
  await assertHostAllowed(parsed.hostname);
  return parsed;
}

export interface FetchSafelyResult {
  bytes: Buffer;
  contentType: string | null;
  finalUrl: string;
}

export interface FetchSafelyOptions {
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  accept?: string;
}

/**
 * Fetches a URL with the full guard applied on every redirect hop
 * (manual redirect following — never let `fetch` auto-follow, since
 * that would skip the re-check), a hard byte cap enforced while
 * streaming, and a request timeout.
 */
export async function fetchSafely(
  rawUrl: string,
  options: FetchSafelyOptions = {}
): Promise<FetchSafelyResult> {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  let url = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = await assertSafeUrl(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Accept:
            options.accept ??
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    // Manual redirect handling — re-validate the target before following.
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop === maxRedirects) throw new UnsafeUrlError("Too many redirects");
      url = new URL(res.headers.get("location")!, url).toString();
      continue;
    }

    if (!res.ok) throw new Error(`Upstream returned ${res.status}`);

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared && declared > maxBytes) {
      throw new Error("Response too large");
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("Empty response body");

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Response too large");
      }
      chunks.push(value);
    }

    return {
      bytes: Buffer.concat(chunks),
      contentType: res.headers.get("content-type"),
      finalUrl: url,
    };
  }

  throw new UnsafeUrlError("Too many redirects");
}

export const SCRAPE_MAX_BYTES = MAX_BYTES;
export const SCRAPE_MAX_REDIRECTS = MAX_REDIRECTS;
export const SCRAPE_TIMEOUT_MS = TIMEOUT_MS;
