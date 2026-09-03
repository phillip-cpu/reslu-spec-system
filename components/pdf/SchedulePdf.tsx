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

// Compact row-layout budgeting. These values are deliberately slightly
// conservative so long names still fit without react-pdf creating an
// unplanned continuation page beneath the running header.
const ITEM_ROW_BUDGET = 58;
const SECTION_LABEL_BUDGET = 24;
const PAGE_CONTENT_BUDGET = 550;
const PAGE_MARGIN_H = 40; // pt
const HEADER_BAND_HEIGHT = 92; // pt, cream band at top of every page

// Fold this into the route's storage-cache key whenever the PDF layout
// changes. Otherwise an unchanged item set can keep serving an older
// cached render after a deployment.
export const SCHEDULE_PDF_LAYOUT_VERSION = "compact-rows-v4";

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
    paddingTop: HEADER_BAND_HEIGHT + 24,
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

  pageContent: { flexShrink: 0 },
  categorySection: { flexShrink: 0 },
  itemRows: { flexShrink: 0 },

  // Category section
  sectionLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 2,
    textTransform: "uppercase",
    color: SAND,
    borderBottomWidth: 1,
    borderBottomColor: NEARBLACK,
    paddingBottom: 3,
    marginTop: 8,
    marginBottom: 2,
  },

  // Compact horizontal schedule row
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    height: ITEM_ROW_BUDGET,
    flexShrink: 0,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
  },
  imageBox: {
    width: 48,
    height: 48,
    backgroundColor: CREAM,
    borderWidth: 1,
    borderColor: LINE,
    padding: 4,
    overflow: "hidden",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  image: { width: "100%", height: "100%", objectFit: "contain" },
  noImageBox: {
    width: 48,
    height: 48,
    backgroundColor: CREAM,
    borderWidth: 1,
    borderColor: LINE,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  noImage: {
    fontSize: 5.5,
    color: SAND,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  itemDetails: {
    flexGrow: 1,
    flexBasis: 0,
    marginLeft: 10,
    paddingRight: 6,
  },
  codeLocationLine: {
    fontSize: 6.5,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.1,
    textTransform: "uppercase",
    color: SAND,
    marginBottom: 2,
  },
  itemName: {
    fontSize: 10,
    color: NEARBLACK,
    lineHeight: 1.05,
    marginBottom: 2,
  },
  specLine: {
    fontSize: 7.5,
    color: CHARCOAL,
    lineHeight: 1.2,
  },
  itemMeta: {
    width: 112,
    marginLeft: 8,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  dimensionsLine: {
    fontSize: 7,
    color: CHARCOAL,
    textAlign: "right",
    marginBottom: 2,
  },
  qtyLine: {
    fontSize: 6.5,
    fontFamily: "Helvetica-Bold",
    color: CHARCOAL,
    letterSpacing: 0.4,
    textAlign: "right",
  },
  docsLine: {
    fontSize: 6,
    color: SAND,
    marginTop: 2,
    fontStyle: "italic",
    textAlign: "right",
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
  // job_number (migration 028_job_numbers.sql, "Three from Phillip — 6
  // July 2026 evening" item 2) is not on the shared Project type
  // (types/index.ts is out of this task's edit boundary) — added here
  // via an inline intersection, same as this Pick<> is already narrowed
  // per-field rather than widened to the whole interface.
  project: Pick<Project, "name" | "client_name" | "address"> & { job_number?: string | null };
  items: PdfItem[];
  categories: Category[];
  generatedAt: string; // formatted date, passed in (server)
  revisionLabel?: string; // e.g. "T3" — optional, matches the mock's header
  scheduleSubtitle?: string; // e.g. "Wet Area Works" — optional phase label
}

interface PdfPageSection {
  category: string;
  items: PdfItem[];
  continued: boolean;
}

/**
 * Keep PDF pagination deterministic. Letting react-pdf split a long list can
 * place a continued row at y=0, over the fixed header. A height budget lets us
 * fit roughly eight compact rows per page while accounting for category labels.
 */
function paginateGroups(groups: [string, PdfItem[]][]): PdfPageSection[][] {
  const pages: PdfPageSection[][] = [];
  let page: PdfPageSection[] = [];
  let remainingHeight = PAGE_CONTENT_BUDGET;

  for (const [category, categoryItems] of groups) {
    let itemIndex = 0;
    while (itemIndex < categoryItems.length) {
      const minimumSectionHeight = SECTION_LABEL_BUDGET + ITEM_ROW_BUDGET;
      if (page.length > 0 && remainingHeight < minimumSectionHeight) {
        pages.push(page);
        page = [];
        remainingHeight = PAGE_CONTENT_BUDGET;
      }

      const availableRows = Math.max(
        1,
        Math.floor(
          (remainingHeight - SECTION_LABEL_BUDGET) / ITEM_ROW_BUDGET
        )
      );
      const take = Math.min(availableRows, categoryItems.length - itemIndex);
      page.push({
        category,
        items: categoryItems.slice(itemIndex, itemIndex + take),
        continued: itemIndex > 0,
      });
      itemIndex += take;
      remainingHeight -=
        SECTION_LABEL_BUDGET + take * ITEM_ROW_BUDGET;

      if (itemIndex < categoryItems.length) {
        pages.push(page);
        page = [];
        remainingHeight = PAGE_CONTENT_BUDGET;
      }
    }
  }

  if (page.length > 0) pages.push(page);
  return pages.length > 0 ? pages : [[]];
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
  const schedulePages = paginateGroups(groups);

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
          {project.job_number ? <Text>Project No. {project.job_number}</Text> : null}
          <Text>
            RESLU  ·  {generatedAt}
            {revisionLabel ? `  ·  ${revisionLabel}` : ""}
          </Text>
        </View>
      </Page>

      {/* Schedule pages — explicitly paginated to keep continuation rows
          clear of the running header and footer. */}
      {schedulePages.map((pageSections, pageIndex) => (
        <Page
          key={`schedule-page-${pageIndex}`}
          size="A4"
          style={styles.page}
        >
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

          <View style={styles.pageContent}>
            {pageSections.map(({ category, items: sectionItems, continued }) => (
              <View
                key={`${category}-${continued ? "continued" : "start"}`}
                style={styles.categorySection}
              >
                <Text style={styles.sectionLabel}>
                  {categoryName.get(category) ?? category}
                  {continued ? "  ·  Continued" : ""}
                </Text>
                <View style={styles.itemRows}>
                  {sectionItems.map((item) => {
                    const codeLocation = joinPresent([
                      item.item_code,
                      item.location,
                    ]);
                    const specLine = joinPresent([
                      item.brand,
                      joinPresent(
                        [item.colour, item.material, item.finish],
                        " · "
                      ),
                    ]);
                    const dims = dimensionsLine(item);
                    const imgSrc = item.resolvedImageUrl;

                    return (
                      <View key={item.id} style={styles.itemRow} wrap={false}>
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

                        <View style={styles.itemDetails}>
                          {codeLocation ? (
                            <Text style={styles.codeLocationLine}>
                              {codeLocation}
                            </Text>
                          ) : null}
                          <Text
                            style={{
                              ...styles.itemName,
                              fontFamily: displayFontFamily,
                            }}
                          >
                            {item.name}
                          </Text>
                          {specLine ? (
                            <Text style={styles.specLine}>{specLine}</Text>
                          ) : null}
                        </View>

                        <View style={styles.itemMeta}>
                          {dims ? (
                            <Text style={styles.dimensionsLine}>{dims}</Text>
                          ) : null}
                          <Text style={styles.qtyLine}>
                            {item.cost_scope === "trade_package"
                              ? "INCLUDED IN TRADE PACKAGE"
                              : `QTY ${trimNum(item.quantity)}`}
                          </Text>
                          {item.hasDocs ? (
                            <Text style={styles.docsLine}>
                              Docs available in portal
                            </Text>
                          ) : null}
                        </View>
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
              {project.job_number ? `  /  Project No. ${project.job_number}` : ""}
            </Text>
            <Text
              style={styles.footerRight}
              render={({ pageNumber, totalPages }) =>
                `RESLU  ·  Page ${pageNumber} of ${totalPages}`
              }
            />
          </View>
        </Page>
      ))}
    </Document>
  );
}

export { LOGO_WHITE }; // reserved for a future dark-cover variant
