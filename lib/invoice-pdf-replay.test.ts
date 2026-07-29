import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const replayMigration = readFileSync(
  new URL("../supabase/migrations/072_replay_missed_pdf_invoices.sql", import.meta.url),
  "utf8"
);

test("replays every missed supplier PDF from the last three weeks without duplicating candidates", () => {
  assert.match(replayMigration, /triage_label = 'supplier_invoice'/);
  assert.match(replayMigration, /received_at >= now\(\) - interval '21 days'/);
  assert.match(replayMigration, /nullif\(btrim\(attachment\.extracted_text\), ''\) is not null/);
  assert.match(replayMigration, /queue_row\.kind = 'invoice_candidate'/);
  assert.match(replayMigration, /queue_row\.payload ->> 'source_email_id' = email_row\.id::text/);
  assert.doesNotMatch(replayMigration, /bunnings/i);
});

