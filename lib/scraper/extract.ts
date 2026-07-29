/**
 * HTML extraction for the product-page scraper. No HTML-parsing
 * dependency is available in this project (no npm registry access to
 * add one), so this is deliberately careful regex/string parsing —
 * good enough for the well-known patterns (JSON-LD, OpenGraph) and a
 * conservative fallback for everything else. Never throws — every
 * function here degrades to an empty/partial result on malformed input,
 * because a scrape failure must never block item creation
 * (BUILD-SPEC.md: "fetch-first scraping, never block item creation").
 */

export type GuessedDocKind = "spec_sheet" | "install_manual" | "other";

export interface DetectedDocument {
  url: string;
  guessedKind: GuessedDocKind;
  label: string;
}

export interface ExtractedProductDetail {
  label: string;
  value: string;
}

/**
 * Dimensions in millimetres, best-effort-extracted (BUILD-SPEC.md
 * "Dimension extraction (best-effort)"). Any subset may be present —
 * suppliers rarely publish all four in the same place. Sanity-bounded
 * 10–10000mm at the point of extraction (DIM_MIN/DIM_MAX below) so an
 * obviously-wrong parse (a price accidentally matched as a dimension,
 * a "1200x800px" image-size string) never reaches the item row.
 */
export interface ExtractedDimensions {
  width_mm?: number;
  height_mm?: number;
  length_mm?: number;
  depth_mm?: number;
}

export interface ExtractResult {
  price: number | null;
  priceConfidence: "high" | "medium" | "low" | "none";
  images: string[];
  documents: DetectedDocument[];
  dimensions: ExtractedDimensions;
  title: string | null;
  description: string | null;
  brand: string | null;
  details: ExtractedProductDetail[];
}

const MIN_PRICE = 1;
const MAX_PRICE = 500_000;
const MAX_IMAGES = 12;
const MAX_DETAILS = 30;

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
}

function cleanText(value: unknown): string | null {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return null;
  }
  const cleaned = decodeHtml(String(value))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function dedupeDetails(details: ExtractedProductDetail[]): ExtractedProductDetail[] {
  const seen = new Set<string>();
  const result: ExtractedProductDetail[] = [];
  for (const detail of details) {
    const label = cleanText(detail.label);
    const value = cleanText(detail.value);
    if (!label || !value) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ label, value });
    if (result.length >= MAX_DETAILS) break;
  }
  return result;
}

// ------------------------------------------------------------
// Dimension extraction (best-effort)
// BUILD-SPEC.md "Dimension extraction (best-effort)": try (a) JSON-LD
// Product width/height/depth properties, (b) spec-table/text patterns
// like "Width 895 mm", "W x H x D: 895 x 455 x 560mm", "Dimensions
// (WxHxD)". Unit handling: cm -> x10, m -> x1000, mm -> x1 (bare
// numbers with no unit are assumed mm, the schema's native unit).
// ------------------------------------------------------------

const DIM_MIN = 10;
const DIM_MAX = 10000;

/** Converts a captured number + unit token to millimetres; null if the unit is unrecognised or the result is out of sane range. */
function toMm(value: number, unit: string | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  const u = (unit ?? "mm").toLowerCase();
  let mm: number;
  if (u === "mm") mm = value;
  else if (u === "cm") mm = value * 10;
  else if (u === "m") mm = value * 1000;
  else return null;
  if (mm < DIM_MIN || mm > DIM_MAX) return null;
  return Math.round(mm * 100) / 100;
}

interface JsonLdQuantitativeValue {
  "@type"?: string;
  value?: string | number;
  unitCode?: string; // schema.org uses UN/CEFACT codes: MMT, CMT, MTR
  unitText?: string;
}
interface JsonLdProductWithDimensions extends JsonLdProduct {
  width?: string | number | JsonLdQuantitativeValue;
  height?: string | number | JsonLdQuantitativeValue;
  depth?: string | number | JsonLdQuantitativeValue;
}

const UNIT_CODE_TO_UNIT: Record<string, string> = {
  MMT: "mm",
  CMT: "cm",
  MTR: "m",
};

/** Reads a schema.org QuantitativeValue (or bare number/string) property into a millimetre value. */
function jsonLdDimensionToMm(
  raw: string | number | JsonLdQuantitativeValue | undefined
): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return toMm(raw, "mm");
  if (typeof raw === "string") {
    // Bare string may itself carry a unit suffix, e.g. "895mm" / "89.5cm".
    const m = /^([\d.]+)\s*(mm|cm|m)?$/i.exec(raw.trim());
    if (!m) return null;
    return toMm(Number(m[1]), m[2]);
  }
  const num = typeof raw.value === "number" ? raw.value : Number(raw.value);
  const unit = raw.unitCode ? UNIT_CODE_TO_UNIT[raw.unitCode.toUpperCase()] : raw.unitText;
  return toMm(num, unit);
}

/**
 * (a) JSON-LD Product width/height/depth properties. schema.org has no
 * "length" property for Product — a supplier publishing a length
 * figure almost always does so as free text instead, which the (b)
 * fallback below picks up via the WxHxD-style patterns.
 */
function dimensionsFromJsonLd(products: JsonLdProduct[]): ExtractedDimensions {
  const out: ExtractedDimensions = {};
  for (const p of products) {
    const withDims = p as JsonLdProductWithDimensions;
    if (out.width_mm === undefined) {
      const mm = jsonLdDimensionToMm(withDims.width);
      if (mm !== null) out.width_mm = mm;
    }
    if (out.height_mm === undefined) {
      const mm = jsonLdDimensionToMm(withDims.height);
      if (mm !== null) out.height_mm = mm;
    }
    if (out.depth_mm === undefined) {
      const mm = jsonLdDimensionToMm(withDims.depth);
      if (mm !== null) out.depth_mm = mm;
    }
  }
  return out;
}

/**
 * (b) Spec-table/text patterns on the visible page text, e.g.
 *   "Width 895 mm" / "Height: 455mm" / "Depth 560 mm"
 *   "W x H x D: 895 x 455 x 560mm" / "Dimensions (WxHxD): 895 x 455 x 560 mm"
 * Both single-labelled lines and the combined "W x H x D" triple are
 * tried; the combined pattern only fills whichever of width/height/
 * length/depth aren't already set from JSON-LD or an earlier match in
 * this same fallback, so the two sources merge rather than one
 * clobbering the other.
 */
function dimensionsFromText(html: string): ExtractedDimensions {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&");

  const out: ExtractedDimensions = {};
  const numberUnit = String.raw`([\d.]+)\s*(mm|cm|m)?\b`;

  // Single-labelled lines: "Width 895 mm", "Height: 455mm", etc.
  const singlePatterns: { field: keyof ExtractedDimensions; re: RegExp }[] = [
    { field: "width_mm", re: new RegExp(String.raw`\bwidth\b\s*[:\-]?\s*${numberUnit}`, "i") },
    { field: "height_mm", re: new RegExp(String.raw`\bheight\b\s*[:\-]?\s*${numberUnit}`, "i") },
    { field: "length_mm", re: new RegExp(String.raw`\blength\b\s*[:\-]?\s*${numberUnit}`, "i") },
    { field: "depth_mm", re: new RegExp(String.raw`\bdepth\b\s*[:\-]?\s*${numberUnit}`, "i") },
  ];
  for (const { field, re } of singlePatterns) {
    const m = re.exec(text);
    if (!m) continue;
    const mm = toMm(Number(m[1]), m[2]);
    if (mm !== null) out[field] = mm;
  }

  // Combined "W x H x D: 895 x 455 x 560mm" / "Dimensions (WxHxD): 895 x 455 x 560 mm"
  // — a single trailing unit applies to all three captured numbers.
  const combinedRe = new RegExp(
    String.raw`(?:w\s*x\s*h\s*x\s*d|dimensions?\s*\(?w\s*x\s*h\s*x\s*d\)?)\s*[:\-]?\s*` +
      String.raw`([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)\s*(mm|cm|m)?\b`,
    "i"
  );
  const combined = combinedRe.exec(text);
  if (combined) {
    const unit = combined[4];
    const w = toMm(Number(combined[1]), unit);
    const h = toMm(Number(combined[2]), unit);
    const d = toMm(Number(combined[3]), unit);
    if (out.width_mm === undefined && w !== null) out.width_mm = w;
    if (out.height_mm === undefined && h !== null) out.height_mm = h;
    if (out.depth_mm === undefined && d !== null) out.depth_mm = d;
  }

  // Timber and sheet-goods titles commonly use a mixed-unit form:
  // "90 x 45mm 5.4m". The final value is a length in metres, not
  // 5.4 millimetres. Keeping this as a dedicated pattern avoids the
  // unit ambiguity that caused the 5.4m LVL in the register to show
  // as a length of 5.4mm.
  const mixedTimber = /\b([\d.]+)\s*x\s*([\d.]+)\s*mm\s*(?:x\s*)?([\d.]+)\s*m\b/i.exec(text);
  if (mixedTimber) {
    const w = toMm(Number(mixedTimber[1]), "mm");
    const h = toMm(Number(mixedTimber[2]), "mm");
    const l = toMm(Number(mixedTimber[3]), "m");
    if (out.width_mm === undefined && w !== null) out.width_mm = w;
    if (out.height_mm === undefined && h !== null) out.height_mm = h;
    if (out.length_mm === undefined && l !== null) out.length_mm = l;
  }

  return out;
}

/** Merges dimension sources, JSON-LD taking priority per-field over the text fallback. */
function mergeDimensions(primary: ExtractedDimensions, fallback: ExtractedDimensions): ExtractedDimensions {
  return {
    width_mm: primary.width_mm ?? fallback.width_mm,
    height_mm: primary.height_mm ?? fallback.height_mm,
    length_mm: primary.length_mm ?? fallback.length_mm,
    depth_mm: primary.depth_mm ?? fallback.depth_mm,
  };
}

// ------------------------------------------------------------
// JSON-LD (highest priority)
// ------------------------------------------------------------

interface JsonLdOffer {
  price?: string | number;
  priceCurrency?: string;
}
interface JsonLdPropertyValue {
  name?: string;
  value?: string | number | boolean;
}
interface JsonLdProduct {
  "@type"?: string | string[];
  name?: string;
  description?: string;
  brand?: string | { name?: string };
  image?: string | string[] | { url?: string };
  offers?: JsonLdOffer | JsonLdOffer[];
  additionalProperty?: JsonLdPropertyValue | JsonLdPropertyValue[];
}

function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch {
      // Malformed JSON-LD is common in the wild (trailing commas, HTML
      // comments inside the script tag). Skip rather than throw.
      continue;
    }
  }
  return blocks;
}

function isProductType(node: unknown): node is JsonLdProduct {
  if (!node || typeof node !== "object") return false;
  const t = (node as JsonLdProduct)["@type"];
  if (!t) return false;
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === "string" && x.toLowerCase() === "product");
}

/** Recursively walk JSON-LD (handles @graph wrappers) looking for Product nodes. */
function findProductNodes(node: unknown, out: JsonLdProduct[]): void {
  if (!node || typeof node !== "object") return;
  if (isProductType(node)) out.push(node as JsonLdProduct);
  const graph = (node as { "@graph"?: unknown[] })["@graph"];
  if (Array.isArray(graph)) {
    for (const child of graph) findProductNodes(child, out);
  }
}

function priceFromJsonLd(products: JsonLdProduct[]): number | null {
  for (const p of products) {
    const offers = p.offers;
    const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
    for (const offer of list) {
      const raw = offer.price;
      if (raw === undefined || raw === null) continue;
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n) && n >= MIN_PRICE && n <= MAX_PRICE) return n;
    }
  }
  return null;
}

function imagesFromJsonLd(products: JsonLdProduct[]): string[] {
  const out: string[] = [];
  for (const p of products) {
    const img = p.image;
    if (!img) continue;
    if (typeof img === "string") out.push(img);
    else if (Array.isArray(img)) {
      for (const i of img) if (typeof i === "string") out.push(i);
    } else if (typeof img === "object" && typeof img.url === "string") {
      out.push(img.url);
    }
  }
  return out;
}

function contentFromJsonLd(products: JsonLdProduct[]): {
  title: string | null;
  description: string | null;
  brand: string | null;
  details: ExtractedProductDetail[];
} {
  let title: string | null = null;
  let description: string | null = null;
  let brand: string | null = null;
  const details: ExtractedProductDetail[] = [];

  for (const product of products) {
    title ??= cleanText(product.name);
    description ??= cleanText(product.description);
    brand ??=
      typeof product.brand === "string"
        ? cleanText(product.brand)
        : cleanText(product.brand?.name);

    const properties = Array.isArray(product.additionalProperty)
      ? product.additionalProperty
      : product.additionalProperty
        ? [product.additionalProperty]
        : [];
    for (const property of properties) {
      if (property.name && property.value !== undefined) {
        details.push({ label: property.name, value: String(property.value) });
      }
    }
  }

  return { title, description, brand, details: dedupeDetails(details) };
}

// ------------------------------------------------------------
// OpenGraph / meta tags (second priority)
// ------------------------------------------------------------

function metaContent(html: string, propertyOrName: string): string[] {
  const out: string[] = [];
  // Match <meta property="og:image" content="..."> in either attribute order.
  const patterns = [
    new RegExp(
      `<meta[^>]*(?:property|name)=["']${propertyOrName}["'][^>]*content=["']([^"']+)["'][^>]*>`,
      "gi"
    ),
    new RegExp(
      `<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${propertyOrName}["'][^>]*>`,
      "gi"
    ),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      if (m[1]) out.push(m[1]);
    }
  }
  return out;
}

function priceFromMeta(html: string): number | null {
  const candidates = [
    ...metaContent(html, "product:price:amount"),
    ...metaContent(html, "og:price:amount"),
  ];
  for (const raw of candidates) {
    const n = Number(raw.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n >= MIN_PRICE && n <= MAX_PRICE) return n;
  }
  return null;
}

function imagesFromMeta(html: string): string[] {
  return metaContent(html, "og:image");
}

// Conservative specification-table fallback for suppliers that do not
// publish JSON-LD additionalProperty. Only recognised product-spec
// labels are accepted so delivery tables, navigation and account data
// do not leak into the item record.
const PRODUCT_DETAIL_LABEL_RE =
  /\b(model|sku|item|product|colour|color|finish|material|dimension|width|height|length|depth|weight|capacity|warranty|pressure|flow|rating|grade|size|style|type|mount|installation|power|voltage|energy|composition|treatment)\b/i;

function detailsFromHtml(html: string): ExtractedProductDetail[] {
  const details: ExtractedProductDetail[] = [];
  const add = (rawLabel: unknown, rawValue: unknown) => {
    const label = cleanText(rawLabel);
    const value = cleanText(rawValue);
    if (
      !label ||
      !value ||
      label.length > 80 ||
      value.length > 600 ||
      !PRODUCT_DETAIL_LABEL_RE.test(label)
    ) {
      return;
    }
    details.push({ label, value });
  };

  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html))) {
    const cells = [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)];
    if (cells.length >= 2) add(cells[0][1], cells[1][1]);
  }

  const definitionRe =
    /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  let definition: RegExpExecArray | null;
  while ((definition = definitionRe.exec(html))) {
    add(definition[1], definition[2]);
  }

  return dedupeDetails(details);
}

// ------------------------------------------------------------
// Fallback: <img> collection + price regex on visible text
// ------------------------------------------------------------

const ICON_KEYWORDS = ["icon", "logo", "sprite", "favicon", "placeholder", "spinner", "loading"];
const ICON_EXTENSIONS = [".svg", ".ico"];

function isLikelyIconOrSprite(url: string): boolean {
  const lower = url.toLowerCase();
  if (ICON_EXTENSIONS.some((ext) => lower.includes(ext))) return true;
  if (ICON_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  return false;
}

// Some sites' own templating concatenates their site origin directly
// onto an already-absolute image URL with no separator (e.g. an
// `og:image` meta tag built as `siteUrl + imageUrl` where `imageUrl` was
// already absolute: "https://site.com" + "https://cdn.example.com/x.png"
// -> "https://site.comhttps://cdn.example.com/x.png"). Left alone,
// `new URL(url, baseUrl)` doesn't throw on that - it silently mangles
// the embedded scheme (drops its ":") instead, producing a well-formed-
// looking but unfetchable URL that saves as a "successful" scrape and
// then just never loads. Detects a scheme immediately preceded by an
// alphanumeric character (true zero-separator concatenation) and
// unwraps to the embedded URL instead. A scheme preceded by a URL
// delimiter instead (a legitimate query-string redirect param like
// "?next=https://...") is left untouched.
const DOUBLED_ORIGIN_RE = /[a-z0-9](https?:\/\/.+)$/i;

function absolutise(url: string, baseUrl: string): string | null {
  try {
    const doubled = DOUBLED_ORIGIN_RE.exec(url);
    const real = doubled ? doubled[1] : url;
    return new URL(real, baseUrl).toString();
  } catch {
    return null;
  }
}

// Many CDNs encode intrinsic dimensions in the URL (Sanity:
// "...-900x900.jpg", Shopify: "_1200x", generic: "?w=3840"). Cheap,
// reliable ranking signal: bigger declared size = more likely the
// actual product photo; tiny = swatch/thumbnail/icon.
function parseUrlDimensions(url: string): { w: number; h: number } | null {
  const m = /(\d{2,4})x(\d{2,4})(?:[^0-9]|$)/.exec(url);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w >= 16 && h >= 16 && w <= 10000 && h <= 10000) return { w, h };
  }
  const wq = /[?&]w(?:idth)?=(\d{2,5})/.exec(url);
  if (wq) {
    const w = Number(wq[1]);
    if (w >= 16 && w <= 10000) return { w, h: w };
  }
  return null;
}

// Next.js <Image> proxies real sources through /_next/image?url=<encoded>.
// Unwrap to the underlying URL so dedupe/ranking sees the real image.
function unwrapNextImageProxy(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname.endsWith("/_next/image") || u.pathname === "/_next/image") {
      const inner = u.searchParams.get("url");
      if (inner) {
        const decoded = decodeURIComponent(inner);
        if (decoded.startsWith("http")) return decoded;
        return new URL(decoded, u.origin).toString();
      }
    }
  } catch {
    // fall through — return as-is
  }
  return url;
}

// Minimum plausible product-photo size (URL-declared). Filters colour
// swatches (e.g. 104x96) and icons without touching images whose URLs
// carry no size info (those pass through with neutral rank).
const MIN_PRODUCT_IMAGE_PX = 200;

function rankAndFilterBySize(urls: string[]): string[] {
  const scored = urls.map((u) => {
    const dims = parseUrlDimensions(u);
    if (!dims) return { u, area: 500 * 500, tiny: false };
    const tiny = dims.w < MIN_PRODUCT_IMAGE_PX || dims.h < MIN_PRODUCT_IMAGE_PX;
    return { u, area: dims.w * dims.h, tiny };
  });
  return scored
    .filter((s) => !s.tiny)
    .sort((x, y) => y.area - x.area)
    .map((s) => s.u);
}

// srcset attributes (img/source) — grab every candidate URL; the
// per-URL size ranking above sorts out which rendition wins.
function imagesFromSrcsets(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /srcset=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    for (const part of m[1].split(",")) {
      const url = part.trim().split(/\s+/)[0];
      if (!url || url.startsWith("data:")) continue;
      if (isLikelyIconOrSprite(url)) continue;
      const abs = absolutise(url, baseUrl);
      if (!abs) continue;
      const real = unwrapNextImageProxy(abs);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(real);
      if (out.length >= MAX_IMAGES * 3) return out;
    }
  }
  return out;
}

function imagesFromImgTags(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Support src and common lazy-load attributes (data-src, data-lazy-src).
  const re = /<img\s[^>]*?(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith("data:")) continue;
    if (isLikelyIconOrSprite(raw)) continue;
    const abs = absolutise(raw, baseUrl);
    if (!abs) continue;
    const real = unwrapNextImageProxy(abs);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(real);
    if (out.length >= MAX_IMAGES * 3) break;
  }
  return out;
}

/**
 * Strip script/style contents and tags to approximate "visible text",
 * then scan for AUD-shaped price patterns:
 *   $1,234.56 / $1234 / AU$99.00 / A$99 — with "inc gst"/"incl gst"
 *   proximity treated as a confidence boost (still same regex family).
 */
function priceFromText(html: string): { price: number | null; confidence: "medium" | "low" | "none" } {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  // AU$99.00 / A$99 / $1,234.56
  const priceRe = /(?:AU\$|A\$|\$)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;
  const candidates: { value: number; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = priceRe.exec(text))) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n >= MIN_PRICE && n <= MAX_PRICE) {
      candidates.push({ value: n, index: m.index });
    }
  }
  if (candidates.length === 0) return { price: null, confidence: "none" };

  // Boost confidence if "inc gst" / "incl gst" / "gst" appears within ~40
  // chars of a candidate — a decent proxy for "this is THE price", not an
  // RRP-was/strikethrough or an unrelated number.
  const gstNear = (index: number) => {
    const windowText = text.slice(Math.max(0, index - 40), index + 40).toLowerCase();
    return /(inc\.?\s?gst|incl\.?\s?gst|gst)/.test(windowText);
  };

  const boosted = candidates.find((c) => gstNear(c.index));
  if (boosted) return { price: boosted.value, confidence: "medium" };

  // No proximity signal — take the first candidate but mark low confidence.
  return { price: candidates[0].value, confidence: "low" };
}

// ------------------------------------------------------------
// PDF / document detection
// ------------------------------------------------------------

const DOC_TEXT_RE = /spec(?:ification)?|data\s?sheet|installation|install\s?guide|manual|technical/i;

function guessKind(label: string, href: string): GuessedDocKind {
  const hay = `${label} ${href}`.toLowerCase();
  if (/install/.test(hay) || /manual/.test(hay)) return "install_manual";
  if (/spec|data\s?sheet|technical/.test(hay)) return "spec_sheet";
  return "other";
}

function extractDocuments(html: string, baseUrl: string): DetectedDocument[] {
  const out: DetectedDocument[] = [];
  const seen = new Set<string>();
  const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1].trim();
    const labelRaw = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) continue;

    const isPdf = /\.pdf(?:[?#]|$)/i.test(href);
    const matchesKeyword = DOC_TEXT_RE.test(labelRaw) || DOC_TEXT_RE.test(href);
    if (!isPdf && !matchesKeyword) continue;
    // Keyword match without .pdf extension is only interesting if it's
    // clearly a document link (has some href) — still require it be a
    // plausible file link to avoid matching nav menu items like
    // "Installation Services" pages. We accept it either way per spec
    // ("hrefs ending .pdf OR link text matching ...") but keep the
    // guessed kind conservative.
    const abs = absolutise(href, baseUrl);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);

    out.push({
      url: abs,
      guessedKind: guessKind(labelRaw, href),
      label: labelRaw || href.split("/").pop() || "Document",
    });
  }
  return out;
}

// ------------------------------------------------------------
// Bunnings (bunnings.com.au) — site-specific extraction.
// Confirmed by direct inspection (14 Jul 2026): Bunnings product pages
// carry neither a JSON-LD Product block nor a product:price:amount/
// og:price:amount meta tag, so the two generic structured-data passes
// above always fall through to the low-confidence text-price regex /
// raw <img> scan for this one site. The page IS plain-fetchable with
// no browser though (Aria's headless-browser-fingerprint-blocking
// diagnosis doesn't match what this pipeline actually does, or what
// Bunnings actually returns to a plain GET) — Bunnings server-renders
// a Next.js `__NEXT_DATA__` script tag carrying the exact same React
// Query result the client hydrates from, including a
// `product-retail-price` query (data.value, a clean float, already in
// dollars) and a `retail-product` OR `trade-product` query containing
// images, brand, description/features, classification specifications
// and dimensions. Parsed first, ahead of the generic chain in
// extractFromHtml below, since it's the most structured source
// available for this specific site — not a general per-site plugin
// system (only one site needs this today; see this file's own header
// comment on why a real HTML parser isn't available here either).
// Dimensions are read conservatively: mixed-unit product titles such
// as "90 x 45mm 5.4m" take priority and map the final value to length;
// otherwise Bunnings' explicit width/height/depth object is used.
// ------------------------------------------------------------

function isBunningsUrl(pageUrl: string): boolean {
  try {
    return /(^|\.)bunnings\.com\.au$/i.test(new URL(pageUrl).hostname);
  } catch {
    return false;
  }
}

interface BunningsNextDataQuery {
  queryKey?: unknown[];
  state?: { data?: unknown };
}

interface BunningsExtract {
  price: number | null;
  images: string[];
  dimensions: ExtractedDimensions;
  title: string | null;
  description: string | null;
  brand: string | null;
  details: ExtractedProductDetail[];
}

function extractBunningsNextData(html: string): BunningsExtract {
  const result: BunningsExtract = {
    price: null,
    images: [],
    dimensions: {},
    title: null,
    description: null,
    brand: null,
    details: [],
  };
  const m = /<script id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return result;
  }

  const queries = (
    parsed as {
      props?: { pageProps?: { dehydratedState?: { queries?: BunningsNextDataQuery[] } } };
    }
  )?.props?.pageProps?.dehydratedState?.queries;
  if (!Array.isArray(queries)) return result;

  for (const q of queries) {
    const key = Array.isArray(q.queryKey) ? q.queryKey[0] : undefined;
    const data = q.state?.data;
    if (!data || typeof data !== "object") continue;

    if (key === "product-retail-price") {
      const value = (data as { value?: unknown }).value;
      const n = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(n) && n >= MIN_PRICE && n <= MAX_PRICE) result.price = n;
    } else if (key === "retail-product" || key === "trade-product") {
      const product = data as {
        name?: unknown;
        summary?: unknown;
        brand?: { name?: unknown };
        code?: unknown;
        itemNumber?: unknown;
        unitofprice?: unknown;
        images?: unknown;
        feature?: { description?: unknown; pointers?: unknown };
        classifications?: unknown;
        dimension?: { product?: unknown };
      };
      const images = product.images;
      if (Array.isArray(images)) {
        for (const img of images) {
          const url = (img as { url?: unknown })?.url;
          if (typeof url === "string" && url) result.images.push(url);
        }
      }

      result.title ??= cleanText(product.name);
      result.description ??=
        cleanText(product.feature?.description) ?? cleanText(product.summary);
      result.brand ??= cleanText(product.brand?.name);

      const itemNumber = cleanText(product.itemNumber) ?? cleanText(product.code);
      if (itemNumber) result.details.push({ label: "Item number", value: itemNumber });
      const unit = cleanText(product.unitofprice);
      if (unit) result.details.push({ label: "Unit of sale", value: unit });

      if (Array.isArray(product.feature?.pointers)) {
        const pointers = product.feature.pointers
          .map(cleanText)
          .filter((value): value is string => !!value);
        if (pointers.length) {
          result.details.push({ label: "Features", value: pointers.join(" · ") });
        }
      }

      if (Array.isArray(product.classifications)) {
        for (const classification of product.classifications) {
          const features = (classification as { features?: unknown })?.features;
          if (!Array.isArray(features)) continue;
          for (const feature of features) {
            const typed = feature as {
              name?: unknown;
              featureValues?: unknown;
            };
            const label = cleanText(typed.name);
            const values = Array.isArray(typed.featureValues)
              ? typed.featureValues
                  .map((entry) => cleanText((entry as { value?: unknown })?.value))
                  .filter((value): value is string => !!value)
              : [];
            if (label && values.length) {
              result.details.push({ label, value: values.join(", ") });
            }
          }
        }
      }

      // Product title is the safest source for mixed-unit timber sizes.
      // If it does not carry a recognisable dimension string, fall back
      // to Bunnings' explicit product dimension object.
      const fromTitle = result.title ? dimensionsFromText(result.title) : {};
      result.dimensions = mergeDimensions(result.dimensions, fromTitle);
      const explicit = Array.isArray(product.dimension?.product)
        ? (product.dimension?.product[0] as
            | { width?: unknown; height?: unknown; depth?: unknown }
            | undefined)
        : undefined;
      if (explicit && Object.keys(fromTitle).length === 0) {
        const width = toMm(Number(explicit.width), "mm");
        const height = toMm(Number(explicit.height), "mm");
        const depth = toMm(Number(explicit.depth), "mm");
        if (width !== null) result.dimensions.width_mm = width;
        if (height !== null) result.dimensions.height_mm = height;
        if (depth !== null) result.dimensions.depth_mm = depth;
      }
    }
  }

  result.details = dedupeDetails(result.details);
  return result;
}

// ------------------------------------------------------------
// Public entry point
// ------------------------------------------------------------

/**
 * Extracts price, images, and detected PDF documents from a product
 * page's HTML. Priority order (per BUILD-SPEC.md):
 *   0. Site-specific (currently just Bunnings — see
 *      extractBunningsNextData's own header comment)
 *   1. JSON-LD Product (offers.price, image)
 *   2. OpenGraph / product meta tags (og:image, product:price:amount)
 *   3. Fallback: <img> collection + price regex on visible text
 *
 * Never throws.
 */
export function extractFromHtml(html: string, pageUrl: string): ExtractResult {
  try {
    // 0. Site-specific — see extractBunningsNextData's own header
    // comment for why this runs ahead of the generic chain.
    const bunnings = isBunningsUrl(pageUrl)
      ? extractBunningsNextData(html)
      : {
          price: null as number | null,
          images: [] as string[],
          dimensions: {} as ExtractedDimensions,
          title: null as string | null,
          description: null as string | null,
          brand: null as string | null,
          details: [] as ExtractedProductDetail[],
        };

    const ldBlocks = extractJsonLdBlocks(html);
    const products: JsonLdProduct[] = [];
    for (const block of ldBlocks) findProductNodes(block, products);
    const jsonLdContent = contentFromJsonLd(products);

    let price: number | null = bunnings.price;
    let priceConfidence: ExtractResult["priceConfidence"] = bunnings.price !== null ? "high" : "none";
    let images: string[] = [...bunnings.images];
    const title =
      bunnings.title ??
      jsonLdContent.title ??
      cleanText(metaContent(html, "og:title")[0]) ??
      cleanText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
    const description =
      bunnings.description ??
      jsonLdContent.description ??
      cleanText(metaContent(html, "og:description")[0]) ??
      cleanText(metaContent(html, "description")[0]);
    const brand =
      bunnings.brand ??
      jsonLdContent.brand ??
      cleanText(metaContent(html, "product:brand")[0]);
    const details = dedupeDetails([
      ...bunnings.details,
      ...jsonLdContent.details,
      ...detailsFromHtml(html),
    ]);

    // 1. JSON-LD
    if (price === null) {
      const ldPrice = priceFromJsonLd(products);
      if (ldPrice !== null) {
        price = ldPrice;
        priceConfidence = "high";
      }
    }
    const ldImages = imagesFromJsonLd(products)
      .map((i) => absolutise(i, pageUrl))
      .filter((i): i is string => !!i && !isLikelyIconOrSprite(i));
    images.push(...ldImages);

    // 2. OpenGraph / meta
    if (price === null) {
      const metaPrice = priceFromMeta(html);
      if (metaPrice !== null) {
        price = metaPrice;
        priceConfidence = "high";
      }
    }
    // og:image is only trustworthy when the page declares itself a
    // product (og:type "product"). Sites like yabby.com.au ship ONE
    // sitewide banner as og:image on every product page (og:type
    // "website") — trusting it gave every item the same generic image
    // (user-reported, 6 Jul). Non-product og:image is demoted to a
    // last-resort candidate below instead.
    const ogType = (metaContent(html, "og:type")[0] ?? "").toLowerCase();
    const ogImages = imagesFromMeta(html)
      .map((i) => absolutise(i, pageUrl))
      .filter((i): i is string => !!i && !isLikelyIconOrSprite(i));
    if (images.length === 0 && ogType.includes("product")) {
      images.push(...ogImages);
    }

    // 3. Fallback
    if (price === null) {
      const fallback = priceFromText(html);
      price = fallback.price;
      priceConfidence = fallback.confidence;
    }
    // In-page images (img tags + srcsets, proxies unwrapped, size-ranked)
    // whenever structured sources came up thin — thin, not just empty:
    // one structured image on a page with a rich gallery usually means
    // the structured source was junk or partial.
    if (images.length < 3) {
      const inPage = rankAndFilterBySize([
        ...imagesFromSrcsets(html, pageUrl),
        ...imagesFromImgTags(html, pageUrl),
      ]);
      images.push(...inPage);
    }
    // Absolute last resort: a non-product og:image is better than nothing.
    if (images.length === 0) {
      images.push(...ogImages);
    }

    // Dedupe + cap regardless of which source(s) contributed.
    const dedupedImages = [...new Set(images)].slice(0, MAX_IMAGES);

    const documents = extractDocuments(html, pageUrl);

    // Dimensions (best-effort) — BUILD-SPEC.md "Dimension extraction
    // (best-effort)": (a) JSON-LD Product width/height/depth first,
    // (b) spec-table/text patterns as a fallback for any field JSON-LD
    // didn't provide (including `length`, which schema.org's Product
    // type has no dedicated property for).
    const dimensions = mergeDimensions(
      bunnings.dimensions,
      mergeDimensions(dimensionsFromJsonLd(products), dimensionsFromText(html))
    );

    return {
      price,
      priceConfidence,
      images: dedupedImages,
      documents,
      dimensions,
      title,
      description,
      brand,
      details,
    };
  } catch {
    // Extraction must never throw — a malformed page degrades to "nothing
    // found", which the pipeline treats as a partial/failed scrape.
    return {
      price: null,
      priceConfidence: "none",
      images: [],
      documents: [],
      dimensions: {},
      title: null,
      description: null,
      brand: null,
      details: [],
    };
  }
}
