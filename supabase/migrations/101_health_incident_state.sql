-- Keep machine incident lifecycle separate from whether a human/device has
-- displayed the corresponding notification. Reading a push must never reopen
-- a still-failing condition on the next health-check cron.

create table if not exists health_incidents (
  kind text primary key,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint health_incidents_kind_length
    check (char_length(kind) between 1 and 200),
  constraint health_incidents_resolution_order
    check (resolved_at is null or resolved_at >= opened_at)
);

alter table health_incidents enable row level security;
revoke all on table health_incidents from public, anon, authenticated;
grant all on table health_incidents to service_role;

comment on table health_incidents is
  'Service-only lifecycle state for health incidents. Independent from notifications.read_at so displaying a push cannot reopen an unresolved incident.';

create or replace function open_health_incident(
  p_kind text,
  p_title text,
  p_body text,
  p_link_href text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  notification_id uuid;
begin
  if p_kind is null or char_length(p_kind) not between 1 and 200 then
    raise exception 'Invalid incident kind';
  end if;
  if p_title is null or char_length(p_title) not between 1 and 300 then
    raise exception 'Invalid incident title';
  end if;
  if p_body is not null and char_length(p_body) > 2000 then
    raise exception 'Incident body is too long';
  end if;
  if p_link_href is not null and char_length(p_link_href) > 1000 then
    raise exception 'Incident link is too long';
  end if;

  insert into health_incidents (kind, opened_at, resolved_at)
  values (p_kind, now(), null)
  on conflict (kind) do update
    set opened_at = excluded.opened_at,
        resolved_at = null
    where health_incidents.resolved_at is not null;

  if not found then
    return null;
  end if;

  insert into notifications (user_id, kind, title, body, link_href)
  values (null, p_kind, p_title, p_body, p_link_href)
  returning id into notification_id;

  return notification_id;
end;
$$;

create or replace function resolve_health_incident(p_kind text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  did_resolve boolean;
begin
  update health_incidents
  set resolved_at = now()
  where kind = p_kind
    and resolved_at is null;
  did_resolve := found;

  update notifications
  set read_at = now()
  where kind = p_kind
    and user_id is null
    and read_at is null;

  return did_resolve;
end;
$$;

revoke all on function open_health_incident(text, text, text, text) from public, anon, authenticated;
revoke all on function resolve_health_incident(text) from public, anon, authenticated;
grant execute on function open_health_incident(text, text, text, text) to service_role;
grant execute on function resolve_health_incident(text) to service_role;

comment on function open_health_incident(text, text, text, text) is
  'Atomically opens or reopens one health incident and creates exactly one admin notification for that transition. Returns null while already open.';
comment on function resolve_health_incident(text) is
  'Closes one health incident independently of notification display/read state and suppresses any stale undelivered notification.';

comment on table notifications is
  'User-visible notification delivery records. read_at means displayed/read only; recurring machine incident lifecycle is tracked independently in health_incidents.';

notify pgrst, 'reload schema';
