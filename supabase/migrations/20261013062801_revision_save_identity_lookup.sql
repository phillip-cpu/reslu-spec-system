-- Save performance only: same signature, security, grants, validation and locks.
-- No timeout increase, data migration, gate change or browser reload required.
do $$ begin
 if to_regprocedure('job_revision_private.save(uuid,uuid,text,integer,jsonb,uuid)') is null then
  raise exception 'Existing guarded revision save is required';
 end if;
end $$;

create or replace function job_revision_private.save(project uuid, workspace uuid, source_hash text, expected_version integer, payload jsonb, request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare current public.job_revision_workspaces; prior job_revision_private.requests; result jsonb; h text; r jsonb; source_origins jsonb;
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
 -- Build the source identity lookup once, rather than expanding the full saved
 -- payload for every incoming row. JSON null preserves absent/null origin equality.
 select coalesce(jsonb_object_agg(value->>'id',value->'origin_id'),'{}'::jsonb)
 into source_origins from job_revision_private.owned_rows(current.payload) value;
 for r in select * from job_revision_private.owned_rows(payload) loop
  if source_origins ? (r->>'id') then
   if r->>'origin_id' is distinct from source_origins->>(r->>'id') then raise exception 'Source row identity cannot change'; end if;
  elsif r ? 'origin_id' then raise exception 'New rows cannot impersonate a source row'; end if;
 end loop;
 if payload#>>'{scope,document,id}' is distinct from current.payload#>>'{scope,document,id}' or payload#>>'{scope,document,status}' is distinct from 'draft' then raise exception 'Working scope identity/status cannot change'; end if;
 update public.job_revision_workspaces set payload=save.payload,lock_version=lock_version+1,updated_at=clock_timestamp() where id=workspace returning to_jsonb(job_revision_workspaces.*) into result;
 insert into job_revision_private.requests values(request,auth.uid(),'save',h,workspace,result,clock_timestamp());
 return result;
end$$;
