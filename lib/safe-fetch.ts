import dns from "node:dns/promises";
import net from "node:net";

/**
 * SSRF-hardened fetch for user-supplied URLs (BUILD-SPEC.md §Security:
 * "Scrape route: http/https only, resolve + block private/link-local
 * IPs, cap redirects and response size"). Used for copying a chosen
 * product image into Storage and, later, the scrape route.
 *
 * Guards: scheme allowlist, DNS-resolve every hop and reject private /
 * loopback / link-local / CGNAT / unspecified ranges (defends against
 * DNS rebinding by resolving each redirect target), redirect cap, and a
 * hard byte cap enforced while streaming.
 */

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_REDIRECTS = 3;

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
    inRange("10.0.0.0", 8) || // private
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local
    inRange("172.16.0.0", 12) || // private
    inRange("192.168.0.0", 16) || // private
    inRange("192.0.0.0", 24) ||
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved
  );
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd"))
    return true;
  // IPv4-mapped (::ffff:a.b.c.d)
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}

async function assertHostAllowed(hostname: string): Promise<void> {
  // If it's already a literal IP, check directly.
  const literal = net.isIP(hostname);
  if (literal === 4 && isBlockedIpv4(hostname)) throw new Error("Blocked IP");
  if (literal === 6 && isBlockedIpv6(hostname)) throw new Error("Blocked IP");
  if (literal) return;

  const results = await dns.lookup(hostname, { all: true });
  if (results.length === 0) throw new Error("Host did not resolve");
  for (const { address, family } of results) {
    if (family === 4 && isBlockedIpv4(address)) throw new Error("Blocked IP");
    if (family === 6 && isBlockedIpv6(address)) throw new Error("Blocked IP");
  }
}

export interface SafeFetchResult {
  bytes: Buffer;
  contentType: string | null;
}

export async function safeFetch(
  rawUrl: string,
  {
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    accept,
  }: { maxBytes?: number; maxRedirects?: number; accept?: string } = {}
): Promise<SafeFetchResult> {
  let url = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http/https URLs are allowed");
    }

    await assertHostAllowed(parsed.hostname);

    const res = await fetch(url, {
      redirect: "manual",
      headers: accept ? { accept } : undefined,
      signal: AbortSignal.timeout(10_000),
    });

    // Follow redirects manually so each hop is re-validated.
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop === maxRedirects) throw new Error("Too many redirects");
      url = new URL(res.headers.get("location")!, url).toString();
      continue;
    }

    if (!res.ok) throw new Error(`Upstream returned ${res.status}`);

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared && declared > maxBytes) throw new Error("Response too large");

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
    };
  }

  throw new Error("Too many redirects");
}
