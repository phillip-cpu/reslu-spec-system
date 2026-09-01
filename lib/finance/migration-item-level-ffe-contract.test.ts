import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  new URL(
    "../../supabase/migrations/20260901115000_finance_item_level_ffe_baselines.sql",
    import.meta.url
  ),
  "utf8"
);
const reconciliationSql = readFileSync(
  new URL(
    "../../supabase/migrations/20260901120059_finance_ffe_minor_unit_reconciliation.sql",
    import.meta.url
  ),
  "utf8"
);

test("Finance activation expands new FF&E snapshots to item-level baseline rows", () => {
  assert.match(sql, /snapshot->'estimate'->'ffe_items'/i);
  assert.match(sql, /\|ffe_item:'\s*\|\|/i);
  assert.match(sql, /source_type[\s\S]*'estimate_ffe_item'/i);
  assert.match(sql, /before insert on public\.finance_forecast_lines/i);
});

test("item expansion suppresses the legacy category row and excludes trade-package references", () => {
  assert.match(sql, /return null;/i);
  assert.match(sql, /cost_scope[\s\S]*<>\s*'trade_package'/i);
  assert.match(sql, /on conflict \(baseline_id, contribution_key\) do nothing/i);
});

test("the trigger helper is not directly executable by application roles", () => {
  assert.match(
    sql,
    /revoke all on function public\.expand_finance_ffe_category_to_items\(\)[\s\S]*from public, anon, authenticated/i
  );
});

test("the corrected trigger preserves frozen net, GST and gross minor units", () => {
  assert.match(reconciliationSql, /planned_net_minor[\s\S]*planned_tax_minor[\s\S]*planned_gross_minor/i);
  assert.match(reconciliationSql, /item->>'cost_net_minor'/i);
  assert.match(reconciliationSql, /item->>'cash_gross_minor'/i);
  assert.match(reconciliationSql, /gross_minor\s*-\s*amounts\.net_minor/i);
});
