/**
 * Minimal RFC 4180-ish CSV parser — no external dependency needed for the
 * Week 2 import feature (Programa-style exports: comma-delimited, optional
 * double-quoted fields, "" escapes an embedded quote, fields may contain
 * embedded commas/newlines when quoted). Not a full spec implementation
 * (no custom delimiters, no BOM-per-field handling beyond stripping a
 * leading UTF-8 BOM) but sufficient for the supplier/Programa exports this
 * app needs to read.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = src.length;

  function pushField() {
    row.push(field);
    field = "";
  }
  function pushRow() {
    pushField();
    rows.push(row);
    row = [];
  }

  while (i < n) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // swallow; \n (or end of input) handles the row break
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // final field/row if the file doesn't end with a newline
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  // drop wholly-empty trailing rows (common with trailing newlines)
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) {
    rows.pop();
  }

  return rows;
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/**
 * Find the real header row in a parsed grid. Design-tool exports (Programa
 * etc.) prepend title/metadata rows ("RESLU", "Project: GOLDSWORTHY …")
 * before the actual column headings, so row 0 is often NOT the header. We
 * scan the first several rows and pick the one that best matches known field
 * names (via suggestColumnMapping) — a sparse title row scores ~0 and loses
 * to the wide, field-named header row; data rows below hold values, not
 * field names, so they score low too. Cell count is the tie-breaker. Falls
 * back to row 0 when nothing scores (an unrecognised but valid CSV).
 */
function detectHeaderRow(rows: string[][]): number {
  const limit = Math.min(rows.length, 20);
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map((c) => (c ?? "").trim());
    const filled = cells.filter((c) => c !== "").length;
    if (filled < 2) continue; // skip 1-cell title rows
    const mapped = Object.values(suggestColumnMapping(cells)).filter(Boolean).length;
    const score = mapped * 100 + filled; // recognised field names dominate
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestScore >= 0 ? bestIdx : 0;
}

/**
 * Parse CSV text into a header row + data rows. The header row is
 * auto-detected (see detectHeaderRow), so leading title/metadata rows common
 * in design-tool exports are skipped: rows above the header are ignored and
 * fully-empty rows below it are dropped. Empty input → empty table.
 */
export function parseCsvTable(text: string): CsvTable {
  const all = parseCsv(text);
  if (all.length === 0) return { headers: [], rows: [] };
  const headerIdx = detectHeaderRow(all);
  const headers = (all[headerIdx] ?? []).map((c) => (c ?? "").trim());
  const rows = all
    .slice(headerIdx + 1)
    .filter((r) => r.some((c) => (c ?? "").trim() !== ""));
  return { headers, rows };
}

/**
 * Serialise a grid of cells back to CSV text. Used by the import wizard to
 * turn xlsx rows (parsed client-side via read-excel-file) into the same CSV
 * string the rest of the import pipeline already consumes — so xlsx support
 * needs no server change. Cells are stringified; those containing a comma,
 * quote, or newline are double-quoted with `"` escaped as `""` (RFC 4180).
 */
export function rowsToCsv(rows: (string | number | boolean | Date | null | undefined)[][]): string {
  const cell = (v: string | number | boolean | Date | null | undefined): string => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

// ------------------------------------------------------------
// Column-mapping helpers (CSV import — Week 2)
// ------------------------------------------------------------

/** The item fields a CSV column can be mapped onto. */
export const IMPORT_TARGET_FIELDS = [
  "item_code",
  "name",
  "category",
  "brand",
  "colour",
  "material",
  "finish",
  "width_mm",
  "height_mm",
  "length_mm",
  "depth_mm",
  "supplier",
  "supplier_email",
  "location",
  "application_note",
  "quantity",
  "unit",
  "description",
  "product_url",
  "image_url",
  "price_rrp",
  "price_trade",
  "notes", // free-text import notes column — not persisted, shown in the review step only
] as const;

export type ImportTargetField = (typeof IMPORT_TARGET_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportTargetField, string> = {
  item_code: "Item code",
  name: "Name",
  category: "Category",
  brand: "Brand",
  colour: "Colour",
  material: "Material",
  finish: "Finish",
  width_mm: "Width (mm)",
  height_mm: "Height (mm)",
  length_mm: "Length (mm)",
  depth_mm: "Depth (mm)",
  supplier: "Supplier",
  supplier_email: "Supplier email",
  location: "Location",
  application_note: "Application note",
  quantity: "Quantity",
  unit: "Unit",
  description: "Description",
  product_url: "Product URL",
  image_url: "Image URL",
  price_rrp: "RRP (ex GST)",
  price_trade: "Trade price (ex GST)",
  notes: "Notes (import only)",
};

/** Header-name synonyms used for auto-mapping a CSV's columns (Programa-ish exports). */
const FIELD_SYNONYMS: Record<ImportTargetField, string[]> = {
  item_code: ["code", "item code", "item_code", "sku"],
  name: ["type", "item", "item type", "product", "name"],
  category: ["category", "cat"],
  brand: ["brand", "manufacturer"],
  colour: ["colour", "color"],
  material: ["material"],
  finish: ["finish"],
  width_mm: ["width", "width mm", "width (mm)", "w"],
  height_mm: ["height", "height mm", "height (mm)", "h"],
  length_mm: ["length", "length mm", "length (mm)", "l"],
  depth_mm: ["depth", "depth mm", "depth (mm)", "d"],
  supplier: ["supplier", "supplier company", "vendor"],
  supplier_email: ["supplier email", "supplier_email", "vendor email"],
  location: ["location", "room", "area"],
  // Deliberately NOT "note"/"notes" — a bare "Notes" header should resolve
  // to the dedicated `notes` field below (review-only, not persisted), not
  // to application_note. "Application note" (the fuller phrase) still
  // matches so exports using that exact wording keep working.
  application_note: ["application note", "application_note"],
  quantity: ["qty", "quantity"],
  unit: ["unit", "uom"],
  description: ["description", "desc", "product name"],
  product_url: [
    "product url", "product link", "product page", "url", "link", "website",
    "web", "web address", "product website", "spec link",
  ],
  image_url: [
    "image", "image url", "image link", "photo", "photo url", "picture",
    "thumbnail", "img", "image address",
  ],
  price_rrp: [
    "rrp", "price", "retail", "retail price", "rrp ex gst", "rrp (ex gst)",
    "unit price", "price rrp", "sell", "sell price",
  ],
  price_trade: [
    "trade", "trade price", "trade cost", "cost", "cost price", "wholesale",
    "trade ex gst", "buy price",
  ],
  notes: ["notes", "note", "comment", "comments"],
};

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");
}

/**
 * Suggests a target field for each CSV header by exact/synonym match first,
 * falling back to substring containment. Returns a map of header → field
 * (or null if nothing looked close enough) — always a *suggestion*; the
 * import UI requires the user to confirm/adjust before submitting.
 *
 * Special case: "Product Name" is ambiguous between `name` and
 * `description` in Programa-ish exports (it's usually the fullest product
 * description, e.g. "Caroma Contura II Undercounter Basin Matte White").
 * We map it to `description` and expect `Type`/`Item` (the short item-type
 * label) to fill `name`, matching how the Goldsworthy tender reads.
 */
export function suggestColumnMapping(
  headers: string[]
): Record<string, ImportTargetField | null> {
  const used = new Set<ImportTargetField>();
  const mapping: Record<string, ImportTargetField | null> = {};

  for (const header of headers) {
    const norm = normalise(header);
    let best: ImportTargetField | null = null;

    if (norm === "product name" && !used.has("description")) {
      best = "description";
    }

    if (!best) {
      for (const field of IMPORT_TARGET_FIELDS) {
        if (used.has(field)) continue;
        if (FIELD_SYNONYMS[field].some((syn) => normalise(syn) === norm)) {
          best = field;
          break;
        }
      }
    }

    if (!best) {
      for (const field of IMPORT_TARGET_FIELDS) {
        if (used.has(field)) continue;
        if (
          FIELD_SYNONYMS[field].some(
            (syn) => norm.includes(normalise(syn)) || normalise(syn).includes(norm)
          )
        ) {
          best = field;
          break;
        }
      }
    }

    mapping[header] = best;
    if (best) used.add(best);
  }

  return mapping;
}

/** Derive a category prefix from an item code like "TW-01" → "TW". Returns null if it doesn't look like one. */
export function categoryFromItemCode(code: string): string | null {
  const m = /^([A-Za-z]{2,4})-?\d+/.exec(code.trim());
  return m ? m[1].toUpperCase() : null;
}
