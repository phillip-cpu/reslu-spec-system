-- ============================================================
-- RESLU Spec System — Second Brain, Step 2: aria_queue claim function.
-- docs/RESLU-second-brain-build-brief.md, Step 2.
--
-- Postgres has no LIMIT clause on UPDATE — "atomically claim the
-- oldest N pending/expired rows" cannot be expressed as a single
-- plain UPDATE, and the plain PostgREST/supabase-js query builder has
-- no way to express `SELECT ... FOR UPDATE SKIP LOCKED ... LIMIT n`
-- at all. This function is the one place that logic lives; the API
-- route (POST /api/aria-queue/claim) calls it via supabase.rpc(),
-- never reimplements the claim logic itself.
--
-- SECURITY INVOKER (the default — no SECURITY DEFINER needed): this
-- schema's RLS is a permissive "team_all" policy on aria_queue
-- (migration 033) that already allows any authenticated user to
-- update any row, so the function runs fine under the calling (Aria)
-- user's own privileges — no privilege escalation required.
-- ============================================================
create or replace function claim_aria_queue_items(p_limit int default 10)
returns setof aria_queue
language plpgsql
as $$
begin
  return query
  update aria_queue
  set status = 'picked_up',
      picked_up_at = now(),
      attempts = attempts + 1
  where id in (
    select id from aria_queue
    where status = 'pending'
       or (status = 'picked_up' and picked_up_at < now() - interval '15 minutes')
    order by created_at asc
    limit p_limit
    for update skip locked
  )
  returning *;
end;
$$;

comment on function claim_aria_queue_items(int) is
  'RESLU Second Brain, Step 2. Atomically claims up to p_limit pending (or abandoned — picked_up more than 15 minutes ago, the visibility timeout for a crashed Aria mid-item) rows: sets status=''picked_up'', picked_up_at=now(), attempts=attempts+1, oldest-first. FOR UPDATE SKIP LOCKED guarantees two concurrent callers never claim the same row. Called by POST /api/aria-queue/claim, which is the MCP tool get_aria_queue''s thin-fetch target.';

notify pgrst, 'reload schema';
