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

/**
 * Signature certificate PDF — BUILD-SPEC.md §"Built-in digital
 * signature": "generate a signature-certificate page (signer,
 * timestamp AEST, document hash, RESLU brand) ... store the stamped
 * PDF as a new immutable file (never overwrite the original)".
 *
 * No pdf-lib / pdf stamping library is available in this working copy
 * (package.json checked — only @react-pdf/renderer is present), so per
 * the task's explicit fallback instruction this renders a SEPARATE
 * branded "signature certificate" PDF via the existing React-PDF setup
 * rather than stamping a page onto the original document. It is stored
 * alongside the original (see lib/signatures.ts certificatePath()),
 * never overwriting it.
 *
 * Styling deliberately mirrors components/pdf/SchedulePdf.tsx — same
 * font-registration/fallback approach, same brand palette constants,
 * same cream header band + sand spaced-caps labels — so a signed
 * certificate looks like it belongs to the same document family as the
 * FF&E schedule PDF.
 */

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
      Font.register({ family: "Cormorant", src: CORMORANT_PATH });
      displayFontFamily = "Cormorant";
    } catch {
      displayFontFamily = "Times-Roman";
    }
  }
  Font.registerHyphenationCallback((word) => [word]);
}

const CREAM = "#EDE8DE";
const CHARCOAL = "#313131";
const NEARBLACK = "#1A1A1A";
const SAND = "#A08C72";
const LINE = "#DCD6CC";
const WHITE = "#FFFFFF";

const LOGO_BLACK = path.join(process.cwd(), "public/reslu-logo.png");

const styles = StyleSheet.create({
  page: {
    backgroundColor: WHITE,
    padding: 56,
    fontSize: 10,
    color: CHARCOAL,
  },
  logo: { width: 120, marginBottom: 36 },
  eyebrow: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 2,
    textTransform: "uppercase",
    color: SAND,
    marginBottom: 6,
  },
  title: {
    fontSize: 30,
    color: NEARBLACK,
    marginBottom: 24,
  },
  statusBand: {
    backgroundColor: CREAM,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginBottom: 28,
  },
  statusText: {
    fontSize: 12,
    color: NEARBLACK,
  },
  section: {
    marginBottom: 20,
  },
  label: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: SAND,
    marginBottom: 4,
  },
  value: {
    fontSize: 11,
    color: NEARBLACK,
  },
  mono: {
    fontSize: 8,
    color: CHARCOAL,
    fontFamily: "Helvetica",
  },
  signatureBox: {
    borderWidth: 1,
    borderColor: LINE,
    padding: 14,
    marginTop: 4,
    alignItems: "flex-start",
    justifyContent: "center",
    minHeight: 90,
  },
  signatureImage: {
    height: 70,
    objectFit: "contain",
  },
  footer: {
    position: "absolute",
    bottom: 32,
    left: 56,
    right: 56,
    borderTopWidth: 1,
    borderTopColor: LINE,
    paddingTop: 8,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: {
    fontSize: 7,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: SAND,
  },
});

export interface SignatureCertificateProps {
  projectName: string;
  clientName: string;
  documentFilename: string;
  documentSha256: string;
  signerNameTyped: string;
  /** AEST-formatted timestamp string, formatted by the caller (server). */
  signedAtAest: string;
  /** PNG bytes of the drawn signature, or a data URL — react-pdf Image
   *  accepts either a Buffer wrapped as base64 data URL, so callers pass
   *  a `data:image/png;base64,...` string. */
  signatureImageDataUrl: string;
  subjectType: "project_file" | "variation" | "sow";
  ipAddress: string | null;
}

export function SignatureCertificatePdf({
  projectName,
  clientName,
  documentFilename,
  documentSha256,
  signerNameTyped,
  signedAtAest,
  signatureImageDataUrl,
  subjectType,
  ipAddress,
}: SignatureCertificateProps) {
  ensureFonts();

  const subjectLabel =
    subjectType === "project_file"
      ? "Document"
      : subjectType === "variation"
        ? "Variation"
        : "Scope of Works";

  return (
    <Document title={`Signature certificate — ${documentFilename}`}>
      <Page size="A4" style={styles.page}>
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <Image src={LOGO_BLACK} style={styles.logo} />

        <Text style={styles.eyebrow}>Certificate of electronic signature</Text>
        <Text style={{ ...styles.title, fontFamily: displayFontFamily }}>
          {projectName}
        </Text>

        <View style={styles.statusBand}>
          <Text style={styles.statusText}>
            Signed by {signerNameTyped} on {signedAtAest}
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Client</Text>
          <Text style={styles.value}>{clientName}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>{subjectLabel}</Text>
          <Text style={styles.value}>{documentFilename}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Document SHA-256</Text>
          <Text style={styles.mono}>{documentSha256}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Signer name (typed)</Text>
          <Text style={styles.value}>{signerNameTyped}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Signed at (AEST)</Text>
          <Text style={styles.value}>{signedAtAest}</Text>
        </View>

        {ipAddress ? (
          <View style={styles.section}>
            <Text style={styles.label}>IP address</Text>
            <Text style={styles.mono}>{ipAddress}</Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.label}>Drawn signature</Text>
          <View style={styles.signatureBox}>
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <Image src={signatureImageDataUrl} style={styles.signatureImage} />
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>RESLU · Signature certificate</Text>
          <Text style={styles.footerText}>{signedAtAest}</Text>
        </View>
      </Page>
    </Document>
  );
}
