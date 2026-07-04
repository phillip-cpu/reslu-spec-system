-- ============================================================
-- RESLU Spec System — Portal approvals hardening
-- BUILD-SPEC.md §7 (approval events / reset-on-change) and the
-- Week 3B portal + PDF audit task.
--
-- Filename note: the audit task referred to this file as
-- "003_portal_approvals.sql", but 003 (profiles provisioning) and
-- 004 (library/scraper) already exist in this working copy —
-- following the same disambiguation 004 used, this lands as 005.
-- Content and intent are unchanged from spec.
--
-- What's already in 001_initial.sql (verified before writing this):
--   - approval_events(id, item_id, action, note, item_snapshot jsonb,
--     portal_token, created_at) — action check-constrained to
--     ('approve','flag','revise'). Columns match what the portal API
--     route already inserts. No changes needed to this table's shape.
--   - trg_items_reset_approval / reset_approval_on_material_change():
--     already resets client_approved to false when material fields
--     change on a previously-approved item. Field list already covers
--     name, description, supplier, brand, quantity, colour, material,
--     finish, width/height/length/depth_mm, selected_image_url,
--     product_url — a superset of the audit task's required list
--     (name, supplier, brand, product_url, selected_image_url, colour,
--     material, finish). Only gaps: `application_note` is not covered
--     (not required by the task, left alone) and the trigger never
--     logged an approval_events row on reset — that's the actual gap
--     this migration fixes.
--
-- This migration:
--   1. Extends reset_approval_on_material_change() to insert an
--      approval_events row (action='reset') whenever it flips
--      client_approved back to false, with a snapshot of
--      {name, supplier, brand, selected_image_url} as required.
--   2. Idempotent — safe to re-run (create or replace function).
-- ============================================================

create or replace function reset_approval_on_material_change()
returns trigger as $$
begin
  if old.client_approved = true and (
    new.name              is distinct from old.name or
    new.description        is distinct from old.description or
    new.supplier            is distinct from old.supplier or
    new.brand               is distinct from old.brand or
    new.quantity             is distinct from old.quantity or
    new.colour               is distinct from old.colour or
    new.material              is distinct from old.material or
    new.finish                is distinct from old.finish or
    new.width_mm               is distinct from old.width_mm or
    new.height_mm               is distinct from old.height_mm or
    new.length_mm                is distinct from old.length_mm or
    new.depth_mm                  is distinct from old.depth_mm or
    new.selected_image_url        is distinct from old.selected_image_url or
    new.product_url                is distinct from old.product_url
  ) then
    new.client_approved = false;

    -- BUILD-SPEC.md / audit task: log the reset as an approval_events
    -- row so there's an audit trail of *why* an item went back to
    -- unapproved, not just that it did. Snapshot carries the fields
    -- the audit task specifies: name, supplier, brand,
    -- selected_image_url (using the NEW/post-change values, since
    -- that's the state the item is in after this update commits).
    insert into approval_events (item_id, action, note, item_snapshot, portal_token)
    values (
      new.id,
      'reset',
      'Approval reset automatically — a material field changed after client approval.',
      jsonb_build_object(
        'name', new.name,
        'supplier', new.supplier,
        'brand', new.brand,
        'selected_image_url', new.selected_image_url
      ),
      null
    );
  end if;
  return new;
end;
$$ language plpgsql;

-- Trigger definition itself (trg_items_reset_approval) is unchanged —
-- it already points at this function name, so replacing the function
-- body is sufficient; no need to drop/recreate the trigger.

-- ------------------------------------------------------------
-- item_files: allow signed-URL delivery on the client portal.
-- No schema change required — item_files.storage_path is already
-- sufficient to mint a signed URL server-side via
-- supabase.storage.from(bucket).createSignedUrl(path, expiresIn).
-- Documented here so the reasoning is co-located with the portal
-- changes that consume it (see app/portal/[token]/page.tsx, which
-- signs item_files URLs for the download links shown on each item).
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- Storage bucket for PDF-time image re-hosting (lib/images.ts,
-- ensureStoredImage). Separate from the existing 'assets' bucket
-- (item images uploaded on selection, item_files documents) so the
-- PDF pre-pass's re-hosted copies are easy to find/clear independently
-- if ever needed. Public read (same trust model as 'assets' — these
-- are already-selected product images, not sensitive), uploads only
-- via the service-role key from server code.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('item-images', 'item-images', true)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- Portal rate limiting: no schema change — implemented as an
-- in-memory fixed-window limiter (lib/rate-limit.ts), already applied
-- to the approve/flag route. Noted here for completeness: this is
-- per-server-instance memory (see lib/rate-limit.ts header comment
-- for the serverless/multi-instance caveat) — acceptable for Phase 1
-- since the real security boundary is the unguessable token plus the
-- item/project ownership check, not the rate limit itself.
-- ------------------------------------------------------------
