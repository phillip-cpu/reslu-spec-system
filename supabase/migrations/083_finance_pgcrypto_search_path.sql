-- Finance readiness hashes use pgcrypto.digest(). Supabase installs
-- pgcrypto in the extensions schema, while the security-definer finance
-- functions deliberately use a restricted search_path. Include the trusted
-- extensions schema explicitly so readiness and activation resolve digest().

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

alter function finance_program_watermark(uuid)
  set search_path = public, extensions, pg_temp;

alter function activate_project_finance(
  uuid,
  date,
  uuid,
  text,
  uuid,
  jsonb,
  text,
  text,
  integer
)
  set search_path = public, extensions, pg_temp;

notify pgrst, 'reload schema';
