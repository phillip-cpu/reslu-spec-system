-- Repair two production functions without changing their signatures, owners,
-- grants, SECURITY DEFINER status, or function-local search paths. Using the
-- stored definition keeps this corrective migration aligned with the exact
-- function version installed by the preceding migrations.
do $migration$
declare
  function_definition text;
  patched_definition text;
  old_conflict_target constant text :=
    'on conflict (baseline_id, contribution_key) do nothing';
  new_conflict_target constant text :=
    'on conflict on constraint finance_forecast_lines_baseline_id_contribution_key_key do nothing';
  conflict_target_count integer;
begin
  select pg_get_functiondef(
    'public.activate_project_finance(uuid,date,uuid,text,uuid,jsonb,text,text,integer)'::regprocedure
  ) into function_definition;

  conflict_target_count := (
    length(function_definition) - length(replace(function_definition, old_conflict_target, ''))
  ) / length(old_conflict_target);

  if conflict_target_count <> 3 then
    raise exception
      'Expected three ambiguous finance conflict targets, found %',
      conflict_target_count;
  end if;

  patched_definition := replace(
    function_definition,
    old_conflict_target,
    new_conflict_target
  );
  execute patched_definition;

  select pg_get_functiondef(
    'public.decide_agent_task_artifact(uuid,uuid,uuid,boolean,text)'::regprocedure
  ) into function_definition;

  if strpos(
    function_definition,
    'computed_payload_sha := encode(digest('
  ) = 0 then
    raise exception 'Expected unqualified task-artifact digest call was not found';
  end if;

  patched_definition := replace(
    function_definition,
    'computed_payload_sha := encode(digest(',
    'computed_payload_sha := encode(extensions.digest('
  );
  execute patched_definition;
end;
$migration$;

-- Preserve the intended callable surface explicitly. These are intentionally
-- not granted to anon or PUBLIC.
revoke all on function public.activate_project_finance(
  uuid, date, uuid, text, uuid, jsonb, text, text, integer
) from public, anon;
grant execute on function public.activate_project_finance(
  uuid, date, uuid, text, uuid, jsonb, text, text, integer
) to authenticated;

revoke all on function public.decide_agent_task_artifact(
  uuid, uuid, uuid, boolean, text
) from public, anon;
grant execute on function public.decide_agent_task_artifact(
  uuid, uuid, uuid, boolean, text
) to authenticated;
