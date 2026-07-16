import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const resetTriggerMigration = readFileSync(
  new URL("../supabase/migrations/005_portal_approvals.sql", import.meta.url),
  "utf8"
);
const resetConstraintMigration = readFileSync(
  new URL("../supabase/migrations/062_approval_event_reset_action.sql", import.meta.url),
  "utf8"
);

test("the approval reset trigger and action constraint share the reset contract", () => {
  assert.match(resetTriggerMigration, /'reset'/);
  assert.match(
    resetConstraintMigration,
    /check\s*\(action in \('approve', 'flag', 'revise', 'reset'\)\)/
  );
});
