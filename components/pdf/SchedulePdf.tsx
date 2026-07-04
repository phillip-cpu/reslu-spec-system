import fs from "node:fs";
import path from "node:path";
import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  Font,
} from "@react-pdf/renderer";
import type { Category, Item, Project } from "@/types";

// ── fonts (registered once) ─────────────────────────────────
// Cormorant Garamond — display/cover titles + item names only (brand
// guide). Body/labels use the built-in Helvetica (Helvetica Neue Light
// is proprietary and can't be bundled; Helvetica is the closest
// standard PDF face). BUILD-SPEC.md §Brand.
//
// BUILD-SPEC.md open items note the Cormorant TTF "may be missing" —
// if `public/fonts/CormorantGaramond.ttf` isn't present at render time
// (e.g. a fresh clone before the font's been dropped in), this module
// falls back to the built-in Times-Roman rather than throwing, so PDF
// generation never breaks for a missing brand asset. See README for
// the one-line fix once the file exists.
const CORMORANT_PATH = path.join(
  process.cwd(),
  "public/fonts/CormorantGaramond.ttf"
);

let fontsRegistered = false;
let displayFontFamily = "Times-Roman"; // fallback built-in serif

function ensureFonts() {
  if (fontsRegistered) return;
  fontsRegistered = true;

  if (fs.existsSync(CORMORANT_PATH)) {
    try {
      Font.register({ family: "Cormorant", src: CORMORANT_PATH });
      displayFontFamily = "Cormorant";
    } catch {
      // Corrupt/unreadable font file — keep the Times-Roman fallback
      // rather than failing PDF generation.
      displayFontFamily = "Times-Roman";
    }
  }
  Font.registerHyphenationCallback((word) => [word]); // no hyphenation
}

// Brand palette (BUILD-SPEC.md §Brand)
const CREAM = "#EDE8DE";
const CHARCOAL = "#313131";
const NEARBLACK = "#1A1A1A";
const SAND = "#A08C72";
const LINE = "#DCD6CC";
const WHITE = "#FFFFFF";

const LOGO_BLACK = path.join(process.cwd(), "public/reslu-logo.png");
const LOGO_WHITE = path.join(process.cwd(), "public/reslu-logo-white.png");

// A4 portrait = 210 x 297mm. react-pdf's mm unit is supported directly
// in style values, so image/box sizes are specced in "mm" per the
// layout mock (BUILD-SPEC.md §10: "~62mm tall" images).
const IMAGE_HEIGHT = "62mm";
const PAGE_MARGIN_H = 40; // pt
const HEADER_BAND_HEIGHT = 92; // pt, cream band at top of every page

const styles = StyleSheet.create({
  // ── Cover page ──────────────────────────────────────────
  cover: {
    backgroundColor: CREAM,
    padding: 64,
    flexDirection: "column",
    justifyContent: "space-between",
    height: "100%",
  },
  coverLogo: { width: 160 },
  coverTitle: {
    fontSize: 52,
    color: NEARBLACK,
  },
  coverSub: {
    fontSize: 9,
    letterSpacing: 2,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    color: SAND,
    marginTop: 8,
  },
  coverMeta: { fontSize: 10, color: CHARCOAL, lineHeight: 1.6 },

  // ── Schedule pages ──────────────────────────────────────
  page: {
    backgroundColor: WHITE,
    paddingBottom: 48,
    paddingHorizontal: PAGE_MARGIN_H,
    fontSize: 9,
    color: CHARCOAL,
  },

  // Header band — cream, full-bleed width, matches the mock's cover-like
  // banner repeated (in condensed form) as the running header.
  headerBand: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: HEADER_BAND_HEIGHT,
    backgroundColor: CREAM,
    paddingHorizontal: PAGE_MARGIN_H,
    paddingTop: 22,
    paddingBottom: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  headerProjectName: {
    fontSize: 26,
    color: NEARBLACK,
  },
  headerSub: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: SAND,
    marginTop: 6,
  },
  headerRightBlock: { alignItems: "flex-end" },
  headerRightLine: {
    fontSize: 8,
    color: CHARCOAL,
    marginTop: 2,
  },

  contentTop: { marginTop: HEADER_BAND_HEIGHT + 24 },

  // Category section
  sectionLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 2,
    textTransform: "uppercase",
    color: SAND,
    borderBottomWidth: 1,
    borderBottomColor: NEARBLACK,
    paddingBottom: 4,
    marginTop: 18,
    marginBottom: 12,
  },

  // 2x2 item grid
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  card: {
    width: "48%",
    marginBottom: 22,
  },
  imageBox: {
    width: "100%",
    height: IMAGE_HEIGHT,
    backgroundColor: CREAM,
    alignItems: "center",
    justifyContent: "center",
  },
  image: { width: "100%", height: IMAGE_HEIGHT, objectFit: "cover" },
  noImageBox: {
    width: "100%",
    height: IMAGE_HEIGHT,
    backgroundColor: CREAM,
    alignItems: "center",
    justifyContent: "center",
  },
  noImage: {
    fontSize: 7,
    color: SAND,
    textTransform: "uppercase",
    letterSpacing: 1,
  },

  codeLocationLine: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: SAND,
    marginTop: 10,
    marginBottom: 4,
  },
  itemName: {
    fontSize: 13,
    color: NEARBLACK,
    marginBottom: 3,
  },
  specLine: {
    fontSize: 9,
    color: CHARCOAL,
    lineHeight: 1.4,
  },
  qtyLine: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: CHARCOAL,
    marginTop: 3,
    letterSpacing: 0.5,
  },
  docsLine: {
    fontSize: 7,
    color: SAND,
    marginTop: 3,
    fontStyle: "italic",
  },

  // Footer
  footer: {
    position: "absolute",
    bottom: 20,
    left: PAGE_MARGIN_H,
    right: PAGE_MARGIN_H,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: LINE,
    paddingTop: 6,
  },
  footerLeft: {
    fontSize: 7,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: SAND,
  },
  footerRight: {
    fontSize: 7,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: SAND,
  },
});

// ── helpers ─────────────────────────────────────────────────

/** Collapse dimensions to one line — ONLY when present (BUILD-SPEC.md §10). */
function dimensionsLine(item: Pick<Item, "width_mm" | "height_mm" | "length_mm" | "depth_mm">): string | null {
  const parts: string[] = [];
  if (item.width_mm != null) parts.push(`W${trimNum(item.width_mm)}`);
  if (item.height_mm != null) parts.push(`H${trimNum(item.height_mm)}`);
  if (item.length_mm != null) parts.push(`L${trimNum(item.length_mm)}`);
  if (item.depth_mm != null) parts.push(`D${trimNum(item.depth_mm)}`);
  return parts.length ? `${parts.join(" × ")} mm` : null;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace(/\.?0+$/, "");
}

/** Join present values with a separator, dropping blanks (suppress empties entirely). */
function joinPresent(values: (string | null | undefined)[], sep = "  ·  "): string | null {
  const present = values.filter((v): v is string => !!v && v.trim() !== "");
  return present.length ? present.join(sep) : null;
}

interface PdfItem extends Item {
  /** Resolved by the PDF route's image pre-pass (lib/images.ts) — may
   *  differ from item.selected_image_url if it was re-hosted, or be
   *  undefined if the image couldn't be fetched/stored (skip, don't fail). */
  resolvedImageUrl?: string;
  /** Whether this item has at least one item_files row — drives the
   *  deferred "Docs: spec sheet available in portal" label
   *  (BUILD-SPEC.md §5/§10 — QR codes deferred, no new deps available). */
  hasDocs?: boolean;
}

interface Props {
  project: Pick<Project, "name" | "client_name" | "address">;
  items: PdfItem[];
  categories: Category[];
  generatedAt: string; // formatted date, passed in (server)
  revisionLabel?: string; // e.g. "T3" — optional, matches the mock's header
  scheduleSubtitle?: string; // e.g. "Wet Area Works" — optional phase label
}

export function SchedulePdf({
  project,
  items,
  categories,
  generatedAt,
  revisionLabel,
  scheduleSubtitle,
}: Props) {
  ensureFonts();

  // Group by CATEGORY (matches FFE-Schedule-Layout-Mock.pdf — section
  // headers are category names like "SANITARYWARE", not location; each
  // item's own code+location line carries the room, per BUILD-SPEC.md §10
  // "room next to item code").
  const categoryName = new Map(categories.map((c) => [c.prefix, c.name]));
  const map = new Map<string, PdfItem[]>();
  for (const it of items) {
    const key = it.category;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(it);
  }
  const sortOrder = new Map(categories.map((c) => [c.prefix, c.sort_order]));
  const groups = [...map.entries()].sort((a, b) => {
    const sa = sortOrder.get(a[0]) ?? 999;
    const sb = sortOrder.get(b[0]) ?? 999;
    if (sa !== sb) return sa - sb;
    return a[0].localeCompare(b[0]);
  });

  const headerSub = scheduleSubtitle
    ? `FF&E Schedule  ·  ${scheduleSubtitle}`
    : "FF&E Schedule";

  return (
    <Document title={`${project.name} — FF&E Schedule`}>
      {/* Cover — cream + black logo (brand guide: dark cover pairs with
          white logo, but the spec picks cream+black as the default). */}
      <Page size="A4" style={styles.cover}>
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <Image src={LOGO_BLACK} style={styles.coverLogo} />
        <View>
          <Text style={{ ...styles.coverTitle, fontFamily: displayFontFamily }}>
            {project.name}
          </Text>
          <Text style={styles.coverSub}>FF&amp;E Schedule</Text>
        </View>
        <View style={styles.coverMeta}>
          <Text>{project.client_name}</Text>
          {project.address ? <Text>{project.address}</Text> : null}
          <Text>
            RESLU  ·  {generatedAt}
            {revisionLabel ? `  ·  ${revisionLabel}` : ""}
          </Text>
        </View>
      </Page>

      {/* Schedule pages */}
      <Page size="A4" style={styles.page}>
        <View style={styles.headerBand} fixed>
          <View>
            <Text
              style={{ ...styles.headerProjectName, fontFamily: displayFontFamily }}
            >
              {project.name}
            </Text>
            <Text style={styles.headerSub}>{headerSub}</Text>
          </View>
          <View style={styles.headerRightBlock}>
            <Text style={styles.headerRightLine}>RESLU</Text>
            <Text style={styles.headerRightLine}>{generatedAt}</Text>
            {revisionLabel ? (
              <Text style={styles.headerRightLine}>{revisionLabel}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.contentTop}>
          {groups.map(([category, categoryItems]) => (
            <View key={category}>
              <Text style={styles.sectionLabel}>
                {categoryName.get(category) ?? category}
              </Text>
              <View style={styles.grid}>
                {categoryItems.map((item) => {
                  const codeLocation = joinPresent([
                    item.item_code,
                    item.location,
                  ]);
                  const specLine = joinPresent([
                    item.brand,
                    joinPresent([item.colour, item.material, item.finish], " · "),
                  ]);
                  const dims = dimensionsLine(item);
                  const imgSrc = item.resolvedImageUrl;

                  return (
                    // wrap=false keeps a card's image+text together across a
                    // page break; ~4/page (2x2) falls out of the width/height
                    // budget naturally rather than being hard-paginated.
                    <View key={item.id} style={styles.card} wrap={false}>
                      {imgSrc ? (
                        <View style={styles.imageBox}>
                          {/* eslint-disable-next-line jsx-a11y/alt-text */}
                          <Image src={imgSrc} style={styles.image} />
                        </View>
                      ) : (
                        <View style={styles.noImageBox}>
                          <Text style={styles.noImage}>No image</Text>
                        </View>
                      )}

                      {codeLocation ? (
                        <Text style={styles.codeLocationLine}>{codeLocation}</Text>
                      ) : null}
                      <Text
                        style={{ ...styles.itemName, fontFamily: displayFontFamily }}
                      >
                        {item.name}
                      </Text>
                      {specLine ? (
                        <Text style={styles.specLine}>{specLine}</Text>
                      ) : null}
                      {dims ? <Text style={styles.specLine}>{dims}</Text> : null}
                      <Text style={styles.qtyLine}>QTY {trimNum(item.quantity)}</Text>
                      {item.hasDocs ? (
                        <Text style={styles.docsLine}>
                          Docs: spec sheet available in portal
                        </Text>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            </View>
          ))}
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerLeft}>
            {project.name}  /  FF&amp;E  /  {generatedAt}
          </Text>
          <Text
            style={styles.footerRight}
            render={({ pageNumber, totalPages }) =>
              `RESLU  ·  Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

export { LOGO_WHITE }; // reserved for a future dark-cover variant
