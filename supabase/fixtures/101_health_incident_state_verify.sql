begin;

do $$
begin
  if to_regclass('public.health_incidents') is null then
    raise exception 'FAIL: health_incidents table is missing';
  end if;
  if to_regprocedure('public.open_health_incident(text,text,text,text)') is null then
    raise exception 'FAIL: open_health_incident function is missing';
  end if;
  if to_regprocedure('public.resolve_health_incident(text)') is null then
    raise exception 'FAIL: resolve_health_incident function is missing';
  end if;
  if not exists (
    select 1 from pg_class
    where oid = 'public.health_incidents'::regclass
      and relrowsecurity
  ) then
    raise exception 'FAIL: health_incidents RLS is not enabled';
  end if;
  if has_table_privilege('authenticated', 'public.health_incidents', 'select')
     or has_table_privilege('anon', 'public.health_incidents', 'select') then
    raise exception 'FAIL: browser roles can read service-only incident state';
  end if;
  if has_function_privilege('authenticated', 'public.open_health_incident(text,text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.open_health_incident(text,text,text,text)', 'execute') then
    raise exception 'FAIL: browser roles can open incidents';
  end if;
end;
$$;

do $$
declare
  first_notification uuid;
  duplicate_notification uuid;
  reopened_notification uuid;
begin
  first_notification := open_health_incident(
    'reslu_verify:health_incident',
    'Verifier incident',
    'First transition',
    '/health'
  );
  if first_notification is null then
    raise exception 'FAIL: first open did not create a notification';
  end if;

  update notifications set read_at = now() where id = first_notification;

  duplicate_notification := open_health_incident(
    'reslu_verify:health_incident',
    'Verifier incident',
    'Still failing after display',
    '/health'
  );
  if duplicate_notification is not null then
    raise exception 'FAIL: reading a notification reopened the incident';
  end if;

  if not resolve_health_incident('reslu_verify:health_incident') then
    raise exception 'FAIL: open incident did not resolve';
  end if;

  reopened_notification := open_health_incident(
    'reslu_verify:health_incident',
    'Verifier incident',
    'New transition after recovery',
    '/health'
  );
  if reopened_notification is null or reopened_notification = first_notification then
    raise exception 'FAIL: resolved incident did not reopen exactly once';
  end if;
end;
$$;

select 'PASS — incident display is independent from incident resolution' as result;

rollback;
