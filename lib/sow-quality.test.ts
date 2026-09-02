import assert from "node:assert/strict";
import test from "node:test";
import { assessSowQuality } from "./sow-quality.ts";

test("blocks unfinished room scope while keeping FF&E and plan gaps as review warnings", () => {
  const report = assessSowQuality({
    sections: [
      {
        id: "powder-section",
        heading: "Powder",
        source_room_id: "powder",
        lines: [
          { id: "ref", text: "Ref: {{Powder elevation}}", kind: "note", trade: null },
          { id: "work", text: "Install basin SW-01", kind: "inclusion", trade: null },
        ],
      },
      {
        id: "yard-section",
        heading: "Backyard",
        source_room_id: "yard",
        lines: [],
      },
    ],
    rooms: [
      { id: "powder", name: "Powder" },
      { id: "yard", name: "Backyard" },
    ],
    allocations: [
      { room_id: "powder", item_id: "basin", item_code: "SW-01", name: "Basin" },
      { room_id: "yard", item_id: "paving", item_code: "OD-05", name: "Paving" },
    ],
    plan_files: [{ id: "plans", filename: "Interior works.pdf" }],
    plan_analyses: [],
  });

  assert.equal(report.ready_to_issue, false);
  assert.deepEqual(
    new Set(report.blockers.map((finding) => finding.code)),
    new Set(["placeholder_lines", "untagged_inclusions"])
  );
  assert.ok(report.warnings.some((finding) => finding.code === "awaiting_working_drawings"));
  assert.ok(report.warnings.some((finding) => finding.code === "uncovered_ffe_items"));
  assert.ok(report.warnings.some((finding) => finding.code === "plan_not_analysed"));
  assert.equal(report.summary.assigned_ffe_items, 2);
  assert.equal(report.summary.referenced_ffe_items, 1);
});

test("restores the empty exterior room blocker after the exterior set is uploaded", () => {
  const report = assessSowQuality({
    sections: [{ id: "yard-section", heading: "Backyard", source_room_id: "yard", lines: [] }],
    rooms: [{ id: "yard", name: "Backyard" }],
    allocations: [],
    plan_files: [
      { id: "interior", filename: "Hone Interior Working Drawings.pdf" },
      { id: "exterior", filename: "Hone Exterior Working Drawings.pdf" },
    ],
    plan_analyses: [],
  });

  assert.equal(report.ready_to_issue, false);
  assert.ok(report.blockers.some((finding) => finding.code === "empty_room"));
  assert.equal(report.warnings.some((finding) => finding.code === "awaiting_working_drawings"), false);
});

test("allows issue when hard blockers are clear even when human-review warnings remain", () => {
  const report = assessSowQuality({
    sections: [
      {
        id: "laundry-section",
        heading: "Laundry",
        source_room_id: "laundry",
        lines: [
          { id: "ref", text: "Ref: Interior works.pdf", kind: "note", trade: null },
          { id: "work", text: "Install sink SW-04", kind: "inclusion", trade: "Plumber" },
        ],
      },
    ],
    rooms: [{ id: "laundry", name: "Laundry" }],
    allocations: [
      { room_id: "laundry", item_id: "sink", item_code: "SW-04", name: "Sink" },
      { room_id: "laundry", item_id: "paint", item_code: "PF-04", name: "Paint" },
    ],
    plan_files: [{ id: "plans", filename: "Interior works.pdf" }],
    plan_analyses: [
      { file_id: "plans", filename: "Interior works.pdf", discrepancies: [] },
    ],
  });

  assert.equal(report.ready_to_issue, true);
  assert.equal(report.blockers.length, 0);
  assert.ok(report.warnings.some((finding) => finding.item_codes?.includes("PF-04")));
});
