import fs from "node:fs";
import path from "node:path";
import { Document, Page, View, Text, Image, StyleSheet, Font } from "@react-pdf/renderer";
import type { Proposal } from "@/types/proposals";
import { TIMELINE_COUNCIL_CAVEAT } from "@/lib/proposal-templates";

// ============================================================
// RESLU Spec System — Fee proposal phase (r23) — signed ProposalPdf.
// BUILD-SPEC.md item 4: "signed ProposalPdf (@react-pdf, Neave layout:
// cover/letter/vision/scope/fees/timeline/exclusions/terms/signature
// page)". Rendered ONCE by POST /api/proposal/[token]/accept, straight
// after the signature evidence is stamped onto the row, then stored in
// the private `assets` bucket (see lib/proposals.ts's
// proposalPdfPath()) and emailed to the client + phillip@reslu.com.au.
//
// Font/logo registration + brand palette deliberately duplicated from
// components/pdf/InvoicePdf.tsx / SowPdf.tsx (this codebase's own
// stated house convention — each PDF module owns its own Font.register
// module state rather than sharing it across independent render
// pipelines; see either file's own header comment for the reasoning).
//
// Pagination: per SowPdf.tsx's own documented lesson ("Root cause of
// the overlapping-text bug: [a] section container was wrap={false} —
// an unbreakable block ... Fix: let the section flow/paginate normally
// ... protect only the heading from being orphaned ... via
// minPresenceAhead"), NO section/list here is wrapped unbreakable —
// only single short rows (a bullet line, a milestone line, a timeline
// row) get wrap={false}, and every section heading gets
// minPresenceAhead so it never sits alone at the bottom of a page.
// ============================================================

const CORMORANT_PATH = path.join(process.cwd(), "public/fonts/CormorantGaramond.ttf");

let fontsRegistered = false;
let displayFontFamily = "Times-Roman";

function ensureFonts() {
  if (fontsRegistered) return;
  fontsRegistered = true;
  if (fs.existsSync(CORMORANT_PATH)) {
    try {
      Font.register({ family: "Cormorant-Proposal", src: CORMORANT_PATH });
      displayFontFamily = "Cormorant-Proposal";
    } catch {
      displayFontFamily = "Times-Roman";
    }
  }
  Font.registerHyphenationCallback((word) => [word]);
}

// Brand palette (BUILD-SPEC.md §Brand) — identical values to
// InvoicePdf.tsx/SowPdf.tsx/SignatureCertificatePdf.tsx.
const CREAM = "#EDE8DE";
const CHARCOAL = "#313131";
const NEARBLACK = "#1A1A1A";
const SAND = "#A08C72";
const LINE = "#DCD6CC";
const WHITE = "#FFFFFF";

const LOGO_BLACK = path.join(process.cwd(), "public/reslu-logo.png");

const PAGE_MARGIN_H = 44;

const styles = StyleSheet.create({
  cover: {
    backgroundColor: NEARBLACK,
    color: WHITE,
    padding: 56,
    justifyContent: "space-between",
  },
  coverLogo: { width: 130 },
  coverEyebrow: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 3,
    textTransform: "uppercase",
    color: SAND,
    marginBottom: 10,
  },
  coverTitle: { fontSize: 34, color: WHITE, lineHeight: 1.15, marginBottom: 8 },
  coverResidence: { fontSize: 14, color: "#D8D2C4", marginBottom: 4 },
  coverDate: { fontSize: 10, color: "#A9A29A", marginTop: 24 },

  page: {
    backgroundColor: WHITE,
    paddingTop: 44,
    paddingBottom: 56,
    paddingHorizontal: PAGE_MARGIN_H,
    fontSize: 9.5,
    color: CHARCOAL,
  },
  headerBand: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    paddingBottom: 8,
    marginBottom: 22,
  },
  headerTitle: { fontSize: 8, letterSpacing: 1.5, textTransform: "uppercase", color: SAND },
  headerMeta: { fontSize: 8, letterSpacing: 1, textTransform: "uppercase", color: SAND },

  sectionHeading: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: NEARBLACK,
    marginTop: 20,
    marginBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: SAND,
    paddingBottom: 6,
  },
  subHeading: {
    fontSize: 10.5,
    color: NEARBLACK,
    fontFamily: displayFontFamily,
    marginTop: 12,
    marginBottom: 4,
  },
  paragraph: { fontSize: 9.5, color: CHARCOAL, lineHeight: 1.55, marginBottom: 8 },
  italicNote: { fontSize: 8.5, color: CHARCOAL, fontStyle: "italic", lineHeight: 1.5, marginTop: 6 },

  bulletRow: { flexDirection: "row", marginBottom: 4, paddingRight: 8 },
  bulletMark: { width: 12, fontSize: 9.5, color: SAND },
  bulletText: { flex: 1, fontSize: 9.5, color: CHARCOAL, lineHeight: 1.5 },

  deliverablesLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: SAND,
    marginTop: 6,
    marginBottom: 3,
  },
  deliverableRow: { flexDirection: "row", marginBottom: 3 },
  deliverableArrow: { width: 14, fontSize: 9, color: SAND },
  deliverableText: { flex: 1, fontSize: 9, color: CHARCOAL, lineHeight: 1.4 },

  stageBlock: { marginBottom: 12 },
  stageHeadRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: NEARBLACK,
    paddingBottom: 4,
    marginBottom: 6,
  },
  stageLabel: { fontSize: 10.5, fontFamily: "Helvetica-Bold", color: NEARBLACK },
  stageTotal: { fontSize: 10.5, fontFamily: "Helvetica-Bold", color: NEARBLACK },
  milestoneRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
  milestoneLabel: { fontSize: 9, color: CHARCOAL },
  milestoneAmount: { fontSize: 9, color: CHARCOAL },

  grandTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: NEARBLACK,
  },
  grandTotalLabel: { fontSize: 11, fontFamily: "Helvetica-Bold", color: NEARBLACK },
  grandTotalValue: { fontSize: 11, fontFamily: "Helvetica-Bold", color: NEARBLACK },
  depositRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  depositLabel: { fontSize: 9, color: SAND },
  depositValue: { fontSize: 9, color: SAND },

  timelineTable: { marginTop: 4 },
  timelineHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: NEARBLACK,
    paddingBottom: 5,
    marginBottom: 6,
  },
  timelineHeaderPhase: { flex: 1, fontSize: 7, fontFamily: "Helvetica-Bold", letterSpacing: 1.2, textTransform: "uppercase", color: SAND },
  timelineHeaderDuration: { width: 170, fontSize: 7, fontFamily: "Helvetica-Bold", letterSpacing: 1.2, textTransform: "uppercase", color: SAND },
  timelineRow: { flexDirection: "row", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: LINE },
  timelinePhase: { flex: 1, fontSize: 9.5, color: CHARCOAL, paddingRight: 10 },
  timelineDuration: { width: 170, fontSize: 9.5, color: CHARCOAL },

  allowanceBlock: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: CREAM,
    padding: 12,
  },

  termsHeading: { fontSize: 8.5, fontFamily: "Helvetica-Bold", letterSpacing: 1.2, textTransform: "uppercase", color: SAND, marginTop: 12, marginBottom: 3 },
  termsBody: { fontSize: 8.5, color: CHARCOAL, lineHeight: 1.5, marginBottom: 4 },

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
  footerText: { fontSize: 7, letterSpacing: 1, textTransform: "uppercase", color: SAND },

  // ── Signature page ──
  sigPage: { backgroundColor: WHITE, padding: 56, fontSize: 9.5, color: CHARCOAL },
  sigEyebrow: { fontSize: 8, fontFamily: "Helvetica-Bold", letterSpacing: 2, textTransform: "uppercase", color: SAND, marginBottom: 8 },
  sigTitle: { fontSize: 22, color: NEARBLACK, marginBottom: 24 },
  partyBlock: { marginBottom: 30 },
  partyLabel: { fontSize: 7, fontFamily: "Helvetica-Bold", letterSpacing: 1.5, textTransform: "uppercase", color: SAND, marginBottom: 6 },
  partyName: { fontSize: 12, color: NEARBLACK, marginBottom: 10 },
  signatureBox: {
    borderWidth: 1,
    borderColor: LINE,
    padding: 12,
    minHeight: 80,
    justifyContent: "center",
    marginBottom: 8,
  },
  signatureImage: { height: 64, objectFit: "contain" },
  typedSignature: { fontSize: 24, fontFamily: displayFontFamily, color: NEARBLACK },
  sigMetaRow: { flexDirection: "row", marginTop: 4 },
  sigMetaLabel: { width: 90, fontSize: 8, fontFamily: "Helvetica-Bold", letterSpacing: 0.5, textTransform: "uppercase", color: SAND },
  sigMetaValue: { fontSize: 9.5, color: NEARBLACK },
});

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

/** Splits a plain-text block on blank lines into paragraphs — same
 * "no markdown renderer, render as preformatted paragraphs" approach
 * as the client page's own terms rendering (lib/proposal-templates.ts's
 * DEFAULT_TERMS_MD header comment). A short (<60 char), fully-uppercase
 * paragraph is treated as a section heading (matches DEFAULT_TERMS_MD's
 * own "ALL-CAPS section headings, blank-line-separated paragraphs"
 * shape) and styled accordingly; everything else renders as body text. */
function splitTermsParagraphs(md: string): { heading: boolean; text: string }[] {
  return md
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({
      heading: p.length < 60 && p === p.toUpperCase() && /[A-Z]/.test(p) && !p.includes("."),
      text: p,
    }));
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

interface Props {
  proposal: Proposal;
  residence: string;
  address: string | null;
  clientName: string;
  /** "11 July 2026" — server-formatted, per house convention (SowPdf.tsx/InvoicePdf.tsx both format dates server-side). */
  coverDateLabel: string;
  signedDateLabel: string;
}

/**
 * The signed RESLU fee proposal — cover, letter, vision, scope of
 * design services, design fee + payment structure, project timeline,
 * exclusions, terms, and a final signature page. Rendered exactly once
 * (see this file's own header comment) from the accepted proposal's
 * content jsonb + signature evidence — never before acceptance (the
 * client page's own "Live preview" is plain HTML, not this component;
 * see app/proposal/[token]/page.tsx).
 */
export function ProposalPdf({ proposal, residence, address, clientName, coverDateLabel, signedDateLabel }: Props) {
  ensureFonts();
  const content = proposal.content;
  const sig = proposal.signature;

  return (
    <Document title={`RESLU Design Proposal — ${residence}`}>
      {/* Cover */}
      <Page size="A4" style={styles.cover}>
        <View>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_BLACK} style={styles.coverLogo} />
        </View>
        <View>
          <Text style={styles.coverEyebrow}>Design Proposal</Text>
          <Text style={{ ...styles.coverTitle, fontFamily: displayFontFamily }}>
            {clientName} | DESIGN PROPOSAL
          </Text>
          <Text style={styles.coverResidence}>{residence}</Text>
          {address ? <Text style={styles.coverResidence}>{address}</Text> : null}
          <Text style={styles.coverDate}>{coverDateLabel}</Text>
        </View>
      </Page>

      {/* Body */}
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.headerBand} fixed>
          <Text style={styles.headerTitle}>
            Architectural Design Services Proposal{address ? ` | ${address}` : ""}
          </Text>
          <Text style={styles.headerMeta}>RESLU · {residence}</Text>
        </View>

        {/* Letter */}
        <Text style={styles.sectionHeading} minPresenceAhead={32}>
          Letter
        </Text>
        {splitParagraphs(content.letter).map((p, i) => (
          <Text key={i} style={styles.paragraph}>
            {p}
          </Text>
        ))}

        {/* Vision */}
        <Text style={styles.sectionHeading} minPresenceAhead={32}>
          Project Vision Alignment
        </Text>
        {splitParagraphs(content.vision).map((p, i) => (
          <Text key={i} style={styles.paragraph}>
            {p}
          </Text>
        ))}

        {/* Scope */}
        <Text style={styles.sectionHeading} minPresenceAhead={32}>
          Scope of Design Services
        </Text>
        {content.scope_sections.map((section, si) => (
          <View key={si}>
            <Text style={{ ...styles.subHeading, fontFamily: displayFontFamily }} minPresenceAhead={24}>
              {section.title}
            </Text>
            {section.intro ? <Text style={styles.paragraph}>{section.intro}</Text> : null}
            {section.bullets.map((b, bi) => (
              <View key={bi} style={styles.bulletRow} wrap={false}>
                <Text style={styles.bulletMark}>—</Text>
                <Text style={styles.bulletText}>{b}</Text>
              </View>
            ))}
            {section.deliverables.length > 0 ? (
              <>
                <Text style={styles.deliverablesLabel}>Deliverables</Text>
                {section.deliverables.map((d, di) => (
                  <View key={di} style={styles.deliverableRow} wrap={false}>
                    <Text style={styles.deliverableArrow}>→</Text>
                    <Text style={styles.deliverableText}>{d}</Text>
                  </View>
                ))}
              </>
            ) : null}
          </View>
        ))}

        {/* Design fee */}
        <Text style={styles.sectionHeading} minPresenceAhead={32}>
          Design Fee
        </Text>
        {content.fees.stages.map((stage, sti) => (
          // A stage block is NOT wrap={false} — a stage can legitimately
          // carry many milestone rows (see the multi-phase template's
          // Stage 1: five milestones), and per SowPdf.tsx's own
          // documented "overlapping text" lesson, an unbreakable
          // container around a variable-length list is exactly the bug
          // shape to avoid. Only the heading row (2 short Text nodes)
          // and each individual milestone row are wrap={false}; the
          // heading also carries minPresenceAhead so it's never orphaned
          // alone at the bottom of a page.
          <View key={sti} style={styles.stageBlock}>
            <View style={styles.stageHeadRow} wrap={false}>
              <Text style={styles.stageLabel}>{stage.label}</Text>
              <Text style={styles.stageTotal}>{formatMoney(stage.total_inc)} Inc GST</Text>
            </View>
            {stage.milestones.map((m, mi) => (
              <View key={mi} style={styles.milestoneRow} wrap={false}>
                <Text style={styles.milestoneLabel}>{m.label}</Text>
                <Text style={styles.milestoneAmount}>{formatMoney(m.amount_inc)}</Text>
              </View>
            ))}
          </View>
        ))}
        {content.fees.payment_lines.length > 0 ? (
          // Not wrap={false} on the outer container — same "don't make a
          // variable-length list unbreakable" reasoning as the stage
          // block fix above; only each individual line is atomic.
          <View>
            <Text style={styles.deliverablesLabel}>Payment Structure</Text>
            {content.fees.payment_lines.map((line, li) => (
              <View key={li} style={styles.bulletRow} wrap={false}>
                <Text style={styles.bulletMark}>—</Text>
                <Text style={styles.bulletText}>{line}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.grandTotalRow} wrap={false}>
          <Text style={styles.grandTotalLabel}>Total Design Fee (Inc GST)</Text>
          <Text style={styles.grandTotalValue}>{formatMoney(proposal.total_inc)}</Text>
        </View>
        <View style={styles.depositRow} wrap={false}>
          <Text style={styles.depositLabel}>Deposit payable on acceptance</Text>
          <Text style={styles.depositValue}>{formatMoney(proposal.deposit_inc)}</Text>
        </View>

        {/* Timeline */}
        <Text style={styles.sectionHeading} minPresenceAhead={32}>
          Project Timeline
        </Text>
        <View style={styles.timelineTable}>
          <View style={styles.timelineHeaderRow}>
            <Text style={styles.timelineHeaderPhase}>Phase</Text>
            <Text style={styles.timelineHeaderDuration}>Duration</Text>
          </View>
          {content.timeline.map((row, ti) => (
            <View key={ti} style={styles.timelineRow} wrap={false}>
              <Text style={styles.timelinePhase}>{row.phase}</Text>
              <Text style={styles.timelineDuration}>{row.duration}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.italicNote}>{TIMELINE_COUNCIL_CAVEAT}</Text>

        {/* Exclusions */}
        <Text style={styles.sectionHeading} minPresenceAhead={32}>
          Exclusions &amp; Additional Consultant Services
        </Text>
        {content.exclusions.bullets.map((b, bi) => (
          <View key={bi} style={styles.bulletRow} wrap={false}>
            <Text style={styles.bulletMark}>—</Text>
            <Text style={styles.bulletText}>{b}</Text>
          </View>
        ))}
        <View style={styles.allowanceBlock} wrap={false}>
          <Text style={styles.paragraph}>{content.exclusions.allowance}</Text>
        </View>

        {/* Terms */}
        <Text style={styles.sectionHeading} minPresenceAhead={32}>
          Terms
        </Text>
        {splitTermsParagraphs(content.terms_md).map((p, pi) =>
          p.heading ? (
            <Text key={pi} style={styles.termsHeading} minPresenceAhead={20}>
              {p.text}
            </Text>
          ) : (
            <Text key={pi} style={styles.termsBody}>
              {p.text}
            </Text>
          )
        )}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>{residence} · RESLU Design Proposal</Text>
          <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>

      {/* Signature page */}
      <Page size="A4" style={styles.sigPage}>
        <Text style={styles.sigEyebrow}>Acceptance &amp; Signature</Text>
        <Text style={{ ...styles.sigTitle, fontFamily: displayFontFamily }}>
          Both parties agree to the terms set out in this proposal.
        </Text>

        <View style={styles.partyBlock} wrap={false}>
          <Text style={styles.partyLabel}>Client</Text>
          <Text style={styles.partyName}>{proposal.signed_name ?? clientName}</Text>
          <View style={styles.signatureBox}>
            {sig?.drawn_data_url ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <Image src={sig.drawn_data_url} style={styles.signatureImage} />
            ) : (
              <Text style={styles.typedSignature}>{sig?.typed_name ?? proposal.signed_name ?? ""}</Text>
            )}
          </View>
          <View style={styles.sigMetaRow}>
            <Text style={styles.sigMetaLabel}>Signed</Text>
            <Text style={styles.sigMetaValue}>{signedDateLabel}</Text>
          </View>
          {sig?.ip ? (
            <View style={styles.sigMetaRow}>
              <Text style={styles.sigMetaLabel}>IP address</Text>
              <Text style={styles.sigMetaValue}>{sig.ip}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.partyBlock} wrap={false}>
          <Text style={styles.partyLabel}>RESLU</Text>
          <Text style={styles.partyName}>RESLU Developments</Text>
          <View style={styles.signatureBox}>
            <Text style={{ ...styles.typedSignature, fontSize: 20 }}>Phillip Introna</Text>
          </View>
          <View style={styles.sigMetaRow}>
            <Text style={styles.sigMetaLabel}>Director</Text>
            <Text style={styles.sigMetaValue}>RESLU Developments · ABN 50 635 440 578</Text>
          </View>
          <Text style={styles.italicNote}>
            Countersigned by issuance of this proposal via the RESLU Spec System.
          </Text>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>{residence} · RESLU Design Proposal</Text>
          <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
