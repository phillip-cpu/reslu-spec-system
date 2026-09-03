-- Supplier quote correspondence can cover direct-purchase FF&E as well as
-- trade estimate lines. Keep the two target types explicit so item costs can
-- reconcile to Finance without being confused with trade-package references.

create table if not exists public.supplier_quote_package_items (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.supplier_quote_packages(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete restrict,
  item_code_snapshot text,
  description_snapshot text not null,
  qty_snapshot numeric(12,3),
  unit_snapshot text,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (package_id, item_id)
);

create table if not exists public.supplier_quote_response_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.supplier_quote_requests(id) on delete cascade,
  package_item_id uuid not null references public.supplier_quote_package_items(id) on delete cascade,
  amount_ex_gst numeric(12,2),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, package_item_id)
);

create table if not exists public.supplier_quote_email_match_items (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.supplier_quote_email_matches(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  reason text not null,
  selected boolean not null default true,
  created_at timestamptz not null default now(),
  unique (match_id, item_id)
);

create index if not exists idx_supplier_quote_package_items_package
  on public.supplier_quote_package_items(package_id, sort);
create index if not exists idx_supplier_quote_package_items_item
  on public.supplier_quote_package_items(item_id);
create index if not exists idx_supplier_quote_response_items_request
  on public.supplier_quote_response_items(request_id);
create index if not exists idx_supplier_quote_response_items_package_item
  on public.supplier_quote_response_items(package_item_id);
create index if not exists idx_supplier_quote_email_match_items_match
  on public.supplier_quote_email_match_items(match_id, confidence desc);
create index if not exists idx_supplier_quote_email_match_items_item
  on public.supplier_quote_email_match_items(item_id);

drop trigger if exists trg_supplier_quote_response_items_updated_at on public.supplier_quote_response_items;
create trigger trg_supplier_quote_response_items_updated_at
  before update on public.supplier_quote_response_items
  for each row execute function public.set_updated_at();

alter table public.supplier_quote_package_items enable row level security;
alter table public.supplier_quote_response_items enable row level security;
alter table public.supplier_quote_email_match_items enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'supplier_quote_package_items',
    'supplier_quote_response_items',
    'supplier_quote_email_match_items'
  ] loop
    execute format('drop policy if exists "admin_all" on public.%I', t);
    execute format(
      'create policy "admin_all" on public.%I for all to authenticated using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = ''admin'')) with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = ''admin''))',
      t
    );
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
  end loop;
end $$;

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

  if selected_request.id is null then raise exception 'Quote request not found'; end if;
  if selected_request.status not in ('quote_received', 'selected') then
    raise exception 'Only a received quote can be selected';
  end if;

  select
    (select count(*)
     from public.supplier_quote_package_lines package_line
     left join public.supplier_quote_response_lines response_line
       on response_line.request_id = selected_request.id
      and response_line.package_line_id = package_line.id
     where package_line.package_id = selected_request.package_id
       and response_line.amount_ex_gst is null)
    +
    (select count(*)
     from public.supplier_quote_package_items package_item
     left join public.supplier_quote_response_items response_item
       on response_item.request_id = selected_request.id
      and response_item.package_item_id = package_item.id
     where package_item.package_id = selected_request.package_id
       and response_item.amount_ex_gst is null)
  into missing_amounts;

  if missing_amounts > 0 then
    raise exception 'Allocate an ex GST amount to every estimate line and FF&E item before selecting this quote';
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

  update public.items item
  set price_trade = round(
        response_item.amount_ex_gst /
        case when coalesce(package_item.qty_snapshot, 0) > 0 then package_item.qty_snapshot else 1 end,
        2
      ),
      supplier_contact_id = selected_request.contact_id,
      supplier = coalesce(contact.company, item.supplier),
      supplier_email = coalesce(selected_request.sent_to_email, contact.email, item.supplier_email)
  from public.supplier_quote_package_items package_item
  join public.supplier_quote_response_items response_item
    on response_item.package_item_id = package_item.id
   and response_item.request_id = selected_request.id
  left join public.contacts contact on contact.id = selected_request.contact_id
  where package_item.package_id = selected_request.package_id
    and item.id = package_item.item_id
    and item.cost_scope <> 'trade_package';

  update public.supplier_quote_requests
  set status = 'closed'
  where package_id = selected_request.package_id
    and id <> selected_request.id
    and status not in ('declined', 'closed');

  update public.supplier_quote_packages set status = 'complete'
  where id = selected_request.package_id;

  update public.supplier_quote_requests set status = 'selected'
  where id = selected_request.id
  returning * into selected_request;

  return selected_request;
end;
$$;

drop function if exists public.import_supplier_quote_thread(uuid, uuid, uuid, text, text, uuid[]);
create function public.import_supplier_quote_thread(
  p_project_id uuid,
  p_email_id uuid,
  p_contact_id uuid,
  p_title text,
  p_scope text,
  p_cost_line_ids uuid[],
  p_item_ids uuid[] default '{}'::uuid[]
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
  v_contact_company text;
  v_line_count integer;
  v_item_count integer;
  v_has_inbound boolean;
  v_has_quote boolean;
  v_sent_time timestamptz;
  v_first_reply timestamptz;
  v_last_reply timestamptz;
begin
  if trim(coalesce(p_title, '')) = '' then raise exception 'A package title is required'; end if;
  if coalesce(cardinality(p_cost_line_ids), 0) + coalesce(cardinality(p_item_ids), 0) = 0 then
    raise exception 'At least one estimate line or direct FF&E item is required';
  end if;

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
  where id = any(coalesce(p_cost_line_ids, '{}'::uuid[]))
    and project_id = p_project_id
    and deleted_at is null;
  if v_line_count <> (select count(distinct id) from unnest(coalesce(p_cost_line_ids, '{}'::uuid[])) id) then
    raise exception 'One or more estimate lines are invalid';
  end if;

  select count(*) into v_item_count
  from public.items
  where id = any(coalesce(p_item_ids, '{}'::uuid[]))
    and project_id = p_project_id
    and deleted_at is null
    and cost_scope <> 'trade_package';
  if v_item_count <> (select count(distinct id) from unnest(coalesce(p_item_ids, '{}'::uuid[])) id) then
    raise exception 'One or more FF&E items are invalid or included in a trade package';
  end if;

  select email, company into v_contact_email, v_contact_company
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

  select email.gmail_refs ->> v_provider_mailbox into v_provider_message_id
  from public.emails email
  where email.gmail_thread_refs ->> v_provider_mailbox = v_provider_thread_id
  order by case when email.direction = 'sent' then 0 else 1 end, email.received_at
  limit 1;

  insert into public.supplier_quote_packages(project_id, title, scope, status, sent_at, created_by)
  values (p_project_id, trim(p_title), nullif(trim(coalesce(p_scope, '')), ''), 'sent', coalesce(v_sent_time, source_email.received_at), auth.uid())
  returning id into v_package_id;

  insert into public.supplier_quote_package_lines(package_id, cost_line_id, description_snapshot, qty_snapshot, unit_snapshot, sort)
  select v_package_id, line.id, line.description, line.qty, line.unit, line.sort
  from public.cost_lines line
  where line.id = any(coalesce(p_cost_line_ids, '{}'::uuid[]))
  order by line.sort;

  insert into public.supplier_quote_package_items(package_id, item_id, item_code_snapshot, description_snapshot, qty_snapshot, unit_snapshot, sort)
  select v_package_id, item.id, item.item_code, item.name, item.quantity, item.unit,
         row_number() over (order by item.item_code, item.name)::integer
  from public.items item
  where item.id = any(coalesce(p_item_ids, '{}'::uuid[]))
  order by item.item_code, item.name;

  insert into public.supplier_quote_requests(
    package_id, contact_id, status, sent_to_email, sent_at,
    acknowledged_at, quote_received_at, last_reply_at,
    provider_message_id, provider_thread_id, provider_mailbox, created_by
  ) values (
    v_package_id, p_contact_id,
    case when v_has_quote then 'quote_received' when v_has_inbound then 'acknowledged' else 'sent' end,
    v_contact_email, coalesce(v_sent_time, source_email.received_at), v_first_reply,
    case when v_has_quote then v_first_reply else null end, v_last_reply,
    v_provider_message_id, v_provider_thread_id, v_provider_mailbox, auth.uid()
  ) returning id into v_request_id;

  insert into public.supplier_quote_request_emails(request_id, email_id)
  select v_request_id, email.id
  from public.emails email
  where email.gmail_thread_refs ->> v_provider_mailbox = v_provider_thread_id
  on conflict (request_id, email_id) do nothing;

  update public.cost_lines
  set quote_status = coalesce(quote_status, 'S'),
      contact_id = coalesce(contact_id, p_contact_id)
  where id = any(coalesce(p_cost_line_ids, '{}'::uuid[]));

  update public.items
  set supplier_contact_id = coalesce(supplier_contact_id, p_contact_id),
      supplier = coalesce(nullif(trim(supplier), ''), v_contact_company),
      supplier_email = coalesce(nullif(trim(supplier_email), ''), v_contact_email)
  where id = any(coalesce(p_item_ids, '{}'::uuid[]))
    and cost_scope <> 'trade_package';

  return v_package_id;
end;
$$;

revoke all on function public.import_supplier_quote_thread(uuid, uuid, uuid, text, text, uuid[], uuid[]) from public, anon;
grant execute on function public.import_supplier_quote_thread(uuid, uuid, uuid, text, text, uuid[], uuid[]) to authenticated, service_role;
grant execute on function public.select_supplier_quote(uuid) to service_role;

comment on table public.supplier_quote_package_items is
  'Direct-purchase FF&E items included in a supplier RFQ. Snapshot fields preserve what the supplier was asked to price.';
comment on table public.supplier_quote_response_items is
  'Supplier quote allocation per included FF&E item. Selecting the quote writes the unit trade price back to the live item.';
comment on table public.supplier_quote_email_match_items is
  'Ranked direct-purchase FF&E candidates for an automatically detected quote email thread.';
comment on function public.import_supplier_quote_thread(uuid, uuid, uuid, text, text, uuid[], uuid[]) is
  'Atomically attaches an existing Gmail thread to a quote package, Address Book contact, estimate lines and/or direct FF&E items.';

notify pgrst, 'reload schema';
