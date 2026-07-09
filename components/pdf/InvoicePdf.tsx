import fs from "node:fs";
import path from "node:path";
import {
  Document,
  Page,
  View,
  Text,
  Image,
  Link,
  StyleSheet,
  Font,
} from "@react-pdf/renderer";
import type { ClientInvoice, InvoiceBankDetails } from "@/types/client-invoices";

// ============================================================
// RESLU Spec System — Client tax invoice PDF (design fees, phase 1).
// BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 5 + the
// approved invoice mockup description (from chat): RESLU logo
// top-left, TAX INVOICE block top-right w/ INV number + date + ABN,
// client block, line items, GST 10%, total inc GST, PAYMENT — DIRECT
// TRANSFER panel w/ BSB/Acc/Ref, optional Pay online button, footer
// "Due N days · reslu.com.au · 219 Sturt Street, Adelaide".
//
// Fonts/logo registration deliberately duplicated from
// components/pdf/SchedulePdf.tsx / SowPdf.tsx (same house convention —
// each PDF module owns its own Font.register module state rather than
// sharing it across independent render pipelines; see SowPdf.tsx's own
// header comment for why). ACTUAL logo file (public/reslu-logo.png) —
// BUILD-SPEC.md DECISIONS: "invoices use the ACTUAL logo file ... never
// a typeset wordmark".
// ============================================================

const CORMORANT_PATH = path.join(process.cwd(), "public/fonts/CormorantGaramond.ttf");

let fontsRegistered = false;
let displayFontFamily = "Times-Roman";

function ensureFonts() {
  if (fontsRegistered) return;
  fontsRegistered = true;

  if (fs.existsSync(CORMORANT_PATH)) {
    try {
      Font.register({ family: "Cormorant-Invoice", src: CORMORANT_PATH });
      displayFontFamily = "Cormorant-Invoice";
    } catch {
      displayFontFamily = "Times-Roman";
    }
  }
  Font.registerHyphenationCallback((word) => [word]);
}

// Brand palette (BUILD-SPEC.md §Brand) — identical values to
// SchedulePdf.tsx/SowPdf.tsx.
const CREAM = "#EDE8DE";
const CHARCOAL = "#313131";
const NEARBLACK = "#1A1A1A";
const SAND = "#A08C72";
const LINE = "#DCD6CC";
const WHITE = "#FFFFFF";

const LOGO_BLACK = path.join(process.cwd(), "public/reslu-logo.png");

// Tax-invoice-compliant fixed facts (BUILD-SPEC.md this round: "the
// words 'TAX INVOICE', ABN, date, GST shown"; approved mockup: "ABN 83
// 644 161 991" / footer "reslu.com.au · 219 Sturt Street, Adelaide").
const RESLU_ABN = "83 644 161 991";
const RESLU_ADDRESS = "219 Sturt Street, Adelaide";
const RESLU_WEB = "reslu.com.au";

const PAGE_MARGIN_H = 40; // pt

const styles = StyleSheet.create({
  page: {
    backgroundColor: WHITE,
    paddingTop: 40,
    paddingBottom: 56,
    paddingHorizontal: PAGE_MARGIN_H,
    fontSize: 9.5,
    color: CHARCOAL,
  },

  // ── Header: logo top-left, TAX INVOICE block top-right ──
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 28,
  },
  logo: { width: 130 },
  taxInvoiceBlock: { alignItems: "flex-end" },
  taxInvoiceTitle: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    color: NEARBLACK,
    marginBottom: 6,
  },
  taxInvoiceLine: { fontSize: 9, color: CHARCOAL, marginTop: 2 },
  taxInvoiceLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1,
    textTransform: "uppercase",
    color: SAND,
  },
  statusBadge: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: NEARBLACK,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: NEARBLACK,
  },

  // ── Client block ──
  clientBlock: {
    marginBottom: 26,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
  },
  clientLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: SAND,
    marginBottom: 4,
  },
  clientName: { fontSize: 14, color: NEARBLACK, marginBottom: 2 },
  clientLine: { fontSize: 9.5, color: CHARCOAL, lineHeight: 1.4 },

  // ── Line items table ──
  table: { marginBottom: 4 },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: NEARBLACK,
    paddingBottom: 6,
    marginBottom: 8,
  },
  tableHeaderDesc: {
    flex: 1,
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: SAND,
  },
  tableHeaderAmount: {
    width: 90,
    textAlign: "right",
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: SAND,
  },
  lineRow: {
    flexDirection: "row",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
  },
  lineDesc: { flex: 1, fontSize: 10, color: CHARCOAL, paddingRight: 12 },
  lineAmount: { width: 90, textAlign: "right", fontSize: 10, color: CHARCOAL },

  // ── Totals ──
  totalsBlock: { alignItems: "flex-end", marginTop: 14 },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: 220,
    marginBottom: 4,
  },
  totalsLabel: { fontSize: 9.5, color: CHARCOAL },
  totalsValue: { fontSize: 9.5, color: CHARCOAL },
  grandTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: 220,
    marginTop: 6,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: NEARBLACK,
  },
  grandTotalLabel: { fontSize: 11, fontFamily: "Helvetica-Bold", color: NEARBLACK },
  grandTotalValue: { fontSize: 11, fontFamily: "Helvetica-Bold", color: NEARBLACK },

  // ── Payment panel ──
  paymentPanel: {
    marginTop: 32,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: CREAM,
    padding: 16,
  },
  paymentTitle: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 2,
    textTransform: "uppercase",
    color: SAND,
    marginBottom: 10,
  },
  paymentRow: { flexDirection: "row", marginBottom: 4 },
  paymentLabel: {
    width: 110,
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1,
    textTransform: "uppercase",
    color: SAND,
  },
  paymentValue: { fontSize: 10, color: NEARBLACK },
  paymentUnconfigured: {
    fontSize: 9.5,
    fontStyle: "italic",
    color: CHARCOAL,
  },
  payOnlineButton: {
    marginTop: 14,
    alignSelf: "flex-start",
    backgroundColor: NEARBLACK,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  payOnlineText: {
    color: WHITE,
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1,
    textTransform: "uppercase",
  },

  notesBlock: { marginTop: 20 },
  notesLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: SAND,
    marginBottom: 4,
  },
  notesText: { fontSize: 9, color: CHARCOAL, lineHeight: 1.4 },

  // ── Footer ──
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
  invoice: ClientInvoice;
  bankDetails: InvoiceBankDetails | null;
  /** Formatted "Date" line — issued_at if issued, else generatedAt
   * (today), server-formatted per house convention (SchedulePdf.tsx /
   * SowPdf.tsx both format dates server-side, not in the component). */
  dateLabel: string;
}

/**
 * The branded RESLU tax invoice, per the approved mockup. Renders on
 * a single flowing body page (no separate cover — unlike
 * SchedulePdf/SowPdf, an invoice is a short, self-contained document,
 * same "one straightforward page" shape as a real-world tax invoice)
 * with a fixed footer; line items that overflow one page paginate
 * normally via react-pdf's default flow (no wrap={false} on the table,
 * matching SowPdf.tsx's fixed-the-overlap-bug lesson: never make a
 * variable-length block unbreakable).
 */
export function InvoicePdf({ invoice, bankDetails, dateLabel }: Props) {
  ensureFonts();

  const statusLabel = invoice.status.toUpperCase();

  return (
    <Document title={`RESLU Tax Invoice ${invoice.invoice_number}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_BLACK} style={styles.logo} />
          <View style={styles.taxInvoiceBlock}>
            <Text style={{ ...styles.taxInvoiceTitle, fontFamily: displayFontFamily }}>
              TAX INVOICE
            </Text>
            <Text style={styles.taxInvoiceLabel}>Invoice No.</Text>
            <Text style={styles.taxInvoiceLine}>{invoice.invoice_number}</Text>
            <Text style={[styles.taxInvoiceLabel, { marginTop: 6 }]}>Date</Text>
            <Text style={styles.taxInvoiceLine}>{dateLabel}</Text>
            <Text style={[styles.taxInvoiceLabel, { marginTop: 6 }]}>ABN</Text>
            <Text style={styles.taxInvoiceLine}>{RESLU_ABN}</Text>
            <Text style={styles.statusBadge}>{statusLabel}</Text>
          </View>
        </View>

        <View style={styles.clientBlock}>
          <Text style={styles.clientLabel}>Bill to</Text>
          <Text style={{ ...styles.clientName, fontFamily: displayFontFamily }}>
            {invoice.client_name}
          </Text>
          {invoice.client_email ? (
            <Text style={styles.clientLine}>{invoice.client_email}</Text>
          ) : null}
          {invoice.address ? <Text style={styles.clientLine}>{invoice.address}</Text> : null}
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={styles.tableHeaderDesc}>Description</Text>
            <Text style={styles.tableHeaderAmount}>Amount (ex GST)</Text>
          </View>
          {invoice.line_items.map((line, i) => (
            <View key={i} style={styles.lineRow} wrap={false}>
              <Text style={styles.lineDesc}>{line.description}</Text>
              <Text style={styles.lineAmount}>{formatMoney(line.amount_ex_gst)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totalsBlock}>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Subtotal (ex GST)</Text>
            <Text style={styles.totalsValue}>{formatMoney(invoice.subtotal_ex_gst)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>GST (10%)</Text>
            <Text style={styles.totalsValue}>{formatMoney(invoice.gst)}</Text>
          </View>
          <View style={styles.grandTotalRow}>
            <Text style={styles.grandTotalLabel}>Total (inc GST)</Text>
            <Text style={styles.grandTotalValue}>{formatMoney(invoice.total_inc_gst)}</Text>
          </View>
        </View>

        <View style={styles.paymentPanel} wrap={false}>
          <Text style={styles.paymentTitle}>Payment — Direct Transfer</Text>
          {invoice.status === "paid" || invoice.status === "void" ? (
            // A paid/voided invoice's PDF must never keep showing live
            // payment instructions or a still-clickable Stripe link —
            // a client re-opening an old emailed PDF of a since-
            // voided/already-paid invoice would otherwise be able to
            // pay it (again). The status badge above alone was not
            // enough; this panel needs its own explicit gate.
            <Text style={styles.paymentUnconfigured}>
              {invoice.status === "paid"
                ? "This invoice has been paid — no further payment is required."
                : "This invoice has been voided and is no longer payable."}
            </Text>
          ) : (
            <>
              {bankDetails ? (
                <>
                  <View style={styles.paymentRow}>
                    <Text style={styles.paymentLabel}>Account name</Text>
                    <Text style={styles.paymentValue}>{bankDetails.account_name}</Text>
                  </View>
                  <View style={styles.paymentRow}>
                    <Text style={styles.paymentLabel}>BSB</Text>
                    <Text style={styles.paymentValue}>{bankDetails.bsb}</Text>
                  </View>
                  <View style={styles.paymentRow}>
                    <Text style={styles.paymentLabel}>Account no.</Text>
                    <Text style={styles.paymentValue}>{bankDetails.account_number}</Text>
                  </View>
                  <View style={styles.paymentRow}>
                    <Text style={styles.paymentLabel}>Reference</Text>
                    <Text style={styles.paymentValue}>{invoice.invoice_number}</Text>
                  </View>
                </>
              ) : (
                <Text style={styles.paymentUnconfigured}>
                  Bank details not configured — set them in Settings before sending this
                  invoice.
                </Text>
              )}

              {/* "Pay online" — ONLY when stripe_payment_url is set (never
                  auto-created; see app/api/client-invoices/[id]/stripe-link).
                  react-pdf's Link renders a real clickable-link annotation,
                  not just styled text. */}
              {invoice.stripe_payment_url ? (
                <Link src={invoice.stripe_payment_url} style={styles.payOnlineButton}>
                  <Text style={styles.payOnlineText}>Pay online</Text>
                </Link>
              ) : null}
            </>
          )}
        </View>

        {invoice.notes ? (
          <View style={styles.notesBlock}>
            <Text style={styles.notesLabel}>Notes</Text>
            <Text style={styles.notesText}>{invoice.notes}</Text>
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Due {invoice.due_days} days · {RESLU_WEB} · {RESLU_ADDRESS}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
