-- LOCAL REVIEW DRAFT ONLY. Run transactionally with migration history.
-- Adds quote-only restrictions; existing design/construction policies stay intact.
-- Requires the reviewed construction lifecycle and exact shared profile-role guard.
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


-- Abort instead of silently repairing historical quote lifecycle data.
do $$ begin
  if exists (select 1 from public.proposals where content->>'kind' = 'construction_quote'
    and (status <> 'draft' or deposit_inc <> 0 or project_id is null or lead_id is not null
      or sent_at is not null or signed_at is not null or signed_name is not null
      or signature is not null or signed_pdf_path is not null or viewed_at is not null
      or construction_version_digest is not null)) then
    raise exception 'Existing construction quotes require review before installing draft-only protection';
  end if;
end $$;

drop policy if exists construction_quote_admin_only on public.proposals;
create policy construction_quote_admin_only on public.proposals as restrictive
for all to authenticated
using (content->>'kind' is distinct from 'construction_quote' or exists (
  select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin'
))
with check (content->>'kind' is distinct from 'construction_quote' or exists (
  select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin'
));
drop policy if exists construction_quote_no_anonymous on public.proposals;
create policy construction_quote_no_anonymous on public.proposals as restrictive
for all to anon
using (content->>'kind' is distinct from 'construction_quote')
with check (content->>'kind' is distinct from 'construction_quote');

-- Invoker rights: no new privileged RPC or role grants. Trigger invocation does
-- not require exposing this private function as a callable Data API endpoint.
create or replace function construction_proposal_private.guard_quote()
returns trigger language plpgsql security invoker set search_path = pg_catalog as $$
begin
  if tg_op = 'DELETE' then
    if old.content->>'kind' = 'construction_quote' then
      raise exception 'Construction quote identity cannot be deleted' using errcode='42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.content->>'kind' = 'construction_quote' or new.content->>'kind' = 'construction_quote' then
      if old.content->>'kind' is distinct from new.content->>'kind' then
        raise exception 'Construction quote kind cannot change' using errcode='42501';
      end if;
      if row(new.id,new.project_id,new.lead_id,new.token,new.created_at)
        is distinct from row(old.id,old.project_id,old.lead_id,old.token,old.created_at) then
        raise exception 'Construction quote identity cannot change' using errcode='42501';
      end if;
    end if;
  end if;
  if new.content->>'kind' is distinct from 'construction_quote' then return new; end if;
  -- Also protects BYPASSRLS service connections: a real admin actor is required.
  if not exists(select 1 from public.profiles where id = auth.uid() and role = 'admin') then
    raise exception 'Admin actor required for construction quotes' using errcode='42501';
  end if;
  if new.status <> 'draft' or new.project_id is null or new.lead_id is not null
    or new.deposit_inc <> 0 or new.total_inc < 0
    or new.sent_at is not null or new.signed_at is not null or new.signed_name is not null
    or new.signature is not null or new.signed_pdf_path is not null or new.viewed_at is not null
    or new.construction_version_digest is not null then
    raise exception 'Construction quotes must remain unsigned drafts with zero deposit' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function construction_proposal_private.guard_quote() from public,anon,authenticated,service_role;
drop trigger if exists guard_construction_quote on public.proposals;
create trigger guard_construction_quote before insert or update or delete on public.proposals
for each row execute function construction_proposal_private.guard_quote();
