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
import type { Project, SowSectionWithLines } from "@/types";

// ── fonts (registered once) ─────────────────────────────────
// Same registration approach as components/pdf/SchedulePdf.tsx — falls
// back to the built-in Times-Roman rather than throwing if the
// Cormorant TTF isn't present at render time. Deliberately duplicated
// (not shared) rather than importing from SchedulePdf.tsx, since that
// module's fontsRegistered/displayFontFamily module state would be
// entangled between two independent PDF documents otherwise, and this
// is the exact copy-paste convention the codebase already uses for two
// separate render pipelines (see BUILD-SPEC.md's "PDF: ... GET
// /api/projects/[id]/sow/[sowId]/pdf — React-PDF" instruction to reuse
// the SchedulePdf approach, not necessarily its module).
const CORMORANT_PATH = path.join(
  process.cwd(),
  "public/fonts/CormorantGaramond.ttf"
);

let fontsRegistered = false;
let displayFontFamily = "Times-Roman";

function ensureFonts() {
  if (fontsRegistered) return;
  fontsRegistered = true;

  if (fs.existsSync(CORMORANT_PATH)) {
    try {
      Font.register({ family: "Cormorant-SOW", src: CORMORANT_PATH });
      displayFontFamily = "Cormorant-SOW";
    } catch {
      displayFontFamily = "Times-Roman";
    }
  }
  Font.registerHyphenationCallback((word) => [word]);
}

// Brand palette (BUILD-SPEC.md §Brand) — identical values to SchedulePdf.tsx.
const CREAM = "#EDE8DE";
const CHARCOAL = "#313131";
const NEARBLACK = "#1A1A1A";
const SAND = "#A08C72";
const LINE = "#DCD6CC";
const WHITE = "#FFFFFF";

const LOGO_BLACK = path.join(process.cwd(), "public/reslu-logo.png");

const PAGE_MARGIN_H = 40; // pt

const styles = StyleSheet.create({
  // ── Cover page — per docs-sow-reference.docx: title, project
  // name/description, then a Project/Client/Project No./Date/Issue
  // block, per BUILD-SPEC.md "cover per the .dotx reference (logo,
  // 'Scope of Works', project name/description, Project/Client/Project
  // No./Date/Issue block)". ──
  cover: {
    backgroundColor: CREAM,
    padding: 64,
    flexDirection: "column",
    justifyContent: "space-between",
    height: "100%",
  },
  coverLogo: { width: 160 },
  coverEyebrow: {
    fontSize: 9,
    letterSpacing: 2,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    color: SAND,
    marginBottom: 10,
  },
  coverTitle: { fontSize: 44, color: NEARBLACK },
  coverDescription: {
    fontSize: 12,
    color: CHARCOAL,
    marginTop: 10,
    lineHeight: 1.5,
  },
  coverMetaBlock: {
    borderTopWidth: 1,
    borderTopColor: NEARBLACK,
    paddingTop: 14,
  },
  coverMetaRow: {
    flexDirection: "row",
    marginBottom: 4,
  },
  coverMetaLabel: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: SAND,
    width: 110,
  },
  coverMetaValue: { fontSize: 10, color: CHARCOAL },

  // ── Body pages ──
  page: {
    backgroundColor: WHITE,
    paddingTop: 70,
    paddingBottom: 56,
    paddingHorizontal: PAGE_MARGIN_H,
    fontSize: 9.5,
    color: CHARCOAL,
  },
  headerBand: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 48,
    backgroundColor: CREAM,
    paddingHorizontal: PAGE_MARGIN_H,
    paddingVertical: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: NEARBLACK,
  },
  headerMeta: {
    fontSize: 8,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: SAND,
  },

  sectionHeading: {
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 2,
    textTransform: "uppercase",
    color: SAND,
    borderBottomWidth: 1,
    borderBottomColor: NEARBLACK,
    paddingBottom: 4,
    marginTop: 18,
    marginBottom: 8,
  },

  lineRow: {
    flexDirection: "row",
    marginBottom: 4,
    paddingLeft: 4,
  },
  lineBullet: { width: 12, fontSize: 9.5, color: SAND },
  lineText: { flex: 1, fontSize: 9.5, color: CHARCOAL, lineHeight: 1.45 },

  exclusionsBlock: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: CREAM,
    padding: 10,
  },
  exclusionsLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: SAND,
    marginBottom: 6,
  },

  noteText: {
    fontSize: 9,
    fontStyle: "italic",
    color: CHARCOAL,
    lineHeight: 1.45,
  },

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
  footerText: {
    fontSize: 7,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: SAND,
  },
});

interface Props {
  project: Pick<Project, "name" | "client_name" | "address">;
  sections: SowSectionWithLines[];
  revisionLabel: string;
  status: "draft" | "issued";
  issuedAt: string | null;
  projectNo: string;
  generatedAt: string; // formatted date, passed in (server)
}

/**
 * SOW branded PDF (BUILD-SPEC.md "Scope of Works builder"): cover
 * matches docs-sow-reference.docx's placeholder structure (PROJECT
 * NAME, DESCRIPTION, ADDRESS, CLIENT NAME, PROJECT NO., DATE, ISSUE
 * STATUS), body renders sections as sand spaced-caps headings —
 * inclusions as a clean bulleted list, exclusions grouped under a
 * distinct cream-panel treatment, notes in italic — footer styled like
 * SchedulePdf's.
 *
 * `project.address` doubles as the reference template's DESCRIPTION
 * placeholder for now — there is no separate project "description"
 * field in the schema (BUILD-SPEC.md's Project shape has name/
 * client_name/address only); using the address keeps the cover
 * non-empty without inventing a new column this release.
 */
export function SowPdf({
  project,
  sections,
  revisionLabel,
  status,
  issuedAt,
  projectNo,
  generatedAt,
}: Props) {
  ensureFonts();

  const issueStatusLabel = status === "issued" ? `Issued — ${revisionLabel}` : `Draft — ${revisionLabel}`;
  const dateLabel = issuedAt
    ? new Date(issuedAt).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })
    : generatedAt;

  return (
    <Document title={`${project.name} — Scope of Works ${revisionLabel}`}>
      {/* Cover */}
      <Page size="A4" style={styles.cover}>
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <Image src={LOGO_BLACK} style={styles.coverLogo} />

        <View>
          <Text style={styles.coverEyebrow}>Scope of Works</Text>
          <Text style={{ ...styles.coverTitle, fontFamily: displayFontFamily }}>
            {project.name}
          </Text>
          {project.address ? (
            <Text style={styles.coverDescription}>{project.address}</Text>
          ) : null}
        </View>

        <View style={styles.coverMetaBlock}>
          <View style={styles.coverMetaRow}>
            <Text style={styles.coverMetaLabel}>Project</Text>
            <Text style={styles.coverMetaValue}>{project.name}</Text>
          </View>
          <View style={styles.coverMetaRow}>
            <Text style={styles.coverMetaLabel}>Client</Text>
            <Text style={styles.coverMetaValue}>{project.client_name}</Text>
          </View>
          <View style={styles.coverMetaRow}>
            <Text style={styles.coverMetaLabel}>Project No.</Text>
            <Text style={styles.coverMetaValue}>{projectNo}</Text>
          </View>
          <View style={styles.coverMetaRow}>
            <Text style={styles.coverMetaLabel}>Date</Text>
            <Text style={styles.coverMetaValue}>{dateLabel}</Text>
          </View>
          <View style={styles.coverMetaRow}>
            <Text style={styles.coverMetaLabel}>Issue</Text>
            <Text style={styles.coverMetaValue}>{issueStatusLabel}</Text>
          </View>
        </View>
      </Page>

      {/* Body */}
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.headerBand} fixed>
          <Text style={styles.headerTitle}>{project.name} — Scope of Works</Text>
          <Text style={styles.headerMeta}>
            RESLU · {revisionLabel} · {generatedAt}
          </Text>
        </View>

        {sections.map((section) => {
          const inclusions = section.lines.filter((l) => l.kind === "inclusion");
          const exclusions = section.lines.filter((l) => l.kind === "exclusion");
          const notes = section.lines.filter((l) => l.kind === "note");

          return (
            <View key={section.id} wrap={false}>
              <Text style={styles.sectionHeading}>{section.heading}</Text>

              {inclusions.map((line) => (
                <View key={line.id} style={styles.lineRow}>
                  <Text style={styles.lineBullet}>—</Text>
                  <Text style={styles.lineText}>{line.text}</Text>
                </View>
              ))}

              {exclusions.length > 0 && (
                <View style={styles.exclusionsBlock}>
                  <Text style={styles.exclusionsLabel}>Exclusions</Text>
                  {exclusions.map((line) => (
                    <View key={line.id} style={styles.lineRow}>
                      <Text style={styles.lineBullet}>—</Text>
                      <Text style={styles.lineText}>{line.text}</Text>
                    </View>
                  ))}
                </View>
              )}

              {notes.map((line) => (
                <Text key={line.id} style={[styles.noteText, { marginTop: 6 }]}>
                  {line.text}
                </Text>
              ))}
            </View>
          );
        })}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {project.name} / Scope of Works / {revisionLabel}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) =>
              `RESLU  ·  Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}
