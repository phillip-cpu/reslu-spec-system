import { Fragment } from "react";
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
import type { Project } from "@/types";
import type { SowLineWithTrade, SowSectionWithTradedLines } from "@/types/sow-trade-tags";
import { groupSowLinesByTrade, isGeneralNotesHeading } from "@/lib/sow-trade-tags";

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
  // "Trade-scoped SOW extracts" round — the one cover addition an
  // extract gets (BUILD-SPEC.md: "cover marked '{Trade} scope —
  // extract of {title} · Rev N' (subtitle line; cover otherwise
  // unchanged)"). Sits directly under coverDescription, above the
  // meta block — every other cover element (logo, eyebrow, title,
  // address, meta rows) is untouched.
  coverExtractSubtitle: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: SAND,
    marginTop: 10,
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

  tradeHeading: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: NEARBLACK,
    borderBottomWidth: 0.5,
    borderBottomColor: LINE,
    paddingBottom: 3,
    marginTop: 10,
    marginBottom: 6,
    marginLeft: 4,
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
  sections: SowSectionWithTradedLines[];
  revisionLabel: string;
  status: "draft" | "issued";
  issuedAt: string | null;
  projectNo: string;
  generatedAt: string; // formatted date, passed in (server)
  /**
   * "Trade-scoped SOW extracts" round — set when this render is a
   * trade-filtered extract, not the full SOW. `sections` is already
   * filtered by the caller (lib/sow-trade-tags.ts's
   * filterSectionsForTrade()) before it ever reaches this component —
   * this prop drives the cover subtitle and suppresses redundant trade
   * subheadings in a PDF whose lines are already filtered to one trade.
   * Omitted/null for the full SOW, where trade groups are shown.
   */
  extractTrade?: string | null;
}

// Linked rooms and custom area sections start fresh. Standard document
// introductions and closing clauses retain their continuous flow.
function isAreaSection(section: SowSectionWithTradedLines) {
  if (section.source_room_id) return true;
  const heading = section.heading.trim();
  return !isGeneralNotesHeading(heading) &&
    !/^(project overview|general \/ preliminaries|site management(?: & handover)?|exclusions|assumptions)$/i.test(heading);
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
  extractTrade,
}: Props) {
  ensureFonts();

  const issueStatusLabel = status === "issued" ? `Issued — ${revisionLabel}` : `Draft — ${revisionLabel}`;
  const dateLabel = issuedAt
    ? new Date(issuedAt).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })
    : generatedAt;

  function renderLines(lines: SowLineWithTrade[]) {
    const inclusions = lines.filter((line) => line.kind === "inclusion");
    const exclusions = lines.filter((line) => line.kind === "exclusion");
    const notes = lines.filter((line) => line.kind === "note");

    return [
      ...inclusions.map((line) => (
        <View key={line.id} style={styles.lineRow} wrap={false}>
          <Text style={styles.lineBullet}>—</Text>
          <Text style={styles.lineText}>{line.text}</Text>
        </View>
      )),

      ...(exclusions.length > 0 ? [(
        <View key="exclusions" style={styles.exclusionsBlock} wrap={false}>
          <Text style={styles.exclusionsLabel}>Exclusions</Text>
          {exclusions.map((line) => (
            <View key={line.id} style={styles.lineRow} wrap={false}>
              <Text style={styles.lineBullet}>—</Text>
              <Text style={styles.lineText}>{line.text}</Text>
            </View>
          ))}
        </View>
      )] : []),

      ...notes.map((line) => (
        <Text key={line.id} style={[styles.noteText, { marginTop: 6 }]}>
          {line.text}
        </Text>
      )),
    ];
  }

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
          {extractTrade ? (
            <Text style={styles.coverExtractSubtitle}>
              {extractTrade} scope — extract of {project.name} · Rev {revisionLabel}
            </Text>
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

        {sections.map((section, sectionIndex) => {
          const startOnNewPage = sectionIndex > 0 && isAreaSection(section);
          const lineGroups = extractTrade
            ? [{ trade: null, lines: section.lines }]
            : groupSowLinesByTrade(section.lines);
          const hasTradeGroups = lineGroups.some((group) => group.trade !== null);

          return (
            // Keep only the heading(s) and first rendered block together.
            // Whole sections/trade groups must remain breakable: long rooms
            // can span several pages. A fixed minPresenceAhead allowance
            // cannot account for a multi-line first row moving independently.
            // Fragments keep these blocks as Page children; nested breakable
            // Views can retain an empty split and create a trailing blank page.
            <Fragment key={section.id}>
              {lineGroups.length === 0 ? (
                <Text style={styles.sectionHeading} break={startOnNewPage}>{section.heading}</Text>
              ) : null}
              {lineGroups.map((group, groupIndex) => {
                const [firstBlock, ...remainingBlocks] = renderLines(group.lines);
                return (
                  <Fragment key={group.trade ?? `untagged-${groupIndex}`}>
                    <View
                      wrap={false}
                      break={startOnNewPage && groupIndex === 0}
                      minPresenceAhead={firstBlock?.type === Text ? 24 : 0}
                    >
                      {groupIndex === 0 ? (
                        <Text style={styles.sectionHeading}>{section.heading}</Text>
                      ) : null}
                      {group.trade || (!extractTrade && hasTradeGroups) ? (
                        <Text style={styles.tradeHeading}>
                          {group.trade ?? "General"}
                        </Text>
                      ) : null}
                      {firstBlock?.type === Text ? null : firstBlock}
                    </View>
                    {/* Notes can exceed a page; keep their opening lines with
                        the heading while allowing the rest to wrap. */}
                    {firstBlock?.type === Text ? firstBlock : null}
                    {remainingBlocks}
                  </Fragment>
                );
              })}
            </Fragment>
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
