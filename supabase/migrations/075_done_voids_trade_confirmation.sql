-- ============================================================
-- Done is terminal for a linked trade booking.
--
-- A board card can carry the visit that generated a confirmation
-- request. Once that card is moved into a Done-like column, there is
-- no useful confirmation left to collect: the work has happened.
--
-- This migration keeps that rule at the database boundary so it also
-- applies to board moves made by Aria or another API client, not only
-- moves made by the current web UI.
-- ============================================================

alter table trade_visits
  drop constraint if exists trade_visits_status_check;

alter table trade_visits
  add constraint trade_visits_status_check
  check (
    status in (
      'unconfirmed',
      'confirmed',
      'tentative',
      'declined',
      'proposed_change',
      'completed'
    )
  );

alter table trade_visits
  drop constraint if exists trade_visits_line_status_check;

alter table trade_visits
  add constraint trade_visits_line_status_check
  check (line_status in ('proposed', 'accepted', 'date_suggested', 'voided'));

comment on column trade_visits.status is
  'Trade visit lifecycle. completed is terminal and is set when the linked board task enters a Done/Complete/Completed column; completed visits cannot be confirmed, reminded or re-opened through a public response link.';

comment on column trade_visits.line_status is
  'Grouped trade booking line lifecycle. voided means the linked work was marked Done before confirmation was required. A voided line is resolved, read-only and excluded from outstanding confirmation counts.';

create or replace function complete_trade_visit_for_done_task(
  p_task_id uuid,
  p_visit_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_id uuid;
  v_has_proposed boolean;
  v_has_answered boolean;
begin
  if p_visit_id is null then
    return;
  end if;

  update trade_visits
     set status = 'completed',
         line_status = case
           when booking_request_id is not null
             and line_status in ('proposed', 'date_suggested')
             then 'voided'
           else line_status
         end,
         proposed_start = null,
         proposed_end = null,
         proposed_slot = null,
         proposed_time = null,
         proposed_note = null,
         suggested_start = null,
         suggested_end = null,
         response_note = null
   where id = p_visit_id
     and deleted_at is null
  returning booking_request_id into v_request_id;

  if not found then
    return;
  end if;

  -- A queued single-visit request must never leave after completion.
  -- Sent email cannot be recalled, so the token routes also reject and
  -- explain completed visits at read/respond time.
  update email_sends
     set status = 'skipped',
         scheduled_for = null,
         detail = coalesce(detail, '{}'::jsonb)
           || jsonb_build_object(
             'reason',
             'Confirmation voided because the linked work was marked done'
           )
   where record_type = 'trade_booking_request'
     and record_id = p_visit_id
     and template = 'trade-booking-reply'
     and status = 'pending';

  if v_request_id is null then
    return;
  end if;

  select
    bool_or(line_status = 'proposed'),
    bool_or(line_status in ('accepted', 'date_suggested'))
    into v_has_proposed, v_has_answered
    from trade_visits
   where booking_request_id = v_request_id
     and deleted_at is null;

  if coalesce(v_has_proposed, false) then
    -- Other lines in the grouped request still need an answer.
    null;
  elsif coalesce(v_has_answered, false) then
    update trade_booking_requests
       set status = 'responded',
           responded_at = coalesce(responded_at, now())
     where id = v_request_id
       and status not in ('responded', 'closed');
  else
    update trade_booking_requests
       set status = 'closed',
           responded_at = coalesce(responded_at, now())
     where id = v_request_id
       and status <> 'closed';

    -- If every grouped line is now void, suppress an email that has
    -- not yet left the queue.
    update email_sends
       set status = 'skipped',
           scheduled_for = null,
           detail = coalesce(detail, '{}'::jsonb)
             || jsonb_build_object(
               'reason',
               'Booking request closed because all linked work was marked done'
             )
     where record_type = 'trade_booking_request'
       and record_id = v_request_id
       and template = 'trade-booking-request'
       and status = 'pending';
  end if;

  -- A previously suggested date can leave a staff attention item.
  -- Completion resolves that item because there is no date decision
  -- left to make.
  update daily_brief_items
     set status = 'done',
         acknowledged_at = coalesce(acknowledged_at, now())
   where source = 'trade'
     and status = 'open'
     and link_href = '/trade-requests/' || v_request_id::text
       || '?focus=line-' || p_visit_id::text;
end;
$$;

revoke all on function complete_trade_visit_for_done_task(uuid, uuid) from public;
revoke all on function complete_trade_visit_for_done_task(uuid, uuid) from anon;
revoke all on function complete_trade_visit_for_done_task(uuid, uuid) from authenticated;

create or replace function void_trade_confirmation_when_task_done()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_column_name text;
begin
  if new.deleted_at is not null or new.visit_id is null then
    return new;
  end if;

  select name into v_column_name
    from board_columns
   where id = new.column_id;

  if lower(trim(coalesce(v_column_name, ''))) in ('done', 'complete', 'completed')
     and (
       new.column_id is distinct from old.column_id
       or new.visit_id is distinct from old.visit_id
     ) then
    perform complete_trade_visit_for_done_task(new.id, new.visit_id);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_board_task_done_voids_confirmation on board_tasks;
create trigger trg_board_task_done_voids_confirmation
  after update of column_id, visit_id on board_tasks
  for each row execute function void_trade_confirmation_when_task_done();

-- Repair any currently linked confirmation that was already sitting
-- in a Done-like column before this rule was installed.
do $$
declare
  row_to_close record;
begin
  for row_to_close in
    select bt.id, bt.visit_id
      from board_tasks bt
      join board_columns bc on bc.id = bt.column_id
     where bt.deleted_at is null
       and bt.visit_id is not null
       and lower(trim(bc.name)) in ('done', 'complete', 'completed')
  loop
    perform complete_trade_visit_for_done_task(
      row_to_close.id,
      row_to_close.visit_id
    );
  end loop;
end;
$$;

notify pgrst, 'reload schema';
