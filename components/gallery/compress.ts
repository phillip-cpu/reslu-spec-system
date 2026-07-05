"use client";

/**
 * Client-side image compression via <canvas> — no dependencies
 * (BUILD-SPEC.md §"Phase 11 addition — mobile pass": "compress
 * client-side via canvas to max 2000px before upload (no deps)").
 *
 * On-site phone photos are frequently 4000px+ / several MB each; a
 * multi-select "Upload" of a dozen full-res photos on a job-site
 * mobile connection is slow and wasteful once the gallery only ever
 * displays them at grid-thumbnail or portal-diary size. This resizes
 * the LONGEST edge down to maxDimension (default 2000px, matching the
 * spec exactly) preserving aspect ratio, and re-encodes as JPEG at a
 * reasonable quality — never upscales an already-smaller image.
 *
 * Falls back to returning the ORIGINAL file untouched if anything
 * about the browser canvas/image pipeline fails (e.g. an exotic file
 * type canvas can't decode) — compression is a nice-to-have, never a
 * blocker for getting a site photo uploaded.
 */
export async function compressImage(
  file: File,
  maxDimension = 2000,
  quality = 0.85
): Promise<File> {
  if (!file.type.startsWith("image/")) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const longestEdge = Math.max(width, height);

    if (longestEdge <= maxDimension) {
      bitmap.close?.();
      return file;
    }

    const scale = maxDimension / longestEdge;
    const targetWidth = Math.round(width * scale);
    const targetHeight = Math.round(height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    if (!blob) return file;

    const newName = file.name.replace(/\.\w+$/, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    // Any failure in the decode/draw/encode pipeline — upload the
    // original rather than blocking the on-site workflow.
    return file;
  }
}

/** Compresses a whole FileList/array, sequentially (predictable memory use on phones). */
export async function compressImages(files: File[], maxDimension = 2000): Promise<File[]> {
  const out: File[] = [];
  for (const file of files) {
    out.push(await compressImage(file, maxDimension));
  }
  return out;
}
