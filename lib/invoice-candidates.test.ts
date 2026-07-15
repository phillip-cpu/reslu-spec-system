import assert from "node:assert/strict";
import test from "node:test";
import { isLikelySupplierInvoice } from "./invoice-candidates.ts";

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
