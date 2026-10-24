-- Disposable synthetic entry-path fixture only. Not a migration.
alter table projects add column client_token uuid, add column estimate_markup_pct numeric default 20;
alter table estimate_versions add column label text, add column kind text, add column note text, add column created_by uuid, add column created_at timestamptz default now(), add column updated_at timestamptz default now();
alter table sow_documents add column deleted_at timestamptz, add column created_at timestamptz default now(), add column status text default 'draft';
create table cost_sections(id uuid primary key default gen_random_uuid(),project_id uuid references projects(id),name text,sort integer default 0);
create table cost_lines(id uuid primary key,section_id uuid references cost_sections(id),deleted_at timestamptz,sort integer);
create table cost_line_source_payments(id uuid primary key,cost_line_id uuid references cost_lines(id));
create table variations(id uuid primary key,project_id uuid references projects(id),status text,cost_ex_gst numeric,deleted_at timestamptz,var_number integer);
create table measurement_groups(id uuid primary key,project_id uuid references projects(id),name text,sort integer);
create table measurements(id uuid primary key,project_id uuid references projects(id),group_id uuid references measurement_groups(id),sort integer,value numeric);
create table items(id uuid primary key,project_id uuid references projects(id),category text,quantity numeric,price_trade numeric,price_rrp numeric,markup_pct numeric,cost_scope text,measurement_id uuid,wastage_pct numeric,coverage_per_unit numeric,deleted_at timestamptz);
create table categories(prefix text,name text);
create table supplier_quote_packages(id uuid primary key,project_id uuid references projects(id),title text,deleted_at timestamptz);
do $$ declare t text; begin
 foreach t in array array['cost_sections','cost_lines','cost_line_source_payments','variations','measurement_groups','measurements','items','categories','supplier_quote_packages','estimate_versions','sow_documents'] loop
 execute format('alter table %I enable row level security',t);
 execute format('create policy synthetic_admin_read on %I for select to authenticated using (exists(select 1 from profiles where id=auth.uid() and role=''admin''))',t);
 execute format('grant select on %I to authenticated',t);
 end loop;
end $$;
