import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

function encryptionKey(material = process.env.XERO_TOKEN_ENCRYPTION_KEY): Buffer {
  if (!material) throw new Error("XERO_TOKEN_ENCRYPTION_KEY is not configured");
  const key = Buffer.from(material, "base64");
  if (key.length !== 32) {
    throw new Error("XERO_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function encryptXeroSecret(value: string, keyMaterial?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyMaterial), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptXeroSecret(payload: string, keyMaterial?: string): string {
  const [version, ivPart, tagPart, ciphertextPart] = payload.split(".");
  if (version !== VERSION || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error("Unsupported Xero token ciphertext");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(keyMaterial),
    Buffer.from(ivPart, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
