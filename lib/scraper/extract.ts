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
}

const MIN_PRICE = 1;
const MAX_PRICE = 500_000;
const MAX_IMAGES = 12;

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
interface JsonLdProduct {
  "@type"?: string | string[];
  image?: string | string[] | { url?: string };
  offers?: JsonLdOffer | JsonLdOffer[];
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

function absolutise(url: string, baseUrl: string): string | null {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return null;
  }
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
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= MAX_IMAGES) break;
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
// Public entry point
// ------------------------------------------------------------

/**
 * Extracts price, images, and detected PDF documents from a product
 * page's HTML. Priority order (per BUILD-SPEC.md):
 *   1. JSON-LD Product (offers.price, image)
 *   2. OpenGraph / product meta tags (og:image, product:price:amount)
 *   3. Fallback: <img> collection + price regex on visible text
 *
 * Never throws.
 */
export function extractFromHtml(html: string, pageUrl: string): ExtractResult {
  try {
    const ldBlocks = extractJsonLdBlocks(html);
    const products: JsonLdProduct[] = [];
    for (const block of ldBlocks) findProductNodes(block, products);

    let price: number | null = null;
    let priceConfidence: ExtractResult["priceConfidence"] = "none";
    let images: string[] = [];

    // 1. JSON-LD
    const ldPrice = priceFromJsonLd(products);
    if (ldPrice !== null) {
      price = ldPrice;
      priceConfidence = "high";
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
    if (images.length === 0) {
      const metaImages = imagesFromMeta(html)
        .map((i) => absolutise(i, pageUrl))
        .filter((i): i is string => !!i && !isLikelyIconOrSprite(i));
      images.push(...metaImages);
    }

    // 3. Fallback
    if (price === null) {
      const fallback = priceFromText(html);
      price = fallback.price;
      priceConfidence = fallback.confidence;
    }
    if (images.length === 0) {
      images.push(...imagesFromImgTags(html, pageUrl));
    }

    // Dedupe + cap regardless of which source(s) contributed.
    const dedupedImages = [...new Set(images)].slice(0, MAX_IMAGES);

    const documents = extractDocuments(html, pageUrl);

    // Dimensions (best-effort) — BUILD-SPEC.md "Dimension extraction
    // (best-effort)": (a) JSON-LD Product width/height/depth first,
    // (b) spec-table/text patterns as a fallback for any field JSON-LD
    // didn't provide (including `length`, which schema.org's Product
    // type has no dedicated property for).
    const dimensions = mergeDimensions(dimensionsFromJsonLd(products), dimensionsFromText(html));

    return { price, priceConfidence, images: dedupedImages, documents, dimensions };
  } catch {
    // Extraction must never throw — a malformed page degrades to "nothing
    // found", which the pipeline treats as a partial/failed scrape.
    return { price: null, priceConfidence: "none", images: [], documents: [], dimensions: {} };
  }
}
