export const BROWSER_IMPORT_VERSION = 1;
export const BROWSER_IMPORT_MAX_DETAILS = 40;
export const BROWSER_IMPORT_MAX_IMAGES = 12;

export type BrowserImportField =
  | "name"
  | "description"
  | "brand"
  | "supplier"
  | "product_url"
  | "price_rrp"
  | "width_mm"
  | "height_mm"
  | "length_mm"
  | "depth_mm"
  | "colour"
  | "material"
  | "finish"
  | "product_details"
  | "image_options";

export const BROWSER_IMPORT_FIELDS: readonly BrowserImportField[] = [
  "name",
  "description",
  "brand",
  "supplier",
  "product_url",
  "price_rrp",
  "width_mm",
  "height_mm",
  "length_mm",
  "depth_mm",
  "colour",
  "material",
  "finish",
  "product_details",
  "image_options",
] as const;

export interface BrowserProductDetail {
  label: string;
  value: string;
}

export interface BrowserProductImportPayload {
  version: 1;
  source: {
    provider: "bunnings";
    pageUrl: string;
    pageKind: "retail" | "trade";
    extractedAt: string;
  };
  context?: {
    projectId?: string;
    projectName?: string;
  };
  product: {
    name?: string | null;
    description?: string | null;
    brand?: string | null;
    supplier?: string | null;
    priceRrp?: number | null;
    widthMm?: number | null;
    heightMm?: number | null;
    lengthMm?: number | null;
    depthMm?: number | null;
    colour?: string | null;
    material?: string | null;
    finish?: string | null;
    details: BrowserProductDetail[];
    images: string[];
  };
}

export type BrowserImportValidation =
  | { ok: true; payload: BrowserProductImportPayload }
  | { ok: false; error: string };

const TEXT_LIMITS = {
  name: 300,
  description: 5000,
  brand: 200,
  supplier: 200,
  colour: 200,
  material: 200,
  finish: 200,
} as const;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, max);
  return cleaned || null;
}

function cleanNumber(value: unknown, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) return null;
  return Math.round(number * 100) / 100;
}

export function isSupportedBrowserImportUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /(^|\.)bunnings\.com\.au$/i.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function cleanImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.toString().slice(0, 2000);
  } catch {
    return null;
  }
}

export function validateBrowserProductImport(
  input: unknown
): BrowserImportValidation {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "The browser import payload is missing." };
  }
  const raw = input as Record<string, unknown>;
  if (raw.version !== BROWSER_IMPORT_VERSION) {
    return { ok: false, error: "This browser import version is not supported." };
  }
  const source = raw.source as Record<string, unknown> | undefined;
  const product = raw.product as Record<string, unknown> | undefined;
  if (!source || !product || !isSupportedBrowserImportUrl(source.pageUrl)) {
    return { ok: false, error: "Only Bunnings retail and trade product pages are supported." };
  }

  const sourceUrl = new URL(source.pageUrl as string);
  sourceUrl.hash = "";
  const pageKind = sourceUrl.hostname.toLowerCase().startsWith("trade.")
    ? "trade"
    : "retail";
  const details = Array.isArray(product.details)
    ? product.details
        .map((entry) => {
          const row = entry as Record<string, unknown>;
          const label = cleanText(row?.label, 120);
          const value = cleanText(row?.value, 1000);
          return label && value ? { label, value } : null;
        })
        .filter((entry): entry is BrowserProductDetail => entry !== null)
        .slice(0, BROWSER_IMPORT_MAX_DETAILS)
    : [];
  const seenDetails = new Set<string>();
  const uniqueDetails = details.filter((entry) => {
    const key = entry.label.toLowerCase();
    if (seenDetails.has(key)) return false;
    seenDetails.add(key);
    return true;
  });
  const images = Array.isArray(product.images)
    ? product.images
        .map(cleanImageUrl)
        .filter((url): url is string => !!url)
        .filter((url, index, all) => all.indexOf(url) === index)
        .slice(0, BROWSER_IMPORT_MAX_IMAGES)
    : [];

  const context = raw.context as Record<string, unknown> | undefined;
  const projectId = cleanText(context?.projectId, 80);
  const projectName = cleanText(context?.projectName, 200);
  const extractedAt = cleanText(source.extractedAt, 50);

  const payload: BrowserProductImportPayload = {
    version: 1,
    source: {
      provider: "bunnings",
      pageUrl: sourceUrl.toString(),
      pageKind,
      extractedAt:
        extractedAt && !Number.isNaN(Date.parse(extractedAt))
          ? new Date(extractedAt).toISOString()
          : new Date().toISOString(),
    },
    ...(projectId || projectName
      ? { context: { projectId: projectId ?? undefined, projectName: projectName ?? undefined } }
      : {}),
    product: {
      name: cleanText(product.name, TEXT_LIMITS.name),
      description: cleanText(product.description, TEXT_LIMITS.description),
      brand: cleanText(product.brand, TEXT_LIMITS.brand),
      supplier: cleanText(product.supplier, TEXT_LIMITS.supplier) ?? "Bunnings",
      priceRrp: cleanNumber(product.priceRrp, 10_000_000),
      widthMm: cleanNumber(product.widthMm, 1_000_000),
      heightMm: cleanNumber(product.heightMm, 1_000_000),
      lengthMm: cleanNumber(product.lengthMm, 1_000_000),
      depthMm: cleanNumber(product.depthMm, 1_000_000),
      colour: cleanText(product.colour, TEXT_LIMITS.colour),
      material: cleanText(product.material, TEXT_LIMITS.material),
      finish: cleanText(product.finish, TEXT_LIMITS.finish),
      details: uniqueDetails,
      images,
    },
  };

  if (!payload.product.name && !payload.product.priceRrp && details.length === 0) {
    return {
      ok: false,
      error: "No usable product information was found on this page.",
    };
  }
  return { ok: true, payload };
}

export function importedFieldValues(payload: BrowserProductImportPayload) {
  return {
    name: payload.product.name,
    description: payload.product.description,
    brand: payload.product.brand,
    supplier: payload.product.supplier,
    product_url: payload.source.pageUrl,
    price_rrp: payload.product.priceRrp,
    width_mm: payload.product.widthMm,
    height_mm: payload.product.heightMm,
    length_mm: payload.product.lengthMm,
    depth_mm: payload.product.depthMm,
    colour: payload.product.colour,
    material: payload.product.material,
    finish: payload.product.finish,
    product_details: payload.product.details,
    image_options: payload.product.images,
  } satisfies Record<BrowserImportField, unknown>;
}
