-- ============================================================
-- RESLU Spec System — Monday column config + portal digest queue
-- BUILD-SPEC.md Week 4 task: Monday sync + email digest.
--
-- Idempotent: every statement is guarded so this can be re-run safely.
-- ============================================================

-- ------------------------------------------------------------
-- projects.settings: free-form JSON for per-project configuration
-- that doesn't warrant its own column. First (and so far only) use:
-- the Monday column-id map (BUILD-SPEC.md Week 4: "make column IDs
-- configurable via project settings JSON field if one exists, else
-- document defaults"). Shape (all optional):
--
--   {
--     "monday": {
--       "columns": {
--         "status": "status",
--         "supplier": "text",
--         "quantity": "numbers",
--         "product_url": "link",
--         "ordered_at": "date",
--         "eta": "date4"
--       }
--     }
--   }
--
-- See lib/monday/sync.ts (MondayColumnMap / ProjectSettings) for how
-- this is read and documented per-key defaults. Any column omitted
-- from the map is simply left out of the Monday column_values payload
-- — sync never fails because a column id is missing.
-- ------------------------------------------------------------
alter table projects
  add column if not exists settings jsonb not null default '{}';

-- ------------------------------------------------------------
-- portal_digest_queue: durable queue of client-portal actions
-- (approve/flag) awaiting an email digest to the team. Written by
-- lib/gmail/digest.ts's recordPortalAction(), called from the portal
-- action route (app/api/portal/[token]/[action]/[itemId]/route.ts —
-- see the single import+call line added there). Flushed in a batch,
-- grouped per project, by POST /api/digest/flush
-- (lib/gmail/digest.ts's flushDigest()), which stamps sent_at on
-- every row it successfully emails.
--
-- Replaces the Week 3B approach of sending one email synchronously
-- per portal click — see lib/gmail/digest.ts header for the full
-- rationale (durability across Gmail outages/unconfigured periods,
-- no need for an always-on cron process).
-- ------------------------------------------------------------
create table if not exists portal_digest_queue (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  item_id     uuid not null references items(id) on delete cascade,
  action      text not null check (action in ('approve', 'flag')),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create index if not exists idx_portal_digest_queue_pending
  on portal_digest_queue(project_id, created_at)
  where sent_at is null;

drop trigger if exists trg_portal_digest_queue_updated_at on portal_digest_queue;
create trigger trg_portal_digest_queue_updated_at
  before update on portal_digest_queue
  for each row execute function set_updated_at();

-- RLS: same "team_all"-style trust model already used across this
-- schema for internal tables (team_all on projects/items/etc. in
-- 001_initial.sql) plus service_role for the token-based portal route.
--   - service_role: full access — the portal action route
--     (recordPortalAction) is unauthenticated by session, so it always
--     uses the service-role client.
--   - authenticated: read (a future "pending digest" indicator could
--     use this) and update (POST /api/digest/flush uses the normal
--     session-backed client, since sending a digest is an
--     authenticated-team action, not a portal one, and stamps sent_at
--     via that same client). No authenticated insert policy — only
--     the portal route (service-role) creates rows.
alter table portal_digest_queue enable row level security;

drop policy if exists team_read_portal_digest_queue on portal_digest_queue;
create policy team_read_portal_digest_queue
  on portal_digest_queue for select
  to authenticated
  using (true);

drop policy if exists team_update_portal_digest_queue on portal_digest_queue;
create policy team_update_portal_digest_queue
  on portal_digest_queue for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists service_role_all_portal_digest_queue on portal_digest_queue;
create policy service_role_all_portal_digest_queue
  on portal_digest_queue for all
  to service_role
  using (true)
  with check (true);
