-- A lead marked Lead Lost has no live fee proposal left to chase.
-- Close any outstanding draft/sent proposal, cancel its queued email,
-- and backfill leads that were already lost before this rule existed.

create or replace function close_proposals_for_lost_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proposal_ids uuid[];
begin
  if new.stage = 'Lead Lost'
     and old.stage is distinct from new.stage then
    select coalesce(array_agg(p.id), '{}'::uuid[])
      into v_proposal_ids
    from proposals p
    where p.lead_id = new.id
      and p.status in ('draft', 'sent');

    update email_sends
    set status = 'skipped',
        scheduled_for = null
    where record_type = 'proposal'
      and record_id = any(v_proposal_ids)
      and status = 'pending';

    update proposals
    set status = 'closed'
    where id = any(v_proposal_ids);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_close_proposals_for_lost_lead on leads;
create trigger trg_close_proposals_for_lost_lead
  after update of stage on leads
  for each row
  execute function close_proposals_for_lost_lead();

with proposals_to_close as (
  update proposals p
  set status = 'closed'
  from leads l
  where p.lead_id = l.id
    and l.stage = 'Lead Lost'
    and p.status in ('draft', 'sent')
  returning p.id
)
update email_sends e
set status = 'skipped',
    scheduled_for = null
where e.record_type = 'proposal'
  and e.status = 'pending'
  and e.record_id in (select id from proposals_to_close);

notify pgrst, 'reload schema';
