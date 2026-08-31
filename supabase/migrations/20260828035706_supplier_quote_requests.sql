-- Supplier quote packages: one scope can cover many estimate lines and can
-- be sent independently to many suppliers. Email threads and attachments
-- hang off the supplier request, while the package-line junction makes the
-- full correspondence visible from every affected estimate line.

create table if not exists public.supplier_quote_packages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  scope text,
  requested_quote_date date,
  status text not null default 'draft'
    check (status in ('draft','sent','complete','closed')),
  sent_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.supplier_quote_package_lines (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.supplier_quote_packages(id) on delete cascade,
  cost_line_id uuid not null references public.cost_lines(id) on delete restrict,
  description_snapshot text not null,
  qty_snapshot numeric(12,3),
  unit_snapshot text,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (package_id, cost_line_id)
);

create table if not exists public.supplier_quote_requests (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.supplier_quote_packages(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  token text not null unique default encode(gen_random_bytes(32), 'hex'),
  status text not null default 'draft'
    check (status in ('draft','sent','acknowledged','quote_received','declined','selected','closed')),
  sent_to_email text,
  sent_at timestamptz,
  acknowledgement_due_at date,
  acknowledged_at timestamptz,
  promised_quote_at date,
  quote_received_at timestamptz,
  quote_amount_ex_gst numeric(12,2),
  quote_reference text,
  response_note text,
  provider_message_id text,
  provider_thread_id text,
  last_reply_at timestamptz,
  last_followup_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (package_id, contact_id)
);

create table if not exists public.supplier_quote_attachments (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.supplier_quote_packages(id) on delete cascade,
  request_id uuid references public.supplier_quote_requests(id) on delete cascade,
  kind text not null default 'request' check (kind in ('request','response')),
  storage_path text not null unique,
  filename text not null,
  mime text,
  caption text,
  byte_size bigint,
  sort integer not null default 0,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (kind = 'request' or request_id is not null)
);

create table if not exists public.supplier_quote_response_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.supplier_quote_requests(id) on delete cascade,
  package_line_id uuid not null references public.supplier_quote_package_lines(id) on delete cascade,
  amount_ex_gst numeric(12,2),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, package_line_id)
);

create table if not exists public.supplier_quote_request_emails (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.supplier_quote_requests(id) on delete cascade,
  email_id uuid not null references public.emails(id) on delete cascade,
  linked_at timestamptz not null default now(),
  unique (request_id, email_id)
);

create index if not exists idx_supplier_quote_packages_project
  on public.supplier_quote_packages(project_id, created_at desc)
  where deleted_at is null;
create index if not exists idx_supplier_quote_package_lines_cost_line
  on public.supplier_quote_package_lines(cost_line_id);
create index if not exists idx_supplier_quote_requests_package
  on public.supplier_quote_requests(package_id, status);
create unique index if not exists idx_supplier_quote_requests_provider_thread
  on public.supplier_quote_requests(provider_thread_id)
  where provider_thread_id is not null;
create index if not exists idx_supplier_quote_request_emails_email
  on public.supplier_quote_request_emails(email_id);
create index if not exists idx_supplier_quote_response_lines_request
  on public.supplier_quote_response_lines(request_id);
create index if not exists idx_supplier_quote_attachments_package
  on public.supplier_quote_attachments(package_id);
create index if not exists idx_supplier_quote_attachments_request
  on public.supplier_quote_attachments(request_id)
  where request_id is not null;
create index if not exists idx_supplier_quote_attachments_uploaded_by
  on public.supplier_quote_attachments(uploaded_by)
  where uploaded_by is not null;
create index if not exists idx_supplier_quote_packages_created_by
  on public.supplier_quote_packages(created_by)
  where created_by is not null;
create index if not exists idx_supplier_quote_requests_contact
  on public.supplier_quote_requests(contact_id)
  where contact_id is not null;
create index if not exists idx_supplier_quote_requests_created_by
  on public.supplier_quote_requests(created_by)
  where created_by is not null;
create index if not exists idx_supplier_quote_response_lines_package_line
  on public.supplier_quote_response_lines(package_line_id);

drop trigger if exists trg_supplier_quote_packages_updated_at on public.supplier_quote_packages;
create trigger trg_supplier_quote_packages_updated_at
  before update on public.supplier_quote_packages
  for each row execute function public.set_updated_at();
drop trigger if exists trg_supplier_quote_requests_updated_at on public.supplier_quote_requests;
create trigger trg_supplier_quote_requests_updated_at
  before update on public.supplier_quote_requests
  for each row execute function public.set_updated_at();
drop trigger if exists trg_supplier_quote_response_lines_updated_at on public.supplier_quote_response_lines;
create trigger trg_supplier_quote_response_lines_updated_at
  before update on public.supplier_quote_response_lines
  for each row execute function public.set_updated_at();

-- Exact Gmail thread linkage is deterministic. The inbound pipeline inserts
-- an email before triage, then later updates triage_label; this trigger runs
-- for both phases so acknowledgement happens immediately and a subsequent
-- supplier_quote classification upgrades the request to quote_received.
create or replace function public.link_supplier_quote_email()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_request_id uuid;
begin
  if new.thread_id is null then return new; end if;

  select id into v_request_id
  from public.supplier_quote_requests
  where provider_thread_id = new.thread_id
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
  after insert or update of thread_id, triage_label on public.emails
  for each row execute function public.link_supplier_quote_email();

alter table public.supplier_quote_packages enable row level security;
alter table public.supplier_quote_package_lines enable row level security;
alter table public.supplier_quote_requests enable row level security;
alter table public.supplier_quote_attachments enable row level security;
alter table public.supplier_quote_request_emails enable row level security;
alter table public.supplier_quote_response_lines enable row level security;

-- Quote information is financial. The unauthenticated supplier page uses
-- the service-role client after validating the unguessable request token.
do $$
declare t text;
begin
  foreach t in array array[
    'supplier_quote_packages',
    'supplier_quote_package_lines',
    'supplier_quote_requests',
    'supplier_quote_attachments',
    'supplier_quote_request_emails',
    'supplier_quote_response_lines'
  ] loop
    execute format('drop policy if exists "admin_all" on public.%I', t);
    execute format(
      'create policy "admin_all" on public.%I for all to authenticated using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = ''admin'')) with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = ''admin''))',
      t
    );
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
  end loop;
end $$;

revoke all on function public.link_supplier_quote_email() from public, anon, authenticated;

comment on table public.supplier_quote_packages is
  'One reusable RFQ scope linked to one or more estimate cost lines and sent independently to one or more suppliers.';
comment on column public.supplier_quote_requests.provider_thread_id is
  'Gmail thread id returned by the original send; exact key used to attach inbound and sent-folder email history.';

notify pgrst, 'reload schema';
