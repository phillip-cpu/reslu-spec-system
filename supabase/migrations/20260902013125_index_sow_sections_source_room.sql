-- Follow-up for environments where sync_ffe_rooms_to_draft_sow_sections
-- was applied before the FK lookup index was added to its source file.
create index if not exists idx_sow_sections_source_room
  on public.sow_sections (source_room_id)
  where source_room_id is not null;
