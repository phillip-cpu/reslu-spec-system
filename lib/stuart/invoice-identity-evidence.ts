import { isValidAustralianAbn, normalizeAustralianAbn } from "./supplier-identity.ts";

const LABELLED_ABN = /\bABN\s*(?::|NO\.?)?\s*([0-9][0-9\s-]{9,20}[0-9])\b/gi;

function normalizedWords(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-AU");
}

export function formatAustralianAbn(value: string): string {
  const digits = normalizeAustralianAbn(value);
  return /^\d{11}$/.test(digits)
    ? `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
    : digits;
}

export function extractVerifiedInvoiceIdentity(evidenceText: string, supplier: string): {
  supplier_name_present: boolean;
  verified_abn_candidates: string[];
} {
  const candidates = [...evidenceText.matchAll(LABELLED_ABN)]
    .map((match) => normalizeAustralianAbn(match[1]))
    .filter((abn) => isValidAustralianAbn(abn));
  return {
    supplier_name_present: normalizedWords(evidenceText).includes(normalizedWords(supplier)),
    verified_abn_candidates: [...new Set(candidates)].map(formatAustralianAbn),
  };
}
