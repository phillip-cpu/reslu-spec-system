-- Review candidate: no gate activation and no user/role/table-access expansion.
-- The import endpoint fails closed until this migration AND a reviewed record exist.
-- Existing team_all on estimate_versions is broad. Restrict only full-job rows;
-- ordinary legacy snapshots keep their existing access behavior.
create policy frozen_job_admin_only on public.estimate_versions as restrictive for all to authenticated
using ((frozen_job_hash is null and not coalesce(snapshot ? 'full_job_revision',false)) or exists(select 1 from public.profiles where id=auth.uid() and role='admin'))
with check ((frozen_job_hash is null and not coalesce(snapshot ? 'full_job_revision',false)) or exists(select 1 from public.profiles where id=auth.uid() and role='admin'));

create table job_revision_private.import_reviews(
 project_id uuid not null references public.projects(id) on delete restrict,
 label text not null,
 frozen_hash text not null check(frozen_hash ~ '^[a-f0-9]{64}$'),
 snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),
 source_digests jsonb not null,
 primary key(project_id,label)
);
alter table job_revision_private.import_reviews enable row level security;
revoke all on job_revision_private.import_reviews from public,anon,authenticated,service_role;

-- Exactly the source tables consumed by assembleFrozenJob. No accounting tables
-- are cloned or changed. A new source field changes its fingerprint automatically.
create function job_revision_private.source_digests(project uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_object_agg(name,digest) from (
 select 'projects' name,md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) digest from public.projects t where id=project
 union all select 'cost_sections',md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) from public.cost_sections t where project_id=project
 union all select 'cost_lines',md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) from public.cost_lines t where project_id=project
 union all select 'items',md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) from public.items t where project_id=project
 union all select 'sow_documents',md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) from public.sow_documents t where project_id=project
 union all select 'sow_sections',md5(coalesce(jsonb_agg(to_jsonb(t)-'trade_heading_overrides' order by t.id),'[]')::text) from public.sow_sections t where sow_id in(select id from public.sow_documents where project_id=project)
 union all select 'sow_trade_headings',md5(coalesce(jsonb_agg(jsonb_build_object('id',t.id,'headings',t.trade_heading_overrides) order by t.id) filter(where t.trade_heading_overrides<>'{}'::jsonb),'[]')::text) from public.sow_sections t where sow_id in(select id from public.sow_documents where project_id=project)
 union all select 'sow_lines',md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) from public.sow_lines t where section_id in(select s.id from public.sow_sections s join public.sow_documents d on d.id=s.sow_id where d.project_id=project)
 union all select 'rooms',md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) from public.rooms t where project_id=project
 union all select 'measurement_groups',md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) from public.measurement_groups t where project_id=project
 union all select 'measurements',md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) from public.measurements t where group_id in(select id from public.measurement_groups where project_id=project)
 union all select 'item_rooms',md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) from public.item_rooms t where item_id in(select id from public.items where project_id=project)
 union all select 'item_components',md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) from public.item_components t where item_id in(select id from public.items where project_id=project)
 union all select 'variations',md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text) from public.variations t where project_id=project
 ) fingerprints
$$;
revoke all on function job_revision_private.source_digests(uuid) from public,anon,authenticated,service_role;

-- Harden the existing freeze implementation. Its original role, immutable-row,
-- gate and same-label idempotency protections remain in force.
create or replace function job_revision_private.freeze(project uuid, label text, snapshot jsonb, frozen jsonb, expected_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; h text; review job_revision_private.import_reviews;
begin
 perform job_revision_private.authorize(); perform job_revision_private.validate(frozen->'payload',project,false);
 h=job_revision_private.hash(frozen);
 if h is distinct from expected_hash or coalesce(frozen#>>'{sent_pdf,sha256}','') !~ '^[a-f0-9]{64}$' or coalesce((frozen#>>'{sent_pdf,bytes}')::bigint,0)<=0 or coalesce(frozen#>>'{sent_pdf,reference}','')='' or coalesce(frozen->>'source_manifest_sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'Unverified frozen source'; end if;
 select * into review from job_revision_private.import_reviews r where r.project_id=project and r.label="freeze".label for share;
 if not found or review.frozen_hash<>h or review.snapshot_hash<>job_revision_private.hash(snapshot) then raise exception 'Reviewed import fingerprint does not match'; end if;
 perform pg_advisory_xact_lock(hashtextextended(project::text||label,0));
 select to_jsonb(v) into result from public.estimate_versions v where v.project_id=project and v.label="freeze".label;
 if result is not null then
  if result->>'frozen_job_hash' is distinct from h then raise exception 'Version label already exists with another source'; end if; return result;
 end if;
 -- Source writers do not use a shared per-project lock. Short table SHARE locks
 -- prevent inserts, updates and deletes (including phantoms) during this one-time
 -- read-and-freeze operation. NOWAIT fails safely if a source writer is active.
 lock table public.projects,public.cost_sections,public.cost_lines,public.items,
 public.sow_documents,public.sow_sections,public.sow_lines,public.rooms,
 public.measurement_groups,public.measurements,public.item_rooms,public.item_components,
 public.variations in share mode nowait;
 if review.source_digests is distinct from job_revision_private.source_digests(project) then raise exception 'Source changed since import review'; end if;
 insert into public.estimate_versions(project_id,label,kind,snapshot,note,created_by,frozen_job_hash)
 values(project,label,'issue',snapshot||jsonb_build_object('full_job_revision',frozen),'Frozen job baseline; exact sent artifact retained separately',auth.uid(),h) returning to_jsonb(estimate_versions.*) into result;
 return result;
end$$;

-- Versioned entry point makes the new API fail closed on an older DB migration.
-- Same existing authenticated admin operation, no wider data or role permissions.
create function public.freeze_reviewed_job_revision(project uuid,label text,snapshot jsonb,frozen jsonb,expected_hash text) returns jsonb language sql security invoker set search_path='' as $$select job_revision_private.freeze(project,label,snapshot,frozen,expected_hash)$$;
revoke all on function public.freeze_reviewed_job_revision(uuid,text,jsonb,jsonb,text) from public,anon,service_role;
grant execute on function public.freeze_reviewed_job_revision(uuid,text,jsonb,jsonb,text) to authenticated;
