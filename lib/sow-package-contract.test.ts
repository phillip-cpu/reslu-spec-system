import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const roomSyncMigration = read(
  "supabase/migrations/20260901064900_sync_ffe_rooms_to_draft_sow_sections.sql"
);
const roomIndexMigration = read(
  "supabase/migrations/20260902013125_index_sow_sections_source_room.sql"
);
const retiredRoomMigration = read(
  "supabase/migrations/20260902013137_unlink_retired_rooms_from_draft_sow.sql"
);
const createSowRoute = read("app/api/projects/[id]/sow/route.ts");
const createLineRoute = read("app/api/sow/sections/[sectionId]/lines/route.ts");
const sectionRoute = read("app/api/sow/sections/[sectionId]/route.ts");
const fromTemplateRoute = read("app/api/projects/[id]/sow/[sowId]/from-template/route.ts");
const newRevisionRoute = read("app/api/projects/[id]/sow/[sowId]/new-revision/route.ts");
const builder = read("components/sow/SowBuilder.tsx");
const pdf = read("components/pdf/SowPdf.tsx");

test("FF&E rooms are durably linked into editable SOW sections", () => {
  assert.match(roomSyncMigration, /source_room_id uuid references public\.rooms\(id\) on delete set null/);
  assert.match(roomSyncMigration, /unique index[\s\S]*\(sow_id, source_room_id\)/);
  assert.match(roomSyncMigration, /after insert or update of name, deleted_at on public\.rooms/);
  assert.match(roomSyncMigration, /security invoker[\s\S]*set search_path = ''/);
  assert.match(roomSyncMigration, /idx_sow_sections_source_room[\s\S]*\(source_room_id\)/);
  assert.match(roomIndexMigration, /create index if not exists idx_sow_sections_source_room/);
  assert.match(retiredRoomMigration, /set source_room_id = null[\s\S]*section\.source_room_id = new\.id/);
  assert.match(createSowRoute, /source_room_id: room\.id/);
  assert.match(fromTemplateRoute, /existingByRoomId[\s\S]*existingRoomSection/);
  assert.match(newRevisionRoute, /activeRoomIds[\s\S]*source_room_id: sourceRoomId/);
  assert.match(newRevisionRoute, /missingRooms[\s\S]*source_room_id: room\.id/);
});

test("the SOW editor treats linked rooms as authoritative structure", () => {
  assert.match(builder, /sections\.filter\(\(section\) => section\.source_room_id !== null\)/);
  assert.match(builder, /readOnly \|\| section\.source_room_id !== null/);
  assert.match(builder, /!readOnly && section\.source_room_id === null/);
  assert.match(builder, /Room order/);
  assert.match(sectionRoute, /source_room_id, sow_documents\(status\)/);
  assert.match(sectionRoute, /parent\.linkedRoom && typeof body\.heading === "string"/);
  assert.match(sectionRoute, /Linked room sections are managed from the FF&E room register/);
});

test("trade groups support tagged creation and within-group ordering", () => {
  assert.match(createLineRoute, /trade: typeof body\.trade === "string"/);
  assert.match(builder, /groupSowLinesByTrade\(section\.lines\)/);
  assert.match(builder, /lockTrade=\{group\.trade !== null\}/);
  assert.match(builder, /tradeKey\(sourceLine\) !== tradeKey\(targetLine\)/);
  assert.match(builder, /reorderSowLines\(displayedLines, lineId, destinationIndex\)/);
});

test("the full PDF mirrors the editor's trade grouping", () => {
  assert.match(pdf, /groupSowLinesByTrade\(section\.lines\)/);
  assert.match(pdf, /group\.trade \?\? "General"/);
  assert.match(pdf, /const lineGroups = extractTrade[\s\S]*groupSowLinesByTrade/);
});
