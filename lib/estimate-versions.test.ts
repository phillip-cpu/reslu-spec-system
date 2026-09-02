import assert from "node:assert/strict";
import test from "node:test";
import { suggestNextLabel } from "./estimate-version-labels.ts";
import {
  diffFfeSubstitutions,
  ffeSubstitutionItemsFromSnapshot,
} from "./estimate-versions.ts";
import type { EstimateFfeItemSnapshot } from "../types/phase-12a-a.ts";

test("estimate versions start with a usable label", () => {
  assert.equal(suggestNextLabel([]), "V1");
});

test("estimate version labels advance across issue and VM versions", () => {
  const labels = ["V1", "VM_V2", "client option"];
  assert.equal(suggestNextLabel(labels, "issue"), "V3");
  assert.equal(suggestNextLabel(labels, "vm"), "VM_V3");
});

function frozenFfeItem(
  overrides: Partial<EstimateFfeItemSnapshot> = {}
): EstimateFfeItemSnapshot {
  return {
    id: "item-1",
    item_code: "TW-01",
    name: "Basin mixer",
    category: "TW",
    quantity: 3,
    cost_scope: "direct",
    unit_price_ex_gst: 12.345,
    total_ex_gst: 37.04,
    cost_net_minor: 3704,
    cash_gross_minor: 4074,
    pricing_confidence: "quoted",
    lead_time_weeks_at_snapshot: 4,
    ordered_at_snapshot: null,
    ...overrides,
  };
}

test("legacy snapshots do not pretend every current FF&E item was added", () => {
  assert.equal(ffeSubstitutionItemsFromSnapshot({}), null);
});

test("frozen FF&E comparison uses retained identities and cent-exact totals", () => {
  const was = ffeSubstitutionItemsFromSnapshot({ ffe_items: [frozenFfeItem()] });
  const now = ffeSubstitutionItemsFromSnapshot({
    ffe_items: [frozenFfeItem({ unit_price_ex_gst: 10, total_ex_gst: 30 })],
  });

  assert.ok(was);
  assert.ok(now);
  assert.deepEqual(diffFfeSubstitutions(was, was), []);
  assert.deepEqual(diffFfeSubstitutions(was, now), [
    {
      item_code: "TW-01",
      was: { name: "Basin mixer", total: 37.04 },
      now: { name: "Basin mixer", total: 30 },
      saving: 7.04,
    },
  ]);
});
