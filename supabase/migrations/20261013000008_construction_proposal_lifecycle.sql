-- REVIEW CANDIDATE ONLY. Tested on disposable PostgreSQL, never applied live.
-- Reuses proposals; adds immutable version/evidence enforcement. Both the app
-- and this database release gate default to OFF. No email/payment worker here.
-- Migration runner must wrap this file and its history record in one transaction.
create schema if not exists construction_proposal_private;
revoke all on schema construction_proposal_private from public, anon, authenticated;
grant usage on schema construction_proposal_private to service_role;

create table if not exists construction_proposal_private.release_gate (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false
);
insert into construction_proposal_private.release_gate values (true, false) on conflict do nothing;
create table if not exists construction_proposal_private.transition_claims (
  transaction_id bigint not null, proposal_id uuid not null,
  primary key(transaction_id, proposal_id)
);
create table if not exists construction_proposal_private.events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  project_id uuid not null references public.projects(id) on delete restrict,
  proposal_id uuid not null references public.proposals(id) on delete restrict,
  version_digest text not null,
  action text not null check(action in ('issued','superseded','accepted','declined')),
  actor_id uuid,
  evidence jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create unique index if not exists construction_one_response
  on construction_proposal_private.events(proposal_id) where action in ('accepted','declined');
create index if not exists construction_event_history on construction_proposal_private.events(project_id, proposal_id, created_at);
-- Transactional work record only. No dispatcher is enabled by this migration.
create table if not exists construction_proposal_private.outbox (
  event_id uuid primary key references construction_proposal_private.events(id) on delete restrict,
  kind text not null check(kind = 'construction_accepted'),
  state text not null default 'held' check(state = 'held'),
  created_at timestamptz not null default clock_timestamp()
);
alter table construction_proposal_private.release_gate enable row level security;
alter table construction_proposal_private.transition_claims enable row level security;
alter table construction_proposal_private.events enable row level security;
alter table construction_proposal_private.outbox enable row level security;
revoke all on all tables in schema construction_proposal_private from public, anon, authenticated, service_role;

alter table public.proposals add column if not exists construction_version_digest text;

-- Depends on the separately approved shared profile guard (SHA256
-- c4496e131fdcac3ab797283928e1051dfeddb004ae136cb00abcf8a32e0d755e).
-- This migration does not create or replace that security dependency.
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

-- Restrictive policy composes with the legacy permissive team_all policy;
-- design-proposal behavior is unchanged, construction rows require an admin.
drop policy if exists construction_proposal_admin_only on public.proposals;
create policy construction_proposal_admin_only on public.proposals as restrictive
for all to authenticated
using (coalesce(content->>'kind','design') <> 'construction' or exists (
  select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin'
))
with check (coalesce(content->>'kind','design') <> 'construction' or exists (
  select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin'
));

create or replace function construction_proposal_private.has_internal_fields(v jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog as $$
declare k text; child jsonb;
begin
  if jsonb_typeof(v) = 'object' then
    for k, child in select * from jsonb_each(v) loop
      if k ~* '(^|_)(cost|margin|markup|profit|actual|supplier|rate)(_|$)'
        or construction_proposal_private.has_internal_fields(child) then return true; end if;
    end loop;
  elsif jsonb_typeof(v) = 'array' then
    for child in select * from jsonb_array_elements(v) loop
      if construction_proposal_private.has_internal_fields(child) then return true; end if;
    end loop;
  end if;
  return false;
end $$;

create or replace function construction_proposal_private.version_digest(p public.proposals)
returns text language sql immutable set search_path = pg_catalog as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'id',p.id,'project_id',p.project_id,'content',p.content,
    'total_inc',p.total_inc,'deposit_inc',p.deposit_inc
  )::text, 'UTF8')), 'hex');
$$;

create or replace function construction_proposal_private.guard_proposal()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare parent public.proposals; c jsonb; percentages numeric; amounts numeric; package_project uuid;
begin
  if tg_op = 'DELETE' then
    if old.content->>'kind' = 'construction' then raise exception 'Construction versions cannot be deleted'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.content->>'kind' = 'construction' or new.content->>'kind' = 'construction' then
      if old.content->>'kind' is distinct from 'construction'
        or (to_jsonb(new) - array['updated_at','viewed_at','status','sent_at','signed_name','signed_at','signature','signed_pdf_path'])
           is distinct from (to_jsonb(old) - array['updated_at','viewed_at','status','sent_at','signed_name','signed_at','signature','signed_pdf_path']) then
        raise exception 'Construction document versions are immutable';
      end if;
      if row(new.status,new.sent_at,new.signed_name,new.signed_at,new.signature)
         is distinct from row(old.status,old.sent_at,old.signed_name,old.signed_at,old.signature)
        and not exists(select 1 from construction_proposal_private.transition_claims
          where transaction_id = txid_current() and proposal_id = old.id) then
        raise exception 'Use the atomic construction lifecycle operation' using errcode = '42501';
      end if;
      if new.viewed_at is distinct from old.viewed_at and (old.viewed_at is not null or old.status <> 'sent' or new.viewed_at is null) then
        raise exception 'View evidence is write-once';
      end if;
      if new.signed_pdf_path is distinct from old.signed_pdf_path and
        (old.signed_pdf_path is not null or old.status <> 'accepted' or new.signed_pdf_path is null
          or new.signed_pdf_path not like 'proposals/' || old.id::text || '/%') then
        raise exception 'Signed PDF evidence is write-once';
      end if;
    end if;
    return new;
  end if;
  if new.content->>'kind' is distinct from 'construction' then
    if new.construction_version_digest is not null then raise exception 'Digest is reserved for construction proposals'; end if;
    return new;
  end if;
  if current_setting('role',true) in ('authenticated','anon') and not exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ) then raise exception 'Admin access required' using errcode='42501'; end if;
  if new.project_id is null or new.lead_id is not null or new.status <> 'draft'
    or new.sent_at is not null or new.signed_at is not null or new.signed_name is not null
    or new.signature is not null or new.signed_pdf_path is not null or new.viewed_at is not null then
    raise exception 'Construction versions must start as unsigned project drafts';
  end if;
  c := new.content->'construction';
  if jsonb_typeof(c) is distinct from 'object' or c->>'schema' is distinct from '1' or construction_proposal_private.has_internal_fields(new.content)
    or new.content - array['kind','letter','vision','scope_sections','fees','timeline','exclusions','terms_md','construction'] <> '{}'::jsonb then
    raise exception 'Invalid client-safe construction document';
  end if;
  if jsonb_typeof(c->'total_inc') is distinct from 'number' or jsonb_typeof(c->'subtotal_ex_gst') is distinct from 'number' or jsonb_typeof(c->'gst') is distinct from 'number' then raise exception 'Numeric selling totals and GST required'; end if;
  if new.total_inc <= 0 or new.deposit_inc < 0 or new.deposit_inc > new.total_inc
    or (c->>'total_inc')::numeric is distinct from new.total_inc
    or (c->>'subtotal_ex_gst')::numeric + (c->>'gst')::numeric is distinct from new.total_inc
    or abs((c->>'gst')::numeric - round((c->>'subtotal_ex_gst')::numeric * .1, 2)) > .01 then
    raise exception 'Construction selling totals or GST do not reconcile';
  end if;
  if not exists(select 1 from public.estimate_versions where id=(c->>'estimate_version_id')::uuid and project_id=new.project_id)
    or not exists(select 1 from public.sow_documents where id=(c->>'sow_id')::uuid and project_id=new.project_id) then
    raise exception 'Construction sources must belong to this project';
  end if;
  if c ? 'variation' then
    select * into parent from public.proposals where id=(c#>>'{variation,accepted_proposal_id}')::uuid for share;
    if parent.id is null or parent.project_id <> new.project_id or parent.status <> 'accepted'
      or parent.content->>'kind' <> 'construction' or parent.content#>'{construction,variation}' is not null
      or parent.construction_version_digest is distinct from c#>>'{variation,accepted_version_digest}' then
      raise exception 'Variation must bind the accepted original version in this project';
    end if;
    select project_id into package_project from public.client_contract_variations
      where id=(c#>>'{variation,package_id}')::uuid and deleted_at is null and status='active'
        and amount_inc_gst=new.total_inc;
    if package_project is distinct from new.project_id or nullif(btrim(c#>>'{variation,description}'),'') is null
      or nullif(btrim(c#>>'{variation,time_effect_note}'),'') is null
      or coalesce(c#>>'{variation,time_effect_days}','') !~ '^-?[0-9]+$' then
      raise exception 'Variation package, selling price, description or time effect is invalid';
    end if;
  else
    if jsonb_typeof(c->'payments') is distinct from 'array' or jsonb_array_length(c->'payments')=0 then raise exception 'Payment stages required'; end if;
    if exists(select 1 from jsonb_array_elements(c->'payments') p where jsonb_typeof(p->'percentage') is distinct from 'number' or jsonb_typeof(p->'amount_inc') is distinct from 'number' or nullif(btrim(p->>'label'),'') is null
      or (p->>'percentage')::numeric not between 0 and 100 or (p->>'amount_inc')::numeric < 0) then raise exception 'Invalid payment stage'; end if;
    select sum((p->>'percentage')::numeric),sum((p->>'amount_inc')::numeric) into percentages,amounts from jsonb_array_elements(c->'payments') p;
    if percentages is distinct from 100::numeric or amounts is distinct from new.total_inc
      or (c#>>'{payments,0,amount_inc}')::numeric is distinct from new.deposit_inc then raise exception 'Payment stages must reconcile to 100%% and the selling total'; end if;
    if nullif(c->>'previous_proposal_id','') is not null then
      select * into parent from public.proposals where id=(c->>'previous_proposal_id')::uuid for share;
      if parent.id is null or parent.project_id <> new.project_id or parent.content->>'kind' <> 'construction'
        or parent.status in ('accepted','closed') or parent.content#>'{construction,variation}' is not null then
        raise exception 'Revision parent is unavailable; accepted originals require a separate variation';
      end if;
    end if;
  end if;
  new.construction_version_digest := construction_proposal_private.version_digest(new);
  return new;
end $$;
-- A rerun does not mutate existing rows; pre-existing construction data must be
-- explicitly reconciled before deployment, never silently rewritten/backfilled.
do $$ begin
  if exists(select 1 from public.proposals where content->>'kind'='construction' and construction_version_digest is null) then
    raise exception 'Existing construction drafts require reviewed reconciliation before this migration';
  end if;
end $$;
drop trigger if exists construction_proposal_guard on public.proposals;
create trigger construction_proposal_guard before insert or update or delete on public.proposals
for each row execute function construction_proposal_private.guard_proposal();

create unique index if not exists construction_one_active_original on public.proposals(project_id)
where content->>'kind'='construction' and content#>'{construction,variation}' is null and status in ('sent','accepted');
create unique index if not exists construction_one_active_variation_package on public.proposals((content#>>'{construction,variation,package_id}'))
where content->>'kind'='construction' and content#>'{construction,variation}' is not null and status in ('sent','accepted');

create or replace function construction_proposal_private.immutable_event()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'Construction approval history and held work records are append-only'; end $$;
drop trigger if exists construction_event_immutable on construction_proposal_private.events;
create trigger construction_event_immutable before update or delete on construction_proposal_private.events for each row execute function construction_proposal_private.immutable_event();
drop trigger if exists construction_outbox_immutable on construction_proposal_private.outbox;
create trigger construction_outbox_immutable before update or delete on construction_proposal_private.outbox for each row execute function construction_proposal_private.immutable_event();

create or replace function construction_proposal_private.issue(
  p_project uuid,p_proposal uuid,p_digest text,p_request uuid,p_actor uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p public.proposals; active public.proposals; e construction_proposal_private.events; evidence jsonb;
begin
  if not (select enabled from construction_proposal_private.release_gate where singleton) then raise exception 'Construction release is disabled' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles where id=p_actor and role='admin') then raise exception 'Admin actor required' using errcode='42501'; end if;
  perform 1 from public.projects where id=p_project for update;
  select * into p from public.proposals where id=p_proposal and project_id=p_project and content->>'kind'='construction' for update;
  if p.id is null or p.construction_version_digest is distinct from p_digest or p_request is null then raise exception 'Invalid construction version'; end if;
  evidence := jsonb_build_object('actor_id',p_actor);
  select * into e from construction_proposal_private.events where request_id=p_request;
  if e.id is not null then
    if e.proposal_id<>p.id or e.action<>'issued' or e.version_digest<>p_digest or e.evidence<>evidence then raise exception 'Conflicting lifecycle replay'; end if;
    return jsonb_build_object('event_id',e.id,'proposal_id',p.id,'version_digest',p_digest,'reused',true);
  end if;
  if p.status<>'draft' then raise exception 'Only a draft can be issued'; end if;
  if p.content#>'{construction,variation}' is null then
    select * into active from public.proposals where project_id=p_project and content->>'kind'='construction'
      and content#>'{construction,variation}' is null and status in ('sent','accepted') for update;
    if active.id is not null then
      if active.status='accepted' or active.id::text is distinct from p.content#>>'{construction,previous_proposal_id}' then raise exception 'An active original already exists; revise the exact sent version or create a variation'; end if;
      insert into construction_proposal_private.transition_claims values(txid_current(),active.id);
      update public.proposals set status='closed' where id=active.id;
      delete from construction_proposal_private.transition_claims where transaction_id=txid_current() and proposal_id=active.id;
      insert into construction_proposal_private.events(request_id,project_id,proposal_id,version_digest,action,actor_id,evidence)
        values(gen_random_uuid(),p_project,active.id,active.construction_version_digest,'superseded',p_actor,jsonb_build_object('replacement_id',p.id));
    end if;
  else
    if not exists(select 1 from public.proposals b where b.id=(p.content#>>'{construction,variation,accepted_proposal_id}')::uuid
      and b.project_id=p_project and b.status='accepted' and b.construction_version_digest=p.content#>>'{construction,variation,accepted_version_digest}') then raise exception 'Accepted original version is unavailable'; end if;
  end if;
  insert into construction_proposal_private.transition_claims values(txid_current(),p.id);
  update public.proposals set status='sent',sent_at=clock_timestamp() where id=p.id;
  delete from construction_proposal_private.transition_claims where transaction_id=txid_current() and proposal_id=p.id;
  insert into construction_proposal_private.events(request_id,project_id,proposal_id,version_digest,action,actor_id,evidence)
    values(p_request,p_project,p.id,p_digest,'issued',p_actor,evidence) returning * into e;
  return jsonb_build_object('event_id',e.id,'proposal_id',p.id,'version_digest',p_digest,'reused',false);
end $$;

create or replace function construction_proposal_private.respond(
  p_project uuid,p_proposal uuid,p_token text,p_digest text,p_request uuid,p_decision text,p_evidence jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p public.proposals; e construction_proposal_private.events;
begin
  if not (select enabled from construction_proposal_private.release_gate where singleton) then raise exception 'Construction release is disabled' using errcode='42501'; end if;
  if p_request is null or p_decision not in ('accepted','declined') or p_decision is null
    or jsonb_typeof(p_evidence) is distinct from 'object'
    or p_evidence - array['typed_name','consent','drawn_data_url','ip','user_agent','note'] <> '{}'::jsonb
    or length(coalesce(btrim(p_evidence->>'typed_name'),'')) not between 1 and 200
    or length(p_evidence::text)>1500000 then raise exception 'Invalid approval evidence'; end if;
  if p_decision='accepted' and (p_evidence->'consent' is distinct from 'true'::jsonb
    or coalesce(p_evidence->>'drawn_data_url','') !~ '^data:image/png;base64,iVBORw0KGgo') then raise exception 'Consent and PNG signature evidence required'; end if;
  if p_decision='declined' and nullif(btrim(p_evidence->>'note'),'') is null then raise exception 'Decline reason required'; end if;
  perform 1 from public.projects where id=p_project for update;
  select * into p from public.proposals where id=p_proposal and project_id=p_project and content->>'kind'='construction' for update;
  if p.id is null or p.token is distinct from p_token or p.construction_version_digest is distinct from p_digest then raise exception 'Invalid construction version or token'; end if;
  select * into e from construction_proposal_private.events where request_id=p_request;
  if e.id is not null then
    if e.proposal_id<>p.id or e.version_digest<>p_digest or e.action<>p_decision or e.evidence<>p_evidence then raise exception 'Conflicting lifecycle replay'; end if;
    return jsonb_build_object('event_id',e.id,'proposal_id',p.id,'version_digest',p_digest,'decision',e.action,'reused',true);
  end if;
  if p.status<>'sent' then raise exception 'This exact version is not available for approval'; end if;
  insert into construction_proposal_private.transition_claims values(txid_current(),p.id);
  if p_decision='accepted' then
    update public.proposals set status='accepted',signed_name=btrim(p_evidence->>'typed_name'),signed_at=clock_timestamp(),signature=p_evidence where id=p.id;
  else update public.proposals set status='closed' where id=p.id;
  end if;
  delete from construction_proposal_private.transition_claims where transaction_id=txid_current() and proposal_id=p.id;
  insert into construction_proposal_private.events(request_id,project_id,proposal_id,version_digest,action,evidence)
    values(p_request,p_project,p.id,p_digest,p_decision,p_evidence) returning * into e;
  if p_decision='accepted' then insert into construction_proposal_private.outbox(event_id,kind) values(e.id,'construction_accepted'); end if;
  return jsonb_build_object('event_id',e.id,'proposal_id',p.id,'version_digest',p_digest,'decision',e.action,'reused',false);
end $$;

-- No public SECURITY DEFINER functions. These invoker wrappers are service-only;
-- the private definers verify the administrator or token + project + exact digest.
create or replace function public.issue_construction_proposal(p_project uuid,p_proposal uuid,p_digest text,p_request uuid,p_actor uuid)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
 select construction_proposal_private.issue(p_project,p_proposal,p_digest,p_request,p_actor);
$$;
create or replace function public.respond_construction_proposal(p_project uuid,p_proposal uuid,p_token text,p_digest text,p_request uuid,p_decision text,p_evidence jsonb)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
 select construction_proposal_private.respond(p_project,p_proposal,p_token,p_digest,p_request,p_decision,p_evidence);
$$;
create or replace function construction_proposal_private.history(p_project uuid,p_proposal uuid)
returns jsonb language sql security definer set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'proposal_id',proposal_id,'version_digest',version_digest,'action',action,'at',created_at,'actor_id',actor_id,'name',evidence->>'typed_name','note',evidence->>'note') order by created_at,id),'[]'::jsonb)
 from construction_proposal_private.events where project_id=p_project and proposal_id=p_proposal;
$$;
create or replace function public.construction_proposal_history(p_project uuid,p_proposal uuid)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
 select construction_proposal_private.history(p_project,p_proposal);
$$;
revoke all on all functions in schema construction_proposal_private from public,anon,authenticated,service_role;
grant execute on function construction_proposal_private.issue(uuid,uuid,text,uuid,uuid),
 construction_proposal_private.respond(uuid,uuid,text,text,uuid,text,jsonb),
 construction_proposal_private.history(uuid,uuid) to service_role;
revoke all on function public.issue_construction_proposal(uuid,uuid,text,uuid,uuid),
 public.respond_construction_proposal(uuid,uuid,text,text,uuid,text,jsonb),
 public.construction_proposal_history(uuid,uuid) from public,anon,authenticated;
grant execute on function public.issue_construction_proposal(uuid,uuid,text,uuid,uuid),
 public.respond_construction_proposal(uuid,uuid,text,text,uuid,text,jsonb),
 public.construction_proposal_history(uuid,uuid) to service_role;
notify pgrst,'reload schema';
