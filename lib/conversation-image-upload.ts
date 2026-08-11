const MEBIBYTE = 1024 * 1024;

export const CONVERSATION_IMAGE_OPTIMIZE_THRESHOLD_BYTES = 2 * MEBIBYTE;
export const CONVERSATION_IMAGE_MAX_DIMENSION = 2048;
export const CONVERSATION_IMAGE_QUALITY = 0.82;

const OPTIMIZABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface ConversationImageSource {
  width: number;
  height: number;
  encode: (options: {
    width: number;
    height: number;
    mimeType: string;
    quality: number;
  }) => Promise<Blob | null>;
  dispose?: () => void;
}

export function shouldOptimizeConversationImage(file: Pick<File, "type" | "size">) {
  return OPTIMIZABLE_IMAGE_TYPES.has(file.type)
    && file.size > CONVERSATION_IMAGE_OPTIMIZE_THRESHOLD_BYTES;
}

export function conversationImageUploadDimensions(
  width: number,
  height: number,
  maxDimension = CONVERSATION_IMAGE_MAX_DIMENSION
) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decodeConversationImage(file: File): Promise<ConversationImageSource> {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not prepare this photo"));
      image.src = objectUrl;
    });
  } catch (reason) {
    URL.revokeObjectURL(objectUrl);
    throw reason;
  }

  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    encode: ({ width, height, mimeType, quality }) => new Promise<Blob | null>((resolve) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(null);
        return;
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, width, height);
      canvas.toBlob(resolve, mimeType, mimeType === "image/png" ? undefined : quality);
    }),
    dispose: () => URL.revokeObjectURL(objectUrl),
  };
}

/**
 * Phone camera images are often several megabytes. Resize them before the
 * signed Storage upload so sending a photo feels like messaging, while PDFs
 * and already-small images retain their original bytes.
 */
export async function prepareConversationImageForUpload(
  file: File,
  decode: (file: File) => Promise<ConversationImageSource> = decodeConversationImage
): Promise<File> {
  if (!shouldOptimizeConversationImage(file)) return file;

  let source: ConversationImageSource | null = null;
  try {
    source = await decode(file);
    const dimensions = conversationImageUploadDimensions(source.width, source.height);
    if (!dimensions) return file;
    const blob = await source.encode({
      ...dimensions,
      mimeType: file.type,
      quality: CONVERSATION_IMAGE_QUALITY,
    });
    if (!blob || blob.size <= 0 || blob.type !== file.type || blob.size >= file.size * 0.9) {
      return file;
    }
    return new File([blob], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    });
  } catch {
    // Image preparation is an optimisation. A browser decode failure must not
    // prevent the user from sending the original valid attachment.
    return file;
  } finally {
    source?.dispose?.();
  }
}
