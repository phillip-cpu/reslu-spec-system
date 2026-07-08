-- ============================================================
-- RESLU Spec System — Second Brain, Step 1: aria_queue.
-- docs/RESLU-second-brain-build-brief.md, Step 1.
--
-- Adapted from the brief's literal SQL to match this schema's
-- established conventions (see migration 030's header for the
-- fullest recent statement of these):
--   - text + check constraint instead of native Postgres enum types
--     — no other table in this schema uses `create type ... as enum`;
--     every status/kind column uses `text not null check (... in
--     (...))` (e.g. schedule_phases.kind, board_tasks.kind). Kept
--     consistent here rather than introducing this codebase's first
--     enum type — a check constraint is also easier to extend later
--     (drop/recreate the constraint, no `alter type ... add value`
--     ceremony a native enum would need).
--   - RLS: permissive "team_all" policy (authenticated role), same as
--     every other table. Aria authenticates as a REAL user
--     (aria@reslu.com.au, via the Bearer-JWT branch in
--     lib/supabase/server.ts), not the service role, so this table
--     needs the same policy every other authenticated-readable table
--     has — real enforcement (which queue kinds Aria can read/write,
--     etc.) happens at the MCP tool / API route layer, not RLS, per
--     this app's stated "no unenforced role theatre" split.
--   - idempotent throughout so a partial apply converges cleanly on
--     re-run.
-- ============================================================
create table if not exists aria_queue (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in
                 ('price_request','trade_reminder','lead_flag','approval_needed','email_proposal')),
  status       text not null default 'pending' check (status in
                 ('pending','picked_up','done','failed')),
  payload      jsonb not null default '{}',
  dedupe_key   text unique,
  source       text,
  created_at   timestamptz not null default now(),
  picked_up_at timestamptz,
  resolved_at  timestamptz,
  attempts     int not null default 0,
  error        text
);

create index if not exists aria_queue_pending_idx on aria_queue (status, created_at);

alter table aria_queue enable row level security;

drop policy if exists "team_all" on aria_queue;
create policy "team_all" on aria_queue
  for all to authenticated using (true) with check (true);

comment on table aria_queue is
  'RESLU Second Brain, Step 1 (docs/RESLU-second-brain-build-brief.md). Aria''s work queue — spec-system events land here as rows; Aria polls via get_aria_queue/resolve_queue_item (Step 2 MCP tools, a later migration/round). dedupe_key is a business key like price_request:{item_id}:{yyyy-mm} — inserts use on conflict (dedupe_key) do nothing, so re-raising the same event is a silent no-op. Delivery is at-least-once; handlers must be idempotent. Rows are never deleted — resolved rows are the audit trail. A picked_up row older than 15 minutes is treated as abandoned and re-exposed (visibility timeout) — enforced by Step 2''s get_aria_queue query, not by this schema.';

notify pgrst, 'reload schema';
