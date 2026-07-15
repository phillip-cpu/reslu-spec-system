import assert from "node:assert/strict";
import test from "node:test";
import {
  invoiceCandidateAttachmentHashes,
  invoiceCandidateDedupeKey,
  isLikelySupplierInvoice,
} from "./invoice-candidates.ts";

test("detects invoice PDF filenames even when the email body is terse", () => {
  assert.equal(
    isLikelySupplierInvoice({
      subject: "Documents attached",
      clean_text: "Hi Phillip, see attached.",
      attachment_filenames: ["Tax Invoice INV-88213.pdf"],
    }),
    true
  );
});

test("requires invoice evidence rather than any email containing a dollar amount", () => {
  assert.equal(
    isLikelySupplierInvoice({
      subject: "Quote for vanity",
      clean_text: "Our quote is $2,850 including GST.",
    }),
    false
  );
  assert.equal(
    isLikelySupplierInvoice({
      subject: "Tax invoice INV-88213",
      clean_text: "Total due $2,850.00",
    }),
    true
  );
});

test("deduplicates forwarded invoice candidates by attachment hash", () => {
  const hash = "a".repeat(64);
  assert.equal(
    invoiceCandidateDedupeKey("original-email", [hash]),
    invoiceCandidateDedupeKey("forwarded-email", [hash])
  );
  assert.equal(
    invoiceCandidateDedupeKey("legacy-email", []),
    "invoice_candidate:legacy-email"
  );
});

test("does not use repeated signature images as invoice fingerprints", () => {
  const logoHash = "b".repeat(64);
  const invoiceHash = "c".repeat(64);
  assert.deepEqual(
    invoiceCandidateAttachmentHashes([
      { filename: "reslu-logo.png", mime: "image/png", content_sha256: logoHash },
      {
        filename: "INVOICE_W288707086-1_99886501.pdf",
        mime: "application/pdf",
        content_sha256: invoiceHash,
      },
    ]),
    [invoiceHash]
  );
});
