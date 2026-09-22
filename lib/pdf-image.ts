import sharp from "sharp";
import { readFile } from "node:fs/promises";
import path from "node:path";

// 256px at the schedule's 40pt image size is > 450 dpi. Originals remain
// untouched; only this in-memory PDF rendition is resized and compressed.
export const PDF_IMAGE_SIZE = 256;
const MAX_PIXELS = 40_000_000;
let jxlReady: Promise<unknown> | undefined;

function isJxl(bytes: Buffer): boolean {
  return (bytes[0] === 0xff && bytes[1] === 0x0a) ||
    bytes.subarray(0, 12).equals(Buffer.from([0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 13, 10, 0x87, 10]));
}

/** Decode by content, not filename/MIME (some imported images end in .bin).
 * react-pdf supports JPEG/PNG, so never pass browser-only formats through.
 * Supplying bytes also avoids a second, unchecked fetch during rendering.
 */
export async function normalizePdfImage(bytes: Buffer): Promise<string> {
  let source: sharp.Sharp;
  if (isJxl(bytes)) {
    // Prebuilt sharp does not include libjxl. Load just the decoder lazily.
    const { default: decode, init } = await import("@jsquash/jxl/decode.js");
    if (!jxlReady) {
      // Explicitly traced in next.config.ts; require.resolve on a .wasm
      // file makes Turbopack treat the binary as a JavaScript import.
      jxlReady = readFile(path.join(process.cwd(), "node_modules/@jsquash/jxl/codec/dec/jxl_dec.wasm"))
        .then((wasmBinary) => init({ wasmBinary }))
        .catch((error) => { jxlReady = undefined; throw error; });
    }
    await jxlReady;
    const decoded = await decode(Uint8Array.from(bytes).buffer);
    if (decoded.width * decoded.height > MAX_PIXELS) throw new Error("Image dimensions too large");
    source = sharp(Buffer.from(decoded.data), {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
      limitInputPixels: MAX_PIXELS,
    });
  } else {
    // Default page=0 intentionally turns animated GIF/WebP into a still.
    source = sharp(bytes, { limitInputPixels: MAX_PIXELS });
  }
  const jpeg = await source
    .rotate()
    .resize(PDF_IMAGE_SIZE, PDF_IMAGE_SIZE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#EDE8DE" })
    .jpeg({ quality: 82, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/** Failed selected images must be retried on the next export, not cached. */
export function hasMissingPdfImages(
  items: { id: string; selected_image_url: string | null }[],
  images: Map<string, string | undefined>
): boolean {
  return items.some((item) => !!item.selected_image_url && !images.get(item.id));
}
