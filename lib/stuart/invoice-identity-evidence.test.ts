import assert from "node:assert/strict";
import test from "node:test";
import { extractVerifiedInvoiceIdentity, formatAustralianAbn } from "./invoice-identity-evidence.ts";

test("returns a labelled, checksum-valid ABN and exact supplier-name evidence", () => {
  assert.deepEqual(
    extractVerifiedInvoiceIdentity(
      "Tax Invoice — ADJOY Investments Pty Ltd — ABN: 44 669 823 027 — Total $3,520.02",
      "ADJOY Investments Pty Ltd",
    ),
    { supplier_name_present: true, verified_abn_candidates: ["44 669 823 027"] },
  );
  assert.equal(formatAustralianAbn("44669823027"), "44 669 823 027");
});

test("rejects invalid, unlabelled and unrelated identity numbers", () => {
  const evidence = "ADJOY Investments Pty Ltd Account 44669823027 BSB 105-900 ABN 44 669 823 028";
  assert.deepEqual(extractVerifiedInvoiceIdentity(evidence, "Another Supplier Pty Ltd"), {
    supplier_name_present: false,
    verified_abn_candidates: [],
  });
});
