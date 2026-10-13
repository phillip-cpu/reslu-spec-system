-- LOCAL REVIEW CANDIDATE ONLY. Apply in a transaction after separate approval.
-- Default OFF, no existing project data changed, no notifications/accounting writes.
do $$
begin
 if not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  join pg_roles r on r.oid=p.proowner
  where n.nspname='profile_security_private' and p.proname='guard_profile_role_change'
   and p.pronargs=0 and p.prosecdef and r.rolname='postgres'
   and p.proconfig=ARRAY['search_path=""']
   and md5(p.prosrc)='6ce62092764c08d795e38629a21b14ee'
   and exists(select 1 from pg_trigger t join pg_attribute a on a.attrelid=t.tgrelid and a.attname='role'
    where t.tgrelid='public.profiles'::regclass and t.tgname='guard_profile_role_change'
     and t.tgfoid=p.oid and t.tgtype=19 and t.tgenabled in ('O','A') and t.tgqual is null
     and t.tgattr::text=a.attnum::text)
 ) then raise exception 'Exact shared profile role guard prerequisite is missing or changed'; end if;
end $$;

create schema if not exists job_revision_private;
revoke all on schema job_revision_private from public, anon;
grant usage on schema job_revision_private to authenticated;
create table job_revision_private.release_gate(singleton boolean primary key default true check(singleton),enabled boolean not null default false);
insert into job_revision_private.release_gate values(true,false);
alter table job_revision_private.release_gate enable row level security;
revoke all on job_revision_private.release_gate from public,anon,authenticated,service_role;

alter table public.estimate_versions add column frozen_job_hash text;
create table public.job_revision_workspaces(
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete restrict,
 source_version_id uuid not null references public.estimate_versions(id) on delete restrict,
 source_hash text not null, label text not null check(length(trim(label)) between 1 and 80),
 payload jsonb not null, lock_version integer not null default 0,
 created_by uuid not null, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(project_id,label), unique(project_id,source_version_id,label)
);
alter table public.job_revision_workspaces enable row level security;
revoke all on public.job_revision_workspaces from public,anon,authenticated,service_role;
grant select on public.job_revision_workspaces to authenticated;
create policy revision_admin_read on public.job_revision_workspaces for select to authenticated using(exists(select 1 from public.profiles where id=auth.uid() and role='admin'));
create table job_revision_private.requests(
 request_id uuid primary key, actor_id uuid not null, operation text not null, input_hash text not null,
 workspace_id uuid references public.job_revision_workspaces(id) on delete restrict,
 result jsonb not null, created_at timestamptz not null default clock_timestamp()
);
alter table job_revision_private.requests enable row level security;
revoke all on job_revision_private.requests from public,anon,authenticated,service_role;

create function job_revision_private.hash(p jsonb) returns text language sql immutable set search_path='' as $$select encode(sha256(convert_to(p::text,'UTF8')),'hex')$$;
create function job_revision_private.authorize() returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid() and role='admin') then raise exception 'Admin access required' using errcode='42501'; end if;
 if not exists(select 1 from job_revision_private.release_gate where enabled) then raise exception 'Job revision release is disabled' using errcode='42501'; end if;
end$$;
create function job_revision_private.protect_frozen() returns trigger language plpgsql set search_path='' as $$
begin
 if old.frozen_job_hash is not null then raise exception 'Frozen job version is immutable'; end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end$$;
create trigger protect_frozen_job_version before update or delete on public.estimate_versions for each row execute function job_revision_private.protect_frozen();

-- Copy only revision-owned identities; room/contact/library references stay project-owned.
create function job_revision_private.clone_json(p jsonb, ids jsonb) returns jsonb language plpgsql set search_path='' as $$
declare result jsonb; k text; v jsonb;
begin
 if jsonb_typeof(p)='array' then select coalesce(jsonb_agg(job_revision_private.clone_json(value,ids)),'[]') into result from jsonb_array_elements(p); return result; end if;
 if jsonb_typeof(p)<>'object' then return p; end if;
 result='{}';
 for k,v in select * from jsonb_each(p) loop
  if k in ('actual_paid_ex_gst','invoice_id','invoice_line_id','payment_id','xero_id','xero_invoice_id','ordered_at','delivered_at','client_actioned_at') then v='null';
  elsif k in ('source_payments','cost_line_source_payments') then v='[]';
  elsif k='client_approved' then v='false';
  elsif k in ('id','section_id','group_id','measurement_id','item_id','sow_id','parent_item_id','option_id') and ids ? (v#>>'{}') then v=ids->(v#>>'{}');
  else v=job_revision_private.clone_json(v,ids); end if;
  result=result||jsonb_build_object(k,v);
 end loop;
 if ids ? (p->>'id') then result=result||jsonb_build_object('origin_id',p->>'id'); end if;
 return result;
end$$;
create function job_revision_private.owned_rows(p jsonb) returns setof jsonb language sql immutable set search_path='' as $$
 select value from jsonb_array_elements(p->'sections') union all
 select l.value from jsonb_array_elements(p->'sections') s cross join lateral jsonb_array_elements(s.value->'lines') l union all
 select value from jsonb_array_elements(p->'items') union all
 select value from jsonb_array_elements(p->'measurement_groups') union all
 select m.value from jsonb_array_elements(p->'measurement_groups') g cross join lateral jsonb_array_elements(g.value->'measurements') m union all
 select p#>'{scope,document}' union all
 select value from jsonb_array_elements(p#>'{scope,sections}') union all
 select l.value from jsonb_array_elements(p#>'{scope,sections}') s cross join lateral jsonb_array_elements(s.value->'lines') l union all
 select value from jsonb_array_elements(p->'item_rooms') union all select value from jsonb_array_elements(p->'item_components') union all
 select value from jsonb_array_elements(p->'allowances') union all select value from jsonb_array_elements(p->'options') union all select value from jsonb_array_elements(p->'payments')
$$;
create function job_revision_private.validate(p jsonb, project uuid, working boolean) returns void language plpgsql set search_path='' as $$
declare k text; r jsonb; v jsonb; n integer; distinct_n integer;
begin
 if p->>'schema' is distinct from '1' or p->>'project_id' is distinct from project::text or jsonb_typeof(p->'markup_pct') is distinct from 'number' or (p->>'markup_pct')::numeric not between 0 and 10 then raise exception 'Invalid revision payload'; end if;
 foreach k in array array['sections','items','measurement_groups','rooms','item_rooms','item_components','allowances','options','payments'] loop
  if jsonb_typeof(p->k) is distinct from 'array' then raise exception 'Missing revision array %',k; end if;
 end loop;
 if jsonb_typeof(p#>'{scope,document}') is distinct from 'object' or jsonb_typeof(p#>'{scope,sections}') is distinct from 'array' then raise exception 'Missing scope'; end if;
 select count(*),count(distinct value->>'id') into n,distinct_n from job_revision_private.owned_rows(p) value;
 if n<>distinct_n then raise exception 'Duplicate or missing identity'; end if;
 for r in select * from job_revision_private.owned_rows(p) loop
  perform (r->>'id')::uuid;
  if r ? 'project_id' and r->>'project_id' is distinct from project::text then raise exception 'Cross-project row'; end if;
  for k,v in select * from jsonb_each(r) loop
   if working and k in ('actual_paid_ex_gst','invoice_id','invoice_line_id','payment_id','xero_id','xero_invoice_id','ordered_at','delivered_at','client_actioned_at') and v<>'null'::jsonb then raise exception 'Accounting data cannot be edited in a revision'; end if;
   if working and k in ('source_payments','cost_line_source_payments') and v<>'[]'::jsonb then raise exception 'Actual payments are project-owned'; end if;
   if k in ('quantity','qty','wastage_pct','coverage_per_unit','markup_pct','percent','amount_inc_gst') and jsonb_typeof(v)='number' and (v#>>'{}')::numeric<0 then raise exception 'Negative financial quantity'; end if;
  end loop;
 end loop;
 for r in select * from job_revision_private.owned_rows(p) loop
  if r->>'measurement_id' is not null and not exists(select 1 from jsonb_array_elements(p->'measurement_groups') g cross join lateral jsonb_array_elements(g->'measurements') m where m->>'id'=r->>'measurement_id') then raise exception 'Invalid measurement link'; end if;
  if r->>'item_id' is not null and not exists(select 1 from jsonb_array_elements(p->'items') i where i->>'id'=r->>'item_id') then raise exception 'Invalid item link'; end if;
 end loop;
 for r in select value from jsonb_array_elements(p->'items') loop
  if jsonb_typeof(r->'quantity') is distinct from 'number' or r->>'cost_scope' not in ('direct','trade_package') then raise exception 'Invalid FF&E quantity or cost scope'; end if;
 end loop;
 for r in select value from jsonb_array_elements(p->'payments') loop
  if jsonb_typeof(r->'percent') is distinct from 'number' or (r->>'percent')::numeric not between 0 and 100 then raise exception 'Invalid payment percentage'; end if;
 end loop;
 for r in select value from jsonb_array_elements(p->'sections') loop
  if jsonb_typeof(r->'lines') is distinct from 'array' or exists(select 1 from jsonb_array_elements(r->'lines') l where l->>'section_id' is distinct from r->>'id') then raise exception 'Invalid section relationship'; end if;
 end loop;
 for r in select value from jsonb_array_elements(p->'measurement_groups') loop
  if jsonb_typeof(r->'measurements') is distinct from 'array' or exists(select 1 from jsonb_array_elements(r->'measurements') m where m->>'group_id' is distinct from r->>'id') then raise exception 'Invalid measurement relationship'; end if;
 end loop;
 for r in select value from jsonb_array_elements(p#>'{scope,sections}') loop
  if r->>'sow_id' is distinct from p#>>'{scope,document,id}' or jsonb_typeof(r->'lines') is distinct from 'array' or exists(select 1 from jsonb_array_elements(r->'lines') l where l->>'section_id' is distinct from r->>'id') then raise exception 'Invalid scope relationship'; end if;
 end loop;
end$$;

-- Controlled baseline import; caller supplies the reviewed full payload and exact sent PDF digest.
-- No UI auto-capture: release runbook requires live/export drift verification first.
create function job_revision_private.freeze(project uuid, label text, snapshot jsonb, frozen jsonb, expected_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; h text;
begin
 perform job_revision_private.authorize(); perform job_revision_private.validate(frozen->'payload',project,false);
 h=job_revision_private.hash(frozen);
 if h is distinct from expected_hash or coalesce(frozen#>>'{sent_pdf,sha256}','') !~ '^[a-f0-9]{64}$' or coalesce((frozen#>>'{sent_pdf,bytes}')::bigint,0)<=0 or coalesce(frozen#>>'{sent_pdf,reference}','')='' or coalesce(frozen->>'source_manifest_sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'Unverified frozen source'; end if;
 perform pg_advisory_xact_lock(hashtextextended(project::text||label,0));
 select to_jsonb(v) into result from public.estimate_versions v where v.project_id=project and v.label="freeze".label;
 if result is not null then
  if result->>'frozen_job_hash' is distinct from h then raise exception 'Version label already exists with another source'; end if; return result;
 end if;
 insert into public.estimate_versions(project_id,label,kind,snapshot,note,created_by,frozen_job_hash)
 values(project,label,'issue',snapshot||jsonb_build_object('full_job_revision',frozen),'Frozen job baseline; exact sent artifact retained separately',auth.uid(),h) returning to_jsonb(estimate_versions.*) into result;
 return result;
end$$;
create function job_revision_private.fork(project uuid, source uuid, source_hash text, label text, request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare baseline jsonb; payload jsonb; ids jsonb; result jsonb; prior job_revision_private.requests; h text;
begin
 perform job_revision_private.authorize();
 h=job_revision_private.hash(jsonb_build_array(project,source,source_hash,label));
 perform pg_advisory_xact_lock(hashtextextended(request::text,0));
 select * into prior from job_revision_private.requests where request_id=request;
 if found then if prior.actor_id<>auth.uid() or prior.operation<>'fork' or prior.input_hash<>h then raise exception 'Request identity conflict'; end if; return prior.result; end if;
 select snapshot->'full_job_revision' into baseline from public.estimate_versions where id=source and project_id=project and frozen_job_hash=fork.source_hash for share;
 if baseline is null or job_revision_private.hash(baseline)<>source_hash then raise exception 'Frozen source not found or changed'; end if;
 perform pg_advisory_xact_lock(hashtextextended(project::text||label,0));
 select to_jsonb(w) into result from public.job_revision_workspaces w where w.project_id=project and w.label=fork.label;
 if result is not null and (result->>'source_version_id'<>source::text or result->>'source_hash'<>source_hash) then raise exception 'Workspace label already belongs to another source'; end if;
 if result is null then
  payload=baseline->'payload';
  select jsonb_object_agg(value->>'id',gen_random_uuid()::text) into ids from job_revision_private.owned_rows(payload) value;
  payload=job_revision_private.clone_json(payload,ids);
  payload=jsonb_set(payload,'{scope,document}',(payload#>'{scope,document}')||jsonb_build_object('status','draft','issued_at',null,'revision_label',label));
  perform job_revision_private.validate(payload,project,true);
  insert into public.job_revision_workspaces(project_id,source_version_id,source_hash,label,payload,created_by) values(project,source,fork.source_hash,label,payload,auth.uid()) returning to_jsonb(job_revision_workspaces.*) into result;
 end if;
 insert into job_revision_private.requests values(request,auth.uid(),'fork',h,(result->>'id')::uuid,result,clock_timestamp());
 return result;
end$$;
create function job_revision_private.save(project uuid, workspace uuid, source_hash text, expected_version integer, payload jsonb, request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare current public.job_revision_workspaces; prior job_revision_private.requests; result jsonb; h text; r jsonb; old_row jsonb;
begin
 perform job_revision_private.authorize();
 h=job_revision_private.hash(jsonb_build_array(project,workspace,source_hash,expected_version,payload));
 perform pg_advisory_xact_lock(hashtextextended(request::text,0));
 select * into prior from job_revision_private.requests where request_id=request;
 if found then if prior.actor_id<>auth.uid() or prior.operation<>'save' or prior.input_hash<>h then raise exception 'Request identity conflict'; end if; return prior.result; end if;
 select * into current from public.job_revision_workspaces where id=workspace and project_id=project for update;
 if not found then raise exception 'Workspace not found'; end if;
 if current.source_hash<>save.source_hash or current.lock_version<>expected_version then raise exception 'Revision conflict: reload before saving' using errcode='40001'; end if;
 perform job_revision_private.validate(payload,project,true);
 if payload->'approved_variations' is distinct from current.payload->'approved_variations' then raise exception 'Approved variations remain project-owned'; end if;
 if payload->'rooms' is distinct from current.payload->'rooms' then raise exception 'Source room references cannot change'; end if;
 for r in select * from job_revision_private.owned_rows(payload) loop
  select value into old_row from job_revision_private.owned_rows(current.payload) value where value->>'id'=r->>'id';
  if found then
   if r->>'origin_id' is distinct from old_row->>'origin_id' then raise exception 'Source row identity cannot change'; end if;
  elsif r ? 'origin_id' then raise exception 'New rows cannot impersonate a source row'; end if;
 end loop;
 if payload#>>'{scope,document,id}' is distinct from current.payload#>>'{scope,document,id}' or payload#>>'{scope,document,status}' is distinct from 'draft' then raise exception 'Working scope identity/status cannot change'; end if;
 update public.job_revision_workspaces set payload=save.payload,lock_version=lock_version+1,updated_at=clock_timestamp() where id=workspace returning to_jsonb(job_revision_workspaces.*) into result;
 insert into job_revision_private.requests values(request,auth.uid(),'save',h,workspace,result,clock_timestamp());
 return result;
end$$;
-- PostgREST entry points are invokers; guarded implementations live in a non-exposed schema.
create function public.freeze_job_revision(project uuid,label text,snapshot jsonb,frozen jsonb,expected_hash text) returns jsonb language sql security invoker set search_path='' as $$select job_revision_private.freeze(project,label,snapshot,frozen,expected_hash)$$;
create function public.fork_job_revision(project uuid,source uuid,source_hash text,label text,request uuid) returns jsonb language sql security invoker set search_path='' as $$select job_revision_private.fork(project,source,source_hash,label,request)$$;
create function public.save_job_revision(project uuid,workspace uuid,source_hash text,expected_version integer,payload jsonb,request uuid) returns jsonb language sql security invoker set search_path='' as $$select job_revision_private.save(project,workspace,source_hash,expected_version,payload,request)$$;
revoke all on all functions in schema job_revision_private from public,anon,authenticated,service_role;
grant execute on function job_revision_private.freeze(uuid,text,jsonb,jsonb,text), job_revision_private.fork(uuid,uuid,text,text,uuid),job_revision_private.save(uuid,uuid,text,integer,jsonb,uuid) to authenticated;
revoke all on function public.freeze_job_revision(uuid,text,jsonb,jsonb,text),public.fork_job_revision(uuid,uuid,text,text,uuid),public.save_job_revision(uuid,uuid,text,integer,jsonb,uuid) from public,anon,service_role;
grant execute on function public.freeze_job_revision(uuid,text,jsonb,jsonb,text),public.fork_job_revision(uuid,uuid,text,text,uuid),public.save_job_revision(uuid,uuid,text,integer,jsonb,uuid) to authenticated;
