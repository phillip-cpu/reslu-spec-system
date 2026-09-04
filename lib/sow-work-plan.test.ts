import assert from "node:assert/strict";
import test from "node:test";
import { buildSowWorkPlan, suggestSowWorkPhase } from "./sow-work-plan.ts";

const phases = [
  { group_id: "g2", name: "Stage 2 – Demolition & Strip Out", sort: 2 },
  { group_id: "g5", name: "Stage 5 – Service Rough In", sort: 5 },
  { group_id: "g7", name: "Stage 7 – Internal Finishes", sort: 7 },
  { group_id: "g8", name: "Stage 8 – Joinery & Fixed Elements", sort: 8 },
  { group_id: "g9", name: "Stage 9 – Fit Off", sort: 9 },
];

test("maps the same trade into separate rough-in and fit-off work packages", () => {
  assert.equal(suggestSowWorkPhase("ELECTRICAL — Rough-in new circuits", "Electrician", phases)?.group_id, "g5");
  assert.equal(suggestSowWorkPhase("LIGHTING — Install and connect pendant", "Electrician", phases)?.group_id, "g9");
});

test("maps stud framing before incidental lining and waterproofing language", () => {
  const detailedPhases = [
    { group_id: "structure", name: "Structural & Framing", sort: 3 },
    { group_id: "linings", name: "Internal Linings & Waterproofing", sort: 6 },
  ];
  assert.equal(
    suggestSowWorkPhase(
      "New timber stud wall to shower with MR plasterboard and waterproofing",
      "Carpenter",
      detailedPhases
    )?.group_id,
    "structure"
  );
});

test("trusts specialist trade ownership ahead of incidental material words", () => {
  const customPhases = [
    { group_id: "demo", name: "Demolition-External", sort: 1 },
    { group_id: "wet", name: "Waterproofing & Tiling", sort: 2 },
    { group_id: "fit", name: "Fit-off", sort: 3 },
    { group_id: "slab", name: "Slab & Footings", sort: 4 },
  ];

  assert.equal(
    suggestSowWorkPhase("PAINTING — Prepare new plasterboard surfaces", "Painter", customPhases)?.group_id,
    "fit"
  );
  assert.equal(
    suggestSowWorkPhase("Install skirting tile beside joinery", "Tiler", customPhases)?.group_id,
    "wet"
  );
  assert.equal(
    suggestSowWorkPhase("Install tall cabinets", "Joiner", customPhases)?.group_id,
    "fit"
  );
  assert.equal(
    suggestSowWorkPhase("Install PFC portal frame", "Structural", customPhases)?.group_id,
    "slab"
  );
  assert.equal(
    suggestSowWorkPhase("Install Aquacheck plasterboard", "Plaster, Flushing & Cornice", customPhases)?.group_id,
    "wet"
  );
});

test("rolls room clauses up by trade and phase instead of creating one card per line", () => {
  const result = buildSowWorkPlan({
    sowId: "sow-t1",
    phases,
    existingTasks: [],
    assignments: [{ trade_role: "Tiler", contact_name: "Tiling Co" }],
    sections: [
      {
        id: "kitchen",
        heading: "Kitchen",
        lines: [
          { id: "l1", kind: "inclusion", trade: "Tiler", text: "FLOOR TILING — Install TL-01" },
          { id: "l2", kind: "inclusion", trade: "Tiler", text: "WALL TILING — Install TL-02" },
        ],
      },
      {
        id: "laundry",
        heading: "Laundry",
        lines: [
          { id: "l3", kind: "inclusion", trade: "Tiler", text: "FLOOR TILING — Install TL-03" },
          { id: "l4", kind: "note", trade: "Tiler", text: "Confirm grout colour" },
          { id: "l5", kind: "inclusion", trade: null, text: "Unallocated work" },
        ],
      },
    ],
  });

  assert.equal(result.suggestions.length, 1);
  assert.deepEqual(result.suggestions[0]?.line_ids, ["l1", "l2", "l3"]);
  assert.deepEqual(result.suggestions[0]?.section_headings, ["Kitchen", "Laundry"]);
  assert.equal(result.suggestions[0]?.phase_group_id, "g7");
  assert.equal(result.suggestions[0]?.assigned_contact_name, "Tiling Co");
  assert.equal(result.scopeInclusionCount, 4);
  assert.equal(result.includedLineCount, 3);
  assert.equal(result.untaggedInclusionCount, 1);
});

test("matches one existing template task without overwriting it", () => {
  const result = buildSowWorkPlan({
    sowId: "sow-t1",
    phases,
    sections: [{
      id: "bathroom",
      heading: "Bathroom",
      lines: [{ id: "l1", kind: "inclusion", trade: "Plumber", text: "SANITARYWARE — Install and connect basin" }],
    }],
    existingTasks: [{
      id: "task-1",
      title: "Plumbing fit off",
      phase_group_id: "g9",
      trade_role: null,
      sow_work_key: null,
      sow_revision_id: null,
      linked_sow_line_ids: [],
    }],
  });

  assert.equal(result.suggestions[0]?.state, "link");
  assert.equal(result.suggestions[0]?.existing_task_id, "task-1");
  assert.equal(result.suggestions[0]?.existing_task_title, "Plumbing fit off");
});

test("recognises current packages and flags a later revision for review", () => {
  const base = {
    phases,
    sections: [{
      id: "kitchen",
      heading: "Kitchen",
      lines: [{ id: "l1", kind: "inclusion" as const, trade: "Joiner", text: "JOINERY — Supply and install cabinetry" }],
    }],
    existingTasks: [{
      id: "task-1",
      title: "Kitchen joinery installation",
      phase_group_id: "g8",
      trade_role: "Joiner",
      sow_work_key: "sow:g8:joiner",
      sow_revision_id: "sow-t1",
      linked_sow_line_ids: ["l1"],
    }],
  };

  assert.equal(buildSowWorkPlan({ ...base, sowId: "sow-t1" }).suggestions[0]?.state, "current");
  assert.equal(buildSowWorkPlan({ ...base, sowId: "sow-t2" }).suggestions[0]?.state, "refresh");
});

test("does not guess between multiple candidate tasks", () => {
  const result = buildSowWorkPlan({
    sowId: "sow-t1",
    phases,
    sections: [{
      id: "kitchen",
      heading: "Kitchen",
      lines: [{ id: "l1", kind: "inclusion", trade: "Electrician", text: "ELECTRICAL — Rough-in circuits" }],
    }],
    existingTasks: [
      { id: "a", title: "Electrical rough in A", phase_group_id: "g5", trade_role: null, sow_work_key: null, sow_revision_id: null, linked_sow_line_ids: [] },
      { id: "b", title: "Electrical rough in B", phase_group_id: "g5", trade_role: null, sow_work_key: null, sow_revision_id: null, linked_sow_line_ids: [] },
    ],
  });

  assert.equal(result.suggestions[0]?.state, "create");
  assert.equal(result.suggestions[0]?.existing_task_id, null);
});

test("changes the review fingerprint when scope changes inside the same package", () => {
  const build = (text: string) => buildSowWorkPlan({
    sowId: "sow-t1",
    phases,
    existingTasks: [],
    sections: [{
      id: "kitchen",
      heading: "Kitchen",
      lines: [{ id: "l1", kind: "inclusion", trade: "Joiner", text }],
    }],
  });

  const before = build("JOINERY — Supply and install cabinetry").suggestions[0];
  const after = build("JOINERY — Supply and install cabinetry and handles").suggestions[0];

  assert.equal(before?.key, after?.key);
  assert.notEqual(before?.fingerprint, after?.fingerprint);
});
