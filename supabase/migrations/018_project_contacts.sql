-- ============================================================
-- RESLU Spec System — Phase 11 extension: owner contact details.
-- Phillip's build note, 5 July 2026: "Owner contact details on
-- projects" — projects gains client_phone + a second owner's
-- name/email/phone (couples: two owners on the same job).
--
-- Conventions carried over from every prior migration:
--   - add column if not exists (idempotent, safe to re-run)
--   - plain nullable text columns, no CHECK constraints — mirrors
--     projects.client_email (migration 016_portal_v2.sql), which is
--     also a bare nullable text with no format validation
-- ============================================================

-- ============================================================
-- client_phone — primary owner's phone. Sits alongside the existing
-- client_email (016) as the primary contact channel; client_name
-- (001_initial.sql) is already the primary owner's name, so no
-- "client_primary_name" column is added — it would just duplicate
-- client_name.
--
-- client_secondary_name / client_secondary_email / client_secondary_phone
-- — the second owner on a couple's job. All nullable: most jobs have
-- one primary contact, some have two. Kept as flat columns (not a
-- second contacts-style row) because this is exactly two, fixed,
-- named slots per project — the same reasoning migration 001 used for
-- client_name/client_email being flat columns on projects rather than
-- a normalised "project_contacts" table.
-- ============================================================
alter table projects
  add column if not exists client_phone text,
  add column if not exists client_secondary_name text,
  add column if not exists client_secondary_email text,
  add column if not exists client_secondary_phone text;

notify pgrst, 'reload schema';
