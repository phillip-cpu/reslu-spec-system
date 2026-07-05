-- ============================================================
-- RESLU Spec System — Phase 14A: performance indexes + error log
-- BUILD-SPEC.md §"Phase 14 — Speed, Security & Backups": "Speed:
-- region alignment (done earlier), image renditions everywhere,
-- pagination/windowing for 200+ item registers, index review, caching
-- (stable data + portal revalidate + PDF cache), measurement budgets
-- (portal <1.5s on 4G)." / "Backups: ... uptime + error monitoring
-- (Sentry or similar)."
--
-- This migration does two things:
--   PART 1 — new indexes for query patterns that genuinely lack one,
--            after auditing every existing index in 001-021 (see the
--            per-table notes below — most of the "heaviest query
--            patterns" this task was asked to check already have a
--            serving index from an earlier migration; only the gaps
--            are added here, no duplicates).
--   PART 2 — app_errors table (lib/report-error.ts's target) for the
--            zero-dep "System health" admin panel — BUILD-SPEC.md's
--            error-visibility ask for this task, landing in the same
--            migration per this codebase's established convention of
--            a feature's schema + its consuming code shipping together
--            (see e.g. migration 007's invoices table for the later
--            invoice-queue UI).
--
-- Conventions carried over from every prior migration (021 most
-- recently): idempotent throughout (create index/table if not exists),
-- set_updated_at() trigger helper reused not redefined, RLS via a
-- single permissive "team_all" policy for authenticated team access
-- where relevant, soft delete omitted where the brief doesn't call for
-- it (app_errors is append-only, like signature_events/approval_events
-- — no soft delete, no UPDATE/DELETE policy).
-- ============================================================

-- ============================================================
-- PART 1 — Missing indexes only
--
-- Audit method: grepped every `create index` across 001_initial.sql
-- through 021_office.sql against this task's named query patterns
-- before adding anything. Already covered, confirmed present, NOT
-- duplicated here:
--   - items by project+category / project+status / deleted_at
--     (idx_items_category, idx_items_status, idx_items_deleted_at —
--     001_initial.sql)
--   - items by project+room join (item_rooms(item_id)/(room_id) —
--     015_rooms.sql — GET /api/projects/[id]/items/rooms fetches
--     rooms(project_id) then item_rooms.in("room_id", ...), both sides
--     already indexed)
--   - portal token lookup (projects.client_token UNIQUE — 001_initial.sql
--     — a unique constraint already creates its own btree index) and
--     trade-visit token lookup (trade_visits.confirm_token UNIQUE —
--     016_trade_visits.sql, same reasoning)
--   - approval_events by item (idx_approval_events_item_id —
--     001_initial.sql)
--   - site_photos by project+published (idx_site_photos_published,
--     a partial index `where published_to_portal` — 017_portal_v2.sql
--     — exactly the portal page's query shape)
--   - board/office tasks by group (idx_board_tasks_column,
--     idx_board_tasks_phase_group, idx_office_tasks_group — 013/020/021)
--     and by assignee (idx_board_task_assignees_profile,
--     idx_office_task_assignees_profile — 020/021, join-table pattern)
--   - invoices by project+status (idx_invoices_status — 007_estimating.sql)
--
-- Genuine gaps, both surfaced by the SAME route — GET /api/my-work
-- (app/api/my-work/route.ts) — which deliberately queries several
-- tables with NO project_id filter at all (it's a cross-project,
-- per-user aggregator), so the existing (project_id, ...) composite
-- indexes on these two tables can't serve it (project_id isn't a
-- leading-column predicate in either query):
-- ============================================================

-- items: my-work source #5 ("overdue client decisions") queries
--   .is("deleted_at", null)
--   .not("decision_needed_by", "is", null)
--   .lt("decision_needed_by", today)
--   .eq("client_approved", false)
--   .eq("client_flagged", false)
-- with NO project_id predicate. The existing
-- idx_items_decision_needed_by (017_portal_v2.sql) is
-- `(project_id, decision_needed_by) where decision_needed_by is not
-- null and client_approved = false` — built for the per-project portal
-- "what's next"/overview use case, wrong leading column for my-work's
-- cross-project scan, and its partial predicate doesn't account for
-- client_flagged or deleted_at either. A second, purpose-built partial
-- index for the my-work shape, rather than widening the existing one
-- (which some other per-project query may depend on retaining its
-- current, narrower shape).
create index if not exists idx_items_mywork_decisions
  on items(decision_needed_by)
  where decision_needed_by is not null
    and client_approved = false
    and client_flagged = false
    and deleted_at is null;

-- portal_updates: my-work source #3 ("diary drafts pending my
-- approval") queries .eq("status", "pending_approval").is("deleted_at",
-- null) with NO project_id predicate — every team member sees every
-- project's pending drafts (BUILD-SPEC.md: "team-visible"). The
-- existing idx_portal_updates_status (017_portal_v2.sql) is
-- `(project_id, status)`, built for the portal page's own per-project
-- "give me this project's published updates" query — wrong leading
-- column for my-work's cross-project scan. A partial index on status
-- alone, scoped to the one status value this cross-project query
-- actually filters on, serves it directly without duplicating the
-- existing composite index's purpose.
create index if not exists idx_portal_updates_pending_approval
  on portal_updates(status)
  where status = 'pending_approval' and deleted_at is null;

-- ============================================================
-- PART 2 — app_errors (lib/report-error.ts's target table)
-- BUILD-SPEC.md Phase 14 "uptime + error monitoring (Sentry or
-- similar)" — this task's zero-dep approach: server-side catch blocks
-- write a row here (rate-limited per lib/report-error.ts) instead of
-- adding a Sentry dependency; the admin Settings "System health"
-- section lists the last 50. Append-only, like approval_events/
-- signature_events elsewhere in this schema — no soft delete, no
-- UPDATE/DELETE policy, since an error log's value is in never being
-- silently edited. `stack` is deliberately named/sized as an EXCERPT
-- (see lib/report-error.ts) — this is a lightweight admin panel, not a
-- full crash-reporting store; Sentry (documented in this task's report
-- as the upgrade path) is where a full stack + source maps + alerting
-- would live if this ever needs to grow up.
-- ============================================================
create table if not exists app_errors (
  id           uuid primary key default gen_random_uuid(),
  where_at     text not null,        -- e.g. "pdf-route", "scrape-pipeline", "monday-sync", "gmail-send", "signature-route"
  message      text not null,
  stack        text,                 -- excerpt only (lib/report-error.ts truncates), nullable — not every caught error has a stack
  created_at   timestamptz not null default now()
);

create index if not exists idx_app_errors_created_at on app_errors(created_at desc);
create index if not exists idx_app_errors_where_at on app_errors(where_at, created_at desc);

alter table app_errors enable row level security;

-- Team-readable (the System health panel is admin-only in the UI, but
-- per BUILD-SPEC.md §Security ("No unenforced role theatre") the real
-- gate belongs in the route/page, not RLS role theatre — same pattern
-- as every other admin-gated-in-app-only table in this schema, e.g.
-- leads). Writes happen exclusively via the service-role client in
-- lib/report-error.ts (server-only, bypasses RLS) — no insert policy
-- is needed for the anon/authenticated roles at all, and none is
-- granted, so a compromised browser session can never write fake rows
-- into this table.
drop policy if exists "team_read" on app_errors;
create policy "team_read" on app_errors
  for select to authenticated using (true);

notify pgrst, 'reload schema';
