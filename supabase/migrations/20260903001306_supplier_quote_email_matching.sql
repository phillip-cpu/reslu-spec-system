-- A mailbox-native Gmail thread can be recognised even when the original
-- message was sent directly from Gmail/Safari rather than from RESLU.  Keep
-- the machine's evidence separate from the financial quote register until
-- the match is either safely auto-linked or confirmed by an admin.

create table if not exists public.supplier_quote_email_matches (
  id uuid primary key default gen_random_uuid(),
  seed_email_id uuid not null references public.emails(id) on delete cascade,
  provider_mailbox text not null,
  provider_thread_id text not null,
  external_email text,
  subject text,
  project_id uuid references public.projects(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  project_confidence numeric(5,4) not null default 0 check (project_confidence between 0 and 1),
  contact_confidence numeric(5,4) not null default 0 check (contact_confidence between 0 and 1),
  overall_confidence numeric(5,4) not null default 0 check (overall_confidence between 0 and 1),
  status text not null default 'review' check (status in ('review', 'auto_linked', 'confirmed', 'dismissed')),
  evidence jsonb not null default '{}'::jsonb,
  package_id uuid references public.supplier_quote_packages(id) on delete set null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_mailbox, provider_thread_id)
);

create table if not exists public.supplier_quote_email_match_lines (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.supplier_quote_email_matches(id) on delete cascade,
  cost_line_id uuid not null references public.cost_lines(id) on delete cascade,
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  reason text not null,
  selected boolean not null default true,
  created_at timestamptz not null default now(),
  unique (match_id, cost_line_id)
);

create index if not exists idx_supplier_quote_email_matches_project_review
  on public.supplier_quote_email_matches(project_id, status, created_at desc);
create index if not exists idx_supplier_quote_email_matches_seed
  on public.supplier_quote_email_matches(seed_email_id);
create index if not exists idx_supplier_quote_email_match_lines_match
  on public.supplier_quote_email_match_lines(match_id, confidence desc);

drop trigger if exists trg_supplier_quote_email_matches_updated_at on public.supplier_quote_email_matches;
create trigger trg_supplier_quote_email_matches_updated_at
  before update on public.supplier_quote_email_matches
  for each row execute function public.set_updated_at();

alter table public.supplier_quote_email_matches enable row level security;
alter table public.supplier_quote_email_match_lines enable row level security;

drop policy if exists "admin_all" on public.supplier_quote_email_matches;
create policy "admin_all" on public.supplier_quote_email_matches
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin'));

drop policy if exists "admin_all" on public.supplier_quote_email_match_lines;
create policy "admin_all" on public.supplier_quote_email_match_lines
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin'));

grant select, insert, update, delete on table public.supplier_quote_email_matches to authenticated;
grant select, insert, update, delete on table public.supplier_quote_email_match_lines to authenticated;
grant execute on function public.import_supplier_quote_thread(uuid, uuid, uuid, text, text, uuid[]) to service_role;
grant execute on function public.select_supplier_quote(uuid) to service_role;

comment on table public.supplier_quote_email_matches is
  'Auditable contact/project/scope match for an imported Gmail thread. High-confidence quote-request matches may create a quote package automatically; ambiguous matches remain visible for admin review.';
comment on table public.supplier_quote_email_match_lines is
  'Ranked estimate cost-line candidates for an imported quote email thread. selected marks the conservative default set shown to the reviewer.';

notify pgrst, 'reload schema';
