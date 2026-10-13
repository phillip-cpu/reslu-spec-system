import assert from "node:assert/strict";
import test from "node:test";
import { allocatePayments, buildConstructionContent, constructionPrices, validatePayments } from "./construction-proposals.ts";
import type { Proposal } from "../types/proposals";

import { fixture } from "./construction-proposals.fixture.ts";

test("projects selling prices, includes override, separates options and scope, exposes no internal financial fields", () => {
  const input = fixture(); const result = buildConstructionContent(input);
  assert.equal(result.construction.total_inc, 352);
  assert.equal(result.construction.subtotal_ex_gst, 320);
  assert.equal(result.construction.gst, 32);
  assert.equal(result.construction.estimate_total_inc, 363);
  assert.deepEqual(result.construction.prices.map(p => p.selling_ex_gst), [100,200,20,10]);
  assert.ok(result.fees.price_lines?.includes("Shared preliminaries: $20.00 ex GST"));
  assert.ok(!JSON.stringify(result.scope_sections).includes("Optional appliance"));
  assert.ok(JSON.stringify(result.exclusions).includes("OPTION — Appliance option"));
  for (const field of ["cost_ex_gst", "markup", "margin", "actual_paid", "rate_ex_gst", "SECRET-SUPPLIER"]) assert.ok(!JSON.stringify(result).includes(field), field);
  const frozen = JSON.stringify(result); input.version.snapshot.sections[0].lines[0].cost_ex_gst = 99999;
  assert.equal(JSON.stringify(result), frozen);
});
test("100% passes, latest draft leaves exactly 4.5% unallocated, invalid numbers rejected", () => {
  const p = fixture().selection.payments;
  assert.equal(validatePayments(p), null);
  p[p.length - 1].percentage = 5; p.push({ label: "Handover", percentage: 0 });
  assert.match(validatePayments(p)!, /95.5%; 4.5% unallocated/);
  for (const percentage of [NaN, Infinity, -1, 101, 1.001, "100"] as number[]) assert.ok(validatePayments([{ label: "stage", percentage }]));
  assert.ok(validatePayments([]));
});
test("payment cents reconcile including zero handover and awkward totals", () => {
  const p = [...fixture().selection.payments, { label: "Handover", percentage: 0 }];
  for (const total of [496863.99, 1.01, 352, 0.01]) {
    const allocated = allocatePayments(p, total);
    assert.equal(allocated.reduce((n, p) => n + Math.round(p.amount_inc * 100), 0), Math.round(total * 100));
    assert.equal(allocated.at(-1)!.amount_inc, 0);
  }
});
test("rejects incomplete, unpriced, mismatched and post-contract sources", () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { delete f.selection.groups["section:a"]; }, f => { f.selection.groups.extra = "internal"; },
    f => { delete f.selection.scope_groups["scope-a"]; }, f => { f.sow.status = "draft"; },
    f => { f.sow.project_id = "different-project"; }, f => { f.sow.revision_label = "S2"; },
    f => { f.version.snapshot.wholeJob.combinedExGst++; }, f => { f.version.snapshot.ffe.unpriced_count = 1; },
    f => { f.version.snapshot.rollup.approvedVariationsExGst = 5; },
    f => { f.version.snapshot.sections[0].lines[0].rate_ex_gst = null; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => buildConstructionContent(f)); }
});
test("revision copies content, summarizes changes, rejects accepted parents and cross-project links", () => {
  const f = fixture(); const first = buildConstructionContent(f);
  const previous = { id: "prior", project_id: f.version.project_id, status: "sent", content: first } as Proposal;
  const before = JSON.stringify(previous);
  f.selection.payments = [{ label: "Deposit", percentage: 100 }];
  const revised = buildConstructionContent({ ...f, previous });
  assert.equal(revised.construction.previous_proposal_id, "prior");
  assert.ok(revised.construction.changes.some(c => c.startsWith("Selling prices / payment stages")));
  assert.equal(JSON.stringify(previous), before);
  for (const status of ["accepted", "closed"] as const) assert.throws(() => buildConstructionContent({ ...f, previous: { ...previous, status } }), /separate post-contract variation/);
  assert.throws(() => buildConstructionContent({ ...f, previous: { ...previous, project_id: "other" } }), /same project/);
});
test("selling projection itself contains only approved fields", () => {
  for (const row of constructionPrices(fixture().version)) assert.deepEqual(Object.keys(row), ["key", "label", "selling_ex_gst"]);
});

test("separate variation preserves original and binds base approval, price, description and time effects", async () => {
  const { buildConstructionVariation } = await import("./construction-proposals.ts");
  const f = fixture();
  const base = { id: "accepted-original", status: "accepted", signed_name: "Synthetic Client", signed_at: "2026-01-01T00:00:00Z", project_id: f.version.project_id, total_inc: 352, content: buildConstructionContent(f) } as Proposal;
  const before = JSON.stringify(base);
  const input = { base, baseDigest: "exact-base-version", sourceDigest: "package-version", package: { id: "package-a", project_id: base.project_id!, label: "Extra door", amount_inc_gst: 1100 }, description: "Add one door", time_effect_days: 2, time_effect_note: "Two additional working days" };
  const result = buildConstructionVariation(input);
  assert.equal(result.construction.total_inc, 1100);
  assert.equal(result.construction.subtotal_ex_gst, 1000);
  assert.equal(result.construction.gst, 100);
  assert.equal(result.construction.variation?.accepted_proposal_id, base.id);
  assert.equal(result.construction.variation?.approval_history[0].version_digest, "exact-base-version");
  assert.equal(result.construction.variation?.time_effect_days, 2);
  assert.equal(JSON.stringify(base), before);
  assert.throws(() => buildConstructionVariation({ ...input, time_effect_note: "" }), /explicit time effect/);
  assert.throws(() => buildConstructionVariation({ ...input, base: { ...base, status: "draft" } }), /accepted original/);
  assert.throws(() => buildConstructionVariation({ ...input, package: { ...input.package, project_id: "other" } }), /same project/);
});
