import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DUPLICATE_INVOICE_MESSAGE } from "./invoice-duplicates.ts";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/069_invoice_duplicate_block_and_void.sql",
    import.meta.url
  ),
  "utf8"
);
const createRoute = readFileSync(
  new URL("../app/api/projects/[id]/invoices/route.ts", import.meta.url),
  "utf8"
);
const editRoute = readFileSync(
  new URL("../app/api/invoices/[id]/route.ts", import.meta.url),
  "utf8"
);

test("duplicate identity ignores supplier spelling and blocks create/edit", () => {
  assert.equal(
    DUPLICATE_INVOICE_MESSAGE,
    "An invoice with this number, amount and date already exists"
  );
  assert.match(
    migration,
    /project_id,\s+lower\(btrim\(invoice_number\)\),\s+amount_ex_gst,\s+coalesce\(invoice_date/
  );
  assert.doesNotMatch(
    migration,
    /idx_invoices_project_number_amount_date_live[\s\S]{0,220}\bsupplier\b/
  );
  assert.match(createRoute, /find_live_invoice_duplicate/);
  assert.match(editRoute, /find_live_invoice_duplicate/);
  assert.match(createRoute, /DUPLICATE_INVOICE_MESSAGE[\s\S]+status: 409/);
  assert.match(editRoute, /DUPLICATE_INVOICE_MESSAGE[\s\S]+status: 409/);
});

test("voiding preserves invoice evidence and reverses approved allocations", () => {
  assert.match(
    migration,
    /actual_paid_ex_gst = round\(coalesce\(actual_paid_ex_gst, 0\) - v_allocation\.amount_ex_gst, 2\)/
  );
  assert.match(
    migration,
    /set status = 'voided',\s+voided_by = p_voided_by,\s+voided_at = now\(\),\s+void_reason/
  );
  assert.match(migration, /A voided invoice cannot be reopened/);
  assert.match(migration, /Allocations for a voided invoice cannot be changed/);
});
