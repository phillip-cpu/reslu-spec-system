import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/067_invoice_items_without_estimate_lines.sql",
    import.meta.url
  ),
  "utf8"
);

test("specification-item invoice matches do not require duplicate estimate lines", () => {
  assert.doesNotMatch(migration, /if v_linked_count = 0 then/);
  assert.match(
    migration,
    /if v_linked_count > 1 then\s+raise exception 'A matched item has more than one linked estimate cost line'/
  );
  assert.match(migration, /v_line_id := null;/);
  assert.match(migration, /if v_line_id is not null then\s+update cost_lines/);
});

test("source-backed matches refresh the project item even without a library link", () => {
  assert.match(
    migration,
    /v_allocation\.source_line_id is not null or v_allocation\.apply_to_library_cost/
  );
  assert.match(
    migration,
    /if v_component_id is null then\s+update items\s+set price_trade = v_unit_cost/
  );
  assert.match(
    migration,
    /if v_allocation\.apply_to_library_cost and v_library_item_id is not null then/
  );
});
