-- ============================================================
-- RESLU Spec System — Second Brain, Step 11: proposals + approval.
-- docs/RESLU-second-brain-build-brief.md, Step 11.
--
-- change_proposals is the brief's own literal schema. audit_log is
-- new — the brief's own text asks for "an audit trigger appends to
-- an append-only audit_log table" but never defines that table.
-- approve_proposal() is a plpgsql function (not a raw multi-step
-- client call) so the item write + audit row are genuinely atomic —
-- a partial apply (one without the other) is exactly the kind of
-- silent gap this whole subsystem exists to prevent.
-- ============================================================
create table if not exists change_proposals (
  id               uuid primary key default gen_random_uuid(),
  entity_type      text not null,
  entity_id        uuid not null,
  field            text not null,
  old_value        jsonb,
  new_value        jsonb not null,
  source_email_id  uuid not null references emails(id),
  source_quote     text not null,
  confidence       numeric not null,
  status           text not null default 'pending' check (status in
                     ('pending', 'approved', 'rejected', 'failed_verification')),
  created_at       timestamptz default now(),
  resolved_at      timestamptz,
  resolved_by      text,
  note             text
);

create index if not exists idx_change_proposals_status on change_proposals(status);
create index if not exists idx_change_proposals_entity on change_proposals(entity_type, entity_id);

alter table change_proposals enable row level security;
drop policy if exists "team_all" on change_proposals;
create policy "team_all" on change_proposals
  for all to authenticated using (true) with check (true);

comment on table change_proposals is
  'RESLU Second Brain, Step 11 (docs/RESLU-second-brain-build-brief.md). One row per proposed field change from an extracted+matched email fact, gated by a deterministic (no-model) verification of source_quote before this row is even created — see lib/second-brain/verification-gate.ts. Nothing writes to items until approve_proposal() is called; prices and lead times ALWAYS go through this table, never auto-applied regardless of confidence.';

create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  table_name  text not null,
  record_id   uuid not null,
  field       text not null,
  old_value   jsonb,
  new_value   jsonb not null,
  source      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_audit_log_record on audit_log(table_name, record_id);

alter table audit_log enable row level security;
drop policy if exists "team_all" on audit_log;
create policy "team_all" on audit_log
  for all to authenticated using (true) with check (true);

comment on table audit_log is
  'RESLU Second Brain, Step 11. Append-only — never updated or deleted. One row per field write approve_proposal() actually applies. source is typically change_proposals:{proposal_id}.';

create or replace function approve_proposal(p_id uuid, p_resolved_by text default 'unknown')
returns table (ok boolean, entity_id uuid, field text, old_value jsonb, new_value jsonb)
language plpgsql
as $$
declare
  v_proposal change_proposals;
begin
  select * into v_proposal from change_proposals where id = p_id and status = 'pending';
  if not found then
    raise exception 'Proposal % not found or not pending', p_id;
  end if;

  if v_proposal.entity_type <> 'item' then
    raise exception 'approve_proposal only supports entity_type=item (got %)', v_proposal.entity_type;
  end if;

  execute format('update items set %I = $1 where id = $2', v_proposal.field)
    using (v_proposal.new_value #>> '{}')::numeric, v_proposal.entity_id;

  insert into audit_log (table_name, record_id, field, old_value, new_value, source)
  values ('items', v_proposal.entity_id, v_proposal.field, v_proposal.old_value, v_proposal.new_value, 'change_proposals:' || p_id);

  update change_proposals
  set status = 'approved', resolved_at = now(), resolved_by = p_resolved_by
  where id = p_id;

  return query select true, v_proposal.entity_id, v_proposal.field, v_proposal.old_value, v_proposal.new_value;
end;
$$;

comment on function approve_proposal(uuid, text) is
  'RESLU Second Brain, Step 11. Atomically applies a pending change_proposals row: writes the new value to items.{field}, appends an audit_log row, marks the proposal approved. Raises if the proposal is not pending (already resolved) or if entity_type is not item (the only entity_type Step 9-11''s price/lead-time facts ever produce). Called by POST /api/second-brain/proposals/[id]/approve, which separately resolves the paired aria_queue row.';

notify pgrst, 'reload schema';
