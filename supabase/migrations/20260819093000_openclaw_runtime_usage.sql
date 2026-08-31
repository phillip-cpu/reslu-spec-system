-- Store content-free OpenClaw provider/model/token/cost counters for completed
-- conversation turns and durable tasks. Prompts, replies, tool arguments,
-- results, reasoning and file content are deliberately excluded.

create or replace function public.is_valid_openclaw_usage(value jsonb)
returns boolean
language sql
immutable
strict
set search_path = pg_catalog, public
as $$
  select
    jsonb_typeof(value) = 'object'
    and (select count(*) = 9 from jsonb_object_keys(value))
    and not exists (
      select 1
      from jsonb_object_keys(value) as key
      where key <> all (array[
        'schema_version', 'provider', 'model', 'input_tokens', 'output_tokens',
        'cache_read_tokens', 'cache_write_tokens', 'total_tokens', 'cost_usd'
      ])
    )
    and value->>'schema_version' = '1'
    and value->>'provider' ~ '^[A-Za-z0-9._:/-]{1,80}$'
    and value->>'model' ~ '^[A-Za-z0-9._:/-]{1,160}$'
    and value->>'input_tokens' ~ '^[0-9]{1,10}$'
    and (value->>'input_tokens')::bigint between 0 and 1000000000
    and value->>'output_tokens' ~ '^[0-9]{1,10}$'
    and (value->>'output_tokens')::bigint between 0 and 1000000000
    and value->>'cache_read_tokens' ~ '^[0-9]{1,10}$'
    and (value->>'cache_read_tokens')::bigint between 0 and 1000000000
    and value->>'cache_write_tokens' ~ '^[0-9]{1,10}$'
    and (value->>'cache_write_tokens')::bigint between 0 and 1000000000
    and value->>'total_tokens' ~ '^[0-9]{1,10}$'
    and (value->>'total_tokens')::bigint between 0 and 1000000000
    and (
      value->>'cost_usd' is null
      or (
        value->>'cost_usd' ~ '^[0-9]+([.][0-9]{1,8})?$'
        and (value->>'cost_usd')::numeric between 0 and 1000000
      )
    );
$$;

revoke all on function public.is_valid_openclaw_usage(jsonb) from public, anon;
grant execute on function public.is_valid_openclaw_usage(jsonb) to authenticated, service_role;

alter table public.agent_conversation_jobs
  add column if not exists openclaw_usage jsonb;

alter table public.agent_tasks
  add column if not exists openclaw_usage jsonb;

alter table public.agent_conversation_jobs
  drop constraint if exists agent_conversation_jobs_openclaw_usage_valid,
  add constraint agent_conversation_jobs_openclaw_usage_valid
    check (openclaw_usage is null or public.is_valid_openclaw_usage(openclaw_usage));

alter table public.agent_tasks
  drop constraint if exists agent_tasks_openclaw_usage_valid,
  add constraint agent_tasks_openclaw_usage_valid
    check (openclaw_usage is null or public.is_valid_openclaw_usage(openclaw_usage));

comment on column public.agent_conversation_jobs.openclaw_usage is
  'Bounded content-free OpenClaw runtime usage: provider/model, token counters and reported cost only. Never stores prompts, replies, reasoning, files or tool data.';
comment on column public.agent_tasks.openclaw_usage is
  'Bounded content-free OpenClaw runtime usage: provider/model, token counters and reported cost only. Never stores prompts, replies, reasoning, files or tool data.';
