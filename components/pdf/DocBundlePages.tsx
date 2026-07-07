import fs from "node:fs";
import path from "node:path";
import { Document, Page, View, Text, Font, StyleSheet } from "@react-pdf/renderer";

// ── fonts ────────────────────────────────────────────────────
// Same Cormorant-with-Times-Roman-fallback approach as
// components/pdf/SchedulePdf.tsx — this module renders standalone
// (its own <Document>, merged into the bundle by lib/pdf-bundle.ts
// afterwards via pdf-lib), so it registers its own copy rather than
// importing SchedulePdf's module-private state.
const CORMORANT_PATH = path.join(process.cwd(), "public/fonts/CormorantGaramond.ttf");

let fontsRegistered = false;
let displayFontFamily = "Times-Roman";

function ensureFonts() {
  if (fontsRegistered) return;
  fontsRegistered = true;
  if (fs.existsSync(CORMORANT_PATH)) {
    try {
      Font.register({ family: "Cormorant", src: CORMORANT_PATH });
      displayFontFamily = "Cormorant";
    } catch {
      displayFontFamily = "Times-Roman";
    }
  }
  Font.registerHyphenationCallback((word) => [word]);
}

// Brand palette — identical literals to SchedulePdf.tsx (BUILD-SPEC.md §Brand).
const CREAM = "#EDE8DE";
const CHARCOAL = "#313131";
const NEARBLACK = "#1A1A1A";
const SAND = "#A08C72";

const styles = StyleSheet.create({
  separatorPage: {
    backgroundColor: CREAM,
    padding: 64,
    flexDirection: "column",
    justifyContent: "center",
    height: "100%",
  },
  separatorEyebrow: {
    fontSize: 9,
    letterSpacing: 2,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    color: SAND,
    marginBottom: 10,
  },
  separatorTitle: {
    fontSize: 30,
    color: NEARBLACK,
    marginBottom: 8,
  },
  separatorSub: {
    fontSize: 11,
    color: CHARCOAL,
  },

  indexPage: {
    backgroundColor: "#FFFFFF",
    padding: 48,
    fontSize: 10,
    color: CHARCOAL,
  },
  indexTitle: {
    fontSize: 22,
    color: NEARBLACK,
    marginBottom: 4,
  },
  indexSub: {
    fontSize: 9,
    letterSpacing: 1.5,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    color: SAND,
    marginBottom: 20,
  },
  indexRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#DCD6CC",
    paddingVertical: 6,
  },
  indexRowLabel: { fontSize: 10, color: NEARBLACK },
  indexRowNote: { fontSize: 9, color: SAND, fontStyle: "italic" },
});

/**
 * One per-item separator page — "TW-01 — Melbourne Robe Hook — Spec
 * sheet" per BUILD-SPEC.md "Export + board batch" item 3. Rendered via
 * React-PDF (the simpler of the two reliable paths this task's brief
 * offered — see lib/pdf-bundle.ts's own doc comment for why React-PDF
 * was chosen over hand-drawing text with pdf-lib) as its own single-
 * page <Document>, then merged into the final bundle alongside the
 * schedule and each item's own attached PDFs by lib/pdf-bundle.ts's
 * pdf-lib merge step.
 */
export function DocSeparatorPage({
  itemCode,
  itemName,
  docLabel,
}: {
  itemCode: string | null;
  itemName: string;
  docLabel: string; // e.g. "Spec sheet" / "Install manual"
}) {
  ensureFonts();
  const heading = [itemCode, itemName].filter(Boolean).join(" — ");
  return (
    <Document title={`${heading} — ${docLabel}`}>
      <Page size="A4" style={styles.separatorPage}>
        <Text style={styles.separatorEyebrow}>RESLU · FF&amp;E Documents</Text>
        <Text style={{ ...styles.separatorTitle, fontFamily: displayFontFamily }}>{heading}</Text>
        <Text style={styles.separatorSub}>{docLabel}</Text>
      </Page>
    </Document>
  );
}

export interface DocsIndexRow {
  itemCode: string | null;
  itemName: string;
  /** e.g. "Spec sheet — image, not printable — view in app" or "Install manual — could not be retrieved". */
  note: string;
}

/**
 * Final "Documents index" page — BUILD-SPEC.md "Export + board batch"
 * item 3: non-PDF attachments and per-file failures are listed here
 * ("not printable — view in app") rather than silently dropped, so the
 * bundle recipient knows a document exists even when it isn't merged
 * in. Rendered even when `rows` is empty (simplifies the caller — no
 * conditional Document assembly needed) but the caller should skip
 * adding this page's bytes to the bundle when there's nothing to list.
 */
export function DocsIndexPage({ rows }: { rows: DocsIndexRow[] }) {
  ensureFonts();
  return (
    <Document title="Documents index">
      <Page size="A4" style={styles.indexPage}>
        <Text style={{ ...styles.indexTitle, fontFamily: displayFontFamily }}>Documents index</Text>
        <Text style={styles.indexSub}>Not merged into this bundle</Text>
        {rows.map((row, i) => (
          <View key={i} style={styles.indexRow}>
            <Text style={styles.indexRowLabel}>
              {[row.itemCode, row.itemName].filter(Boolean).join(" — ")}
            </Text>
            <Text style={styles.indexRowNote}>{row.note}</Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}
