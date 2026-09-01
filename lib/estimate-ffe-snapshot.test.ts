import assert from "node:assert/strict";
import test from "node:test";
import { buildEstimateFfeItemSnapshots } from "./estimate-ffe-snapshot.ts";

test("item snapshot cents reconcile exactly to the approved category totals", () => {
  const snapshots = buildEstimateFfeItemSnapshots([
    { id: "a", item_code: "TW-01", name: "Tap A", category: "TW", quantity: 1, price_trade: 3.33, price_rrp: null, cost_scope: "direct", lead_time_weeks: 2, ordered_at: null },
    { id: "b", item_code: "TW-02", name: "Tap B", category: "TW", quantity: 1, price_trade: 3.33, price_rrp: null, cost_scope: "direct", lead_time_weeks: 2, ordered_at: null },
    { id: "c", item_code: "TW-03", name: "Tap C", category: "TW", quantity: 1, price_trade: 3.33, price_rrp: null, cost_scope: "direct", lead_time_weeks: 2, ordered_at: null },
  ], {
    categories: [{ category: "TW", item_count: 3, total: 9.99, client_total: 9.99, quoted_share: 1, quoted_count: 3, placeholder_count: 0, unpriced_count: 0 }],
    total: 9.99, client_total: 9.99, quoted_total: 9.99, placeholder_total: 0,
    item_count: 3, quoted_count: 3, placeholder_count: 0, unpriced_count: 0,
    quoted_share: 1, placeholder_share: 0,
  });
  assert.equal(snapshots.reduce((sum, item) => sum + item.cost_net_minor, 0), 999);
  assert.equal(snapshots.reduce((sum, item) => sum + item.cash_gross_minor, 0), 1_099);
});

test("unpriced selections remain visible while trade-package references stay excluded", () => {
  const snapshots = buildEstimateFfeItemSnapshots([
    { id: "unpriced", item_code: "AP-01", name: "Appliance", category: "AP", quantity: 1, price_trade: null, price_rrp: null, cost_scope: "direct", lead_time_weeks: null, ordered_at: null },
    { id: "package", item_code: "HW-01", name: "Hardware", category: "HW", quantity: 1, price_trade: 100, price_rrp: null, cost_scope: "trade_package", lead_time_weeks: null, ordered_at: null },
  ], {
    categories: [{ category: "AP", item_count: 1, total: 0, client_total: 0, quoted_share: 0, quoted_count: 0, placeholder_count: 0, unpriced_count: 1 }],
    total: 0, client_total: 0, quoted_total: 0, placeholder_total: 0,
    item_count: 1, quoted_count: 0, placeholder_count: 0, unpriced_count: 1,
    quoted_share: 0, placeholder_share: 0,
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].id, "unpriced");
  assert.equal(snapshots[0].cost_net_minor, 0);
});
