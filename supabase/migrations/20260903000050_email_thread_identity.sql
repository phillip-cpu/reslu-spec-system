-- Keep the mailbox-native Gmail conversation identity instead of trying to
-- reconstruct it from MIME References/Thread-Index headers. Gmail thread ids
-- are mailbox-scoped, so the canonical email row stores a mailbox -> thread id
-- map alongside the existing mailbox -> message id map.

alter table public.emails
  add column if not exists to_addrs text[] not null default '{}'::text[],
  add column if not exists cc_addrs text[] not null default '{}'::text[],
  add column if not exists gmail_thread_refs jsonb not null default '{}'::jsonb;

create index if not exists idx_emails_gmail_thread_refs
  on public.emails using gin (gmail_thread_refs);

alter table public.supplier_quote_requests
  add column if not exists provider_mailbox text;

drop index if exists public.idx_supplier_quote_requests_provider_thread;
create unique index if not exists idx_supplier_quote_requests_provider_mailbox_thread
  on public.supplier_quote_requests(provider_mailbox, provider_thread_id)
  where provider_mailbox is not null and provider_thread_id is not null;

create or replace function public.link_supplier_quote_email()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_request_id uuid;
begin
  if new.thread_id is null and new.gmail_thread_refs = '{}'::jsonb then
    return new;
  end if;

  select request.id into v_request_id
  from public.supplier_quote_requests request
  where request.provider_thread_id is not null
    and (
      (
        request.provider_mailbox is not null
        and new.gmail_thread_refs ->> lower(request.provider_mailbox) = request.provider_thread_id
      )
      or (
        request.provider_mailbox is null
        and exists (
          select 1
          from jsonb_each_text(new.gmail_thread_refs) thread_ref
          where thread_ref.value = request.provider_thread_id
        )
      )
      -- Compatibility for rows ingested before mailbox-scoped thread ids
      -- were introduced. New Gmail rows use gmail_thread_refs above.
      or new.thread_id = request.provider_thread_id
    )
  order by request.created_at desc
  limit 1;

  if v_request_id is null then return new; end if;

  insert into public.supplier_quote_request_emails(request_id, email_id)
  values (v_request_id, new.id)
  on conflict (request_id, email_id) do nothing;

  if new.direction = 'inbound' then
    update public.supplier_quote_requests
    set acknowledged_at = coalesce(acknowledged_at, new.received_at),
        last_reply_at = greatest(coalesce(last_reply_at, new.received_at), new.received_at),
        status = case
          when new.triage_label = 'supplier_quote' then 'quote_received'
          when status in ('draft','sent') then 'acknowledged'
          else status
        end,
        quote_received_at = case
          when new.triage_label = 'supplier_quote' then coalesce(quote_received_at, new.received_at)
          else quote_received_at
        end
    where id = v_request_id
      and status not in ('declined','selected','closed');
  end if;

  return new;
end;
$$;

drop trigger if exists trg_link_supplier_quote_email on public.emails;
create trigger trg_link_supplier_quote_email
  after insert or update of thread_id, gmail_thread_refs, triage_label on public.emails
  for each row execute function public.link_supplier_quote_email();

revoke all on function public.link_supplier_quote_email() from public, anon, authenticated;

-- Selecting a supplier is a financial write: all line amounts, the winning
-- contact and the competing request/package statuses move together or not at
-- all. The API checks admin capability before invoking this security-invoker
-- function, and RLS remains active for every touched table.
create or replace function public.select_supplier_quote(p_request_id uuid)
returns public.supplier_quote_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  selected_request public.supplier_quote_requests%rowtype;
  missing_amounts integer;
begin
  select * into selected_request
  from public.supplier_quote_requests
  where id = p_request_id
  for update;

  if selected_request.id is null then
    raise exception 'Quote request not found';
  end if;
  if selected_request.status not in ('quote_received', 'selected') then
    raise exception 'Only a received quote can be selected';
  end if;

  select count(*) into missing_amounts
  from public.supplier_quote_package_lines package_line
  left join public.supplier_quote_response_lines response_line
    on response_line.request_id = selected_request.id
   and response_line.package_line_id = package_line.id
  where package_line.package_id = selected_request.package_id
    and response_line.amount_ex_gst is null;

  if missing_amounts > 0 then
    raise exception 'Allocate an ex GST amount to every estimate line before selecting this quote';
  end if;

  update public.cost_lines cost_line
  set quote_status = 'Q',
      contact_id = selected_request.contact_id,
      cost_ex_gst = response_line.amount_ex_gst
  from public.supplier_quote_package_lines package_line
  join public.supplier_quote_response_lines response_line
    on response_line.package_line_id = package_line.id
   and response_line.request_id = selected_request.id
  where package_line.package_id = selected_request.package_id
    and cost_line.id = package_line.cost_line_id;

  update public.supplier_quote_requests
  set status = 'closed'
  where package_id = selected_request.package_id
    and id <> selected_request.id
    and status not in ('declined', 'closed');

  update public.supplier_quote_packages
  set status = 'complete'
  where id = selected_request.package_id;

  update public.supplier_quote_requests
  set status = 'selected'
  where id = selected_request.id
  returning * into selected_request;

  return selected_request;
end;
$$;

revoke all on function public.select_supplier_quote(uuid) from public, anon;
grant execute on function public.select_supplier_quote(uuid) to authenticated;

create or replace function public.import_supplier_quote_thread(
  p_project_id uuid,
  p_email_id uuid,
  p_contact_id uuid,
  p_title text,
  p_scope text,
  p_cost_line_ids uuid[]
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  source_email public.emails%rowtype;
  v_provider_mailbox text;
  v_provider_thread_id text;
  v_provider_message_id text;
  v_package_id uuid;
  v_request_id uuid;
  v_contact_email text;
  v_line_count integer;
  v_has_inbound boolean;
  v_has_quote boolean;
  v_sent_time timestamptz;
  v_first_reply timestamptz;
  v_last_reply timestamptz;
begin
  if trim(coalesce(p_title, '')) = '' then raise exception 'A package title is required'; end if;
  if coalesce(cardinality(p_cost_line_ids), 0) = 0 then raise exception 'At least one estimate line is required'; end if;

  select * into source_email from public.emails where id = p_email_id;
  if source_email.id is null then raise exception 'Email not found'; end if;
  if exists (select 1 from public.supplier_quote_request_emails where email_id = p_email_id) then
    raise exception 'This email is already linked to a quote request';
  end if;

  select thread_ref.key, thread_ref.value
  into v_provider_mailbox, v_provider_thread_id
  from jsonb_each_text(source_email.gmail_thread_refs) thread_ref
  order by case thread_ref.key
    when 'aria@reslu.com.au' then 0
    when 'phillip@reslu.com.au' then 1
    when 'tenille@reslu.com.au' then 2
    else 3
  end
  limit 1;
  if v_provider_thread_id is null then raise exception 'This email has not been enriched with its Gmail thread id yet'; end if;

  select count(*) into v_line_count
  from public.cost_lines
  where id = any(p_cost_line_ids)
    and project_id = p_project_id
    and deleted_at is null;
  if v_line_count <> (select count(distinct id) from unnest(p_cost_line_ids) id) then
    raise exception 'One or more estimate lines are invalid';
  end if;

  select email into v_contact_email
  from public.contacts
  where id = p_contact_id and deleted_at is null;
  if not found then raise exception 'Address Book contact not found'; end if;

  select
    coalesce(bool_or(email.direction = 'inbound'), false),
    coalesce(bool_or(email.direction = 'inbound' and email.triage_label = 'supplier_quote'), false),
    min(email.received_at) filter (where email.direction = 'sent'),
    min(email.received_at) filter (where email.direction = 'inbound'),
    max(email.received_at) filter (where email.direction = 'inbound')
  into v_has_inbound, v_has_quote, v_sent_time, v_first_reply, v_last_reply
  from public.emails email
  where email.gmail_thread_refs ->> v_provider_mailbox = v_provider_thread_id;

  select email.gmail_refs ->> v_provider_mailbox
  into v_provider_message_id
  from public.emails email
  where email.gmail_thread_refs ->> v_provider_mailbox = v_provider_thread_id
  order by case when email.direction = 'sent' then 0 else 1 end, email.received_at
  limit 1;

  insert into public.supplier_quote_packages(
    project_id, title, scope, status, sent_at, created_by
  ) values (
    p_project_id, trim(p_title), nullif(trim(coalesce(p_scope, '')), ''), 'sent', coalesce(v_sent_time, source_email.received_at), auth.uid()
  ) returning id into v_package_id;

  insert into public.supplier_quote_package_lines(
    package_id, cost_line_id, description_snapshot, qty_snapshot, unit_snapshot, sort
  )
  select v_package_id, line.id, line.description, line.qty, line.unit, line.sort
  from public.cost_lines line
  where line.id = any(p_cost_line_ids)
  order by line.sort;

  insert into public.supplier_quote_requests(
    package_id, contact_id, status, sent_to_email, sent_at,
    acknowledged_at, quote_received_at, last_reply_at,
    provider_message_id, provider_thread_id, provider_mailbox, created_by
  ) values (
    v_package_id,
    p_contact_id,
    case when v_has_quote then 'quote_received' when v_has_inbound then 'acknowledged' else 'sent' end,
    v_contact_email,
    coalesce(v_sent_time, source_email.received_at),
    v_first_reply,
    case when v_has_quote then v_first_reply else null end,
    v_last_reply,
    v_provider_message_id,
    v_provider_thread_id,
    v_provider_mailbox,
    auth.uid()
  ) returning id into v_request_id;

  insert into public.supplier_quote_request_emails(request_id, email_id)
  select v_request_id, email.id
  from public.emails email
  where email.gmail_thread_refs ->> v_provider_mailbox = v_provider_thread_id
  on conflict (request_id, email_id) do nothing;

  update public.cost_lines
  set quote_status = coalesce(quote_status, 'S'),
      contact_id = coalesce(contact_id, p_contact_id)
  where id = any(p_cost_line_ids);

  return v_package_id;
end;
$$;

revoke all on function public.import_supplier_quote_thread(uuid, uuid, uuid, text, text, uuid[]) from public, anon;
grant execute on function public.import_supplier_quote_thread(uuid, uuid, uuid, text, text, uuid[]) to authenticated;

comment on column public.emails.gmail_thread_refs is
  'Map of lowercase RESLU mailbox address to Gmail API threadId. This is the deterministic conversation identity; MIME References/Thread-Index are not a Gmail thread id.';
comment on column public.emails.to_addrs is
  'Normalised recipient email addresses parsed from the RFC To header.';
comment on column public.emails.cc_addrs is
  'Normalised recipient email addresses parsed from the RFC Cc header.';
comment on column public.supplier_quote_requests.provider_mailbox is
  'Lowercase RESLU mailbox whose Gmail thread id is stored in provider_thread_id.';
comment on function public.select_supplier_quote(uuid) is
  'Atomically selects a fully costed supplier response, writes every linked estimate cost/contact, closes competing requests and completes the package.';
comment on function public.import_supplier_quote_thread(uuid, uuid, uuid, text, text, uuid[]) is
  'Atomically attaches one existing Gmail thread to a new supplier quote package, Address Book contact and validated estimate lines.';

notify pgrst, 'reload schema';
