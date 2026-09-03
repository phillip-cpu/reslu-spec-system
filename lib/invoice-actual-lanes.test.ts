import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260903023000_separate_trade_and_ffe_invoice_actuals.sql",
    import.meta.url
  ),
  "utf8"
);
const queue = readFileSync(
  new URL("../components/invoices/InvoiceQueue.tsx", import.meta.url),
  "utf8"
);
const legacyApprovalRoute = readFileSync(
  new URL("../app/api/invoices/[id]/approve/route.ts", import.meta.url),
  "utf8"
);

test("only cost-line allocations write or reverse Estimate actuals", () => {
  assert.match(
    migration,
    /if v_allocation\.match_type = 'cost_line'[\s\S]+update cost_lines[\s\S]+continue;/
  );
  assert.match(
    migration,
    /where invoice_id = p_invoice_id\s+and match_type = 'cost_line'/
  );
  assert.doesNotMatch(
    migration,
    /where item_id = v_item_id[\s\S]{0,180}update cost_lines/
  );
});

test("trade-package references cannot be approved as direct FF&E", () => {
  assert.match(migration, /cost_scope <> 'trade_package'/);
});

test("cost-line destinations cannot update product pricing or show FF&E variance", () => {
  assert.match(queue, /if \(matchType !== "item"\) return null/);
  assert.match(
    queue,
    /const selectedCostingRow = draft\.match_type === "cost_line"\s+\? null/
  );
});

test("legacy approvals preserve the same trade and FF&E separation", () => {
  const itemBranch = legacyApprovalRoute.match(
    /else if \(typedInvoice\.proposed_match_type === "item"\)([\s\S]+?)else if \(typedInvoice\.proposed_match_type === "item_component"\)/
  )?.[1] ?? "";
  const componentBranch = legacyApprovalRoute.match(
    /else if \(typedInvoice\.proposed_match_type === "item_component"\)([\s\S]+?)\/\/ r24 item 7/
  )?.[1] ?? "";
  assert.doesNotMatch(itemBranch, /from\("cost_lines"\)/);
  assert.doesNotMatch(componentBranch, /from\("cost_lines"\)/);
});
