-- ============================================================
-- 010: Storage RLS policies for the 'assets' and 'item-images'
-- buckets. Migration 009 created the buckets; without policies on
-- storage.objects, non-service-role uploads fail with
-- "new row violates row-level security policy" (user-reported).
-- Authenticated team members may read/write both buckets.
-- Anonymous (portal) access stays via signed URLs only — no
-- policy for anon is granted here.
-- ============================================================

create policy "team_assets_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('assets', 'item-images'));

create policy "team_assets_select" on storage.objects
  for select to authenticated
  using (bucket_id in ('assets', 'item-images'));

create policy "team_assets_update" on storage.objects
  for update to authenticated
  using (bucket_id in ('assets', 'item-images'));

create policy "team_assets_delete" on storage.objects
  for delete to authenticated
  using (bucket_id in ('assets', 'item-images'));
