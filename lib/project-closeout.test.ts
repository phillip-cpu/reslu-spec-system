import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectCloseoutReadiness } from "./project-closeout.ts";
import type { ProjectCloseoutCounts } from "../types/project-closeout.ts";

function counts(overrides: Partial<ProjectCloseoutCounts> = {}): ProjectCloseoutCounts {
  return {
    open_work_tasks: 0,
    open_handover_tasks: 0,
    handover_task_total: 4,
    ffe_not_installed: 0,
    ffe_total: 3,
    supplier_needs_matching: 0,
    supplier_approved_unpaid: 0,
    client_invoice_drafts: 0,
    client_invoices_unpaid: 0,
    proposed_variations: 0,
    pending_signatures: 0,
    handover_candidates: 3,
    handover_selected: 3,
    compliance_certificates_selected: 1,
    manuals_warranties_selected: 1,
    gallery_candidates: 1,
    gallery_selected: 1,
    ...overrides,
  };
}

test("reports ready only when all five source areas are clear", () => {
  const readiness = buildProjectCloseoutReadiness({
    projectId: "project-1",
    counts: counts(),
    generatedAt: "2026-09-04T00:00:00.000Z",
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.clear_area_count, 5);
  assert.equal(readiness.attention_area_count, 0);
  assert.equal(readiness.outstanding_item_count, 0);
  assert.deepEqual(
    readiness.areas.map((area) => area.key),
    ["work", "procurement", "supplier_finance", "client_account", "handover_pack"]
  );
});

test("maps live discrepancies to their source areas without double-counting handover work", () => {
  const readiness = buildProjectCloseoutReadiness({
    projectId: "project-2",
    counts: counts({
      open_work_tasks: 4,
      open_handover_tasks: 2,
      ffe_not_installed: 3,
      supplier_needs_matching: 1,
      supplier_approved_unpaid: 2,
      client_invoice_drafts: 1,
      client_invoices_unpaid: 1,
      proposed_variations: 1,
      pending_signatures: 1,
      handover_candidates: 0,
      handover_selected: 0,
      gallery_candidates: 0,
      gallery_selected: 0,
    }),
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.attention_area_count, 5);
  assert.equal(readiness.outstanding_item_count, 15);
  assert.equal(readiness.areas.find((area) => area.key === "work")?.outstanding_items, 4);
  assert.equal(
    readiness.areas.find((area) => area.key === "supplier_finance")?.outstanding_items,
    3
  );
  assert.equal(
    readiness.areas.find((area) => area.key === "client_account")?.outstanding_items,
    4
  );
});

test("flags a missing handover task set even when every existing Work item is done", () => {
  const readiness = buildProjectCloseoutReadiness({
    projectId: "project-3",
    counts: counts({ handover_task_total: 0 }),
  });

  const work = readiness.areas.find((area) => area.key === "work");
  assert.equal(work?.state, "attention");
  assert.equal(work?.outstanding_items, 1);
  assert.match(work?.detail ?? "", /Handover phase has no tasks/);
});

test("an empty FF&E schedule is clear rather than inventing closeout work", () => {
  const readiness = buildProjectCloseoutReadiness({
    projectId: "project-4",
    counts: counts({ ffe_total: 0, ffe_not_installed: 0 }),
  });

  const procurement = readiness.areas.find((area) => area.key === "procurement");
  assert.equal(procurement?.state, "clear");
  assert.match(procurement?.summary ?? "", /No direct FF&E/);
});

test("handover requires a curated pack without inventing a universal photo rule", () => {
  const noPack = buildProjectCloseoutReadiness({
    projectId: "project-5",
    counts: counts({
      handover_candidates: 5,
      handover_selected: 0,
      gallery_candidates: 2,
      gallery_selected: 0,
    }),
  });
  const noPhoto = buildProjectCloseoutReadiness({
    projectId: "project-5",
    counts: counts({ gallery_candidates: 0, gallery_selected: 0 }),
  });

  assert.equal(
    noPack.areas.find((area) => area.key === "handover_pack")?.outstanding_items,
    1
  );
  assert.equal(
    noPhoto.areas.find((area) => area.key === "handover_pack")?.outstanding_items,
    0
  );
});
