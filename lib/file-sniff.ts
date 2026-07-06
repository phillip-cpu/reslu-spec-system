import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Magic-byte upload validation — BUILD-SPEC.md §"Phase 14 follow-ups"
 * point 5 (audit backlog, deferred from 14B): "magic-byte upload
 * validation". Every upload route in this app trusts the browser-sent
 * `file.type` (a client-controlled MIME string) to pick a Storage
 * `contentType` and, for images, decide whether the file even qualifies
 * as "an image" — a renamed/relabelled malicious file could otherwise
 * slip past that check. This module sniffs the FIRST FEW BYTES of the
 * actual file content against known file-format signatures instead of
 * trusting the label.
 *
 * Deliberately minimal — only the formats this app actually accepts
 * anywhere (JPEG/PNG/WebP images, PDF documents), not a general-purpose
 * file-type library. No new dependency; a handful of well-known magic
 * numbers checked by hand.
 */

export type SniffedKind = "jpeg" | "png" | "webp" | "pdf" | "unknown";

/**
 * Inspects the leading bytes of a buffer and returns which known format
 * (if any) they match. WebP needs the first 12 bytes (RIFF....WEBP);
 * every other signature needs at most 8.
 */
export function sniffFileKind(bytes: Buffer | Uint8Array): SniffedKind {
  const buf = bytes instanceof Buffer ? bytes : Buffer.from(bytes);

  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "png";
  }

  // WebP: "RIFF" .... "WEBP" (bytes 0-3 = RIFF, 8-11 = WEBP; bytes 4-7
  // are the little-endian chunk size, which varies per file).
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "webp";
  }

  // PDF: "%PDF" — per spec, must appear at the very start of the file
  // (some malformed/edited PDFs have it a few bytes in, but this app
  // only needs to reject obvious mismatches, not accept every
  // technically-valid-but-unusual PDF variant).
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return "pdf";
  }

  return "unknown";
}

const IMAGE_KINDS: SniffedKind[] = ["jpeg", "png", "webp"];

/**
 * True if the sniffed bytes are one of the three image formats this
 * app accepts anywhere (item/project cover images, site photos).
 */
export function isSniffedImage(bytes: Buffer | Uint8Array): boolean {
  return IMAGE_KINDS.includes(sniffFileKind(bytes));
}

/**
 * True if the sniffed bytes are a PDF.
 */
export function isSniffedPdf(bytes: Buffer | Uint8Array): boolean {
  return sniffFileKind(bytes) === "pdf";
}

/**
 * Validates that a claimed content-type ("image/*" or
 * "application/pdf") actually matches the file's real, sniffed bytes.
 * Used by upload routes right after reading the file into a Buffer and
 * before it's written to Storage — rejects a mismatch with a clear
 * error message rather than silently trusting the label.
 *
 * `claimedType` is the browser-supplied `file.type` (or "" if absent —
 * some browsers omit it for certain extensions). Deliberately lenient
 * about the exact claimed subtype (e.g. "image/jpg" vs "image/jpeg")
 * since the whole point of this check is the REAL bytes, not string-
 * matching the label — only the broad claimed category
 * (image vs PDF vs "something else") needs to line up with what was
 * actually sniffed.
 */
export function validateUploadBytes(
  bytes: Buffer | Uint8Array,
  claimedType: string
): { ok: true } | { ok: false; error: string } {
  const sniffed = sniffFileKind(bytes);
  const claimsImage = claimedType.startsWith("image/");
  const claimsPdf = claimedType === "application/pdf";

  if (sniffed === "unknown") {
    // Anything not JPEG/PNG/WebP/PDF is out of scope for this sniffer
    // (e.g. a genuinely different document type this app's upload
    // routes still choose to accept, like a .docx spec sheet) — don't
    // reject something this module simply doesn't recognise.
    return { ok: true };
  }

  if (IMAGE_KINDS.includes(sniffed) && !claimsImage) {
    return {
      ok: false,
      error: `This file's content looks like a ${sniffed.toUpperCase()} image, but it wasn't uploaded as one. Please check the file and try again.`,
    };
  }

  if (sniffed === "pdf" && !claimsPdf) {
    return {
      ok: false,
      error: "This file's content looks like a PDF, but it wasn't uploaded as one. Please check the file and try again.",
    };
  }

  if (claimsImage && !IMAGE_KINDS.includes(sniffed)) {
    return {
      ok: false,
      error: "That doesn't look like a valid JPEG, PNG, or WebP image — the file may be corrupted or mislabelled.",
    };
  }

  if (claimsPdf && sniffed !== "pdf") {
    return {
      ok: false,
      error: "That doesn't look like a valid PDF — the file may be corrupted or mislabelled.",
    };
  }

  return { ok: true };
}

/**
 * Reads just the first 16 bytes of an already-uploaded PRIVATE Storage
 * object, for routes whose upload flow is a signed-upload-URL (browser
 * PUTs bytes straight to Supabase Storage, bypassing this app's
 * server entirely — see app/api/projects/[id]/files/upload-url/
 * route.ts's doc comment) followed by a metadata-only POST. Those
 * routes never see the file bytes directly, so they can't call
 * validateUploadBytes() on a Buffer they already have in memory the
 * way every other upload route here does — this helper mints a short
 * signed URL for the just-uploaded object and issues a single
 * `Range: bytes=0-15` request, which Supabase Storage's object
 * endpoint honours, so the check costs 16 bytes of transfer rather
 * than downloading the whole (possibly large architectural-plan-sized)
 * file just to sniff it.
 *
 * Returns null on any failure (network error, non-206/200 response,
 * range not supported for some reason) — callers should treat null as
 * "couldn't verify" and fail open with a warning-level skip rather than
 * blocking the upload outright, since this is a defence-in-depth check
 * layered on top of the ownership/path-prefix validation those routes
 * already do, not the sole guard.
 */
export async function sniffStorageObjectHead(
  supabase: SupabaseClient,
  bucket: string,
  path: string
): Promise<Buffer | null> {
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60);
    if (error || !data?.signedUrl) return null;

    const res = await fetch(data.signedUrl, { headers: { Range: "bytes=0-15" } });
    if (!res.ok && res.status !== 206) return null;

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}
