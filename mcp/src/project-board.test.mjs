import assert from "node:assert/strict";
import test from "node:test";
import { resolveBoardGroupUpdate, resolveBoardTaskUpdate, verifyBoardGroupUpdate, verifyBoardTaskUpdate } from "./project-board.mjs";

const board = {
  columns: [
    { id: "c1", name: "Not Booked", tasks: [{ id: "t1", title: "Plasterboard", column_id: "c1", phase_group_id: "g1", updated_at: "v1", due_date: null }] },
    { id: "c2", name: "In Progress", tasks: [] },
  ],
  groups: [{ id: "g1", name: "Site Setup" }, { id: "g2", name: "Rough In" }],
};

const groupBoard = {
  columns: [],
  groups: [
    { id: "g1", name: "Rough-in", sort: 2000, updated_at: "v1" },
    { id: "g2", name: "Waterproofing & Tiling", sort: 3000, updated_at: "v2" },
    { id: "g3", name: "Plasterboard, Flushing & Cornice", sort: 6000, updated_at: "v3" },
  ],
};

test("resolves an existing card and moves it under Rough In without creating anything", () => {
  const plan = resolveBoardTaskUpdate(board, { task_title: "plasterboard", phase_group_name: "rough in", expected_updated_at: "v1" });
  assert.equal(plan.task.id, "t1");
  assert.deepEqual(plan.patch, { phase_group_id: "g2" });
});

test("supports status-column moves and field edits", () => {
  const plan = resolveBoardTaskUpdate(board, { task_id: "t1", target_column_name: "in progress", title: "Plasterboard install", expected_updated_at: "v1" });
  assert.deepEqual(plan.patch, { column_id: "c2", title: "Plasterboard install" });
});

test("returns a verified no-op when the card is already in the requested phase", () => {
  const plan = resolveBoardTaskUpdate(board, { task_id: "t1", phase_group_name: "Site Setup", expected_updated_at: "v1" });
  assert.equal(plan.noOp, true);
  assert.deepEqual(plan.patch, {});
});

test("fails closed on stale versions and ambiguous titles", () => {
  assert.throws(() => resolveBoardTaskUpdate(board, { task_id: "t1", phase_group_name: "rough", expected_updated_at: "old" }), /changed since/);
  const duplicated = { ...board, columns: [{ ...board.columns[0], tasks: [...board.columns[0].tasks, { ...board.columns[0].tasks[0], id: "t2" }] }, board.columns[1]] };
  assert.throws(() => resolveBoardTaskUpdate(duplicated, { task_title: "plaster", phase_group_name: "rough", expected_updated_at: "v1" }), /ambiguous/);
});

test("verifies authoritative readback", () => {
  const moved = { ...board, columns: [{ ...board.columns[0], tasks: [] }, { ...board.columns[1], tasks: [{ ...board.columns[0].tasks[0], column_id: "c2" }] }] };
  assert.equal(verifyBoardTaskUpdate(moved, "t1", { column_id: "c2" }).column_id, "c2");
  assert.throws(() => verifyBoardTaskUpdate(board, "t1", { column_id: "c2" }), /mismatch/);
});

test("moves a phase group directly after Rough-in using the available sort gap", () => {
  const plan = resolveBoardGroupUpdate(groupBoard, { group_name: "Plasterboard", move_after_group_name: "Rough-in", expected_updated_at: "v3" });
  assert.equal(plan.group.id, "g3");
  assert.deepEqual(plan.patch, { sort: 2500 });
  const readback = { ...groupBoard, groups: groupBoard.groups.map((group) => group.id === "g3" ? { ...group, sort: 2500 } : group) };
  assert.equal(verifyBoardGroupUpdate(readback, "g3", plan.patch).sort, 2500);
});

test("fails closed on stale group versions", () => {
  assert.throws(() => resolveBoardGroupUpdate(groupBoard, { group_id: "g3", move_after_group_name: "Rough-in", expected_updated_at: "old" }), /changed since/);
});
