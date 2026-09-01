-- Saved estimate versions carry immutable FF&E item rows as well as the legacy
-- category rollup. When project Finance is activated, replace each attempted
-- category baseline row with those item identities. This keeps locked
-- baselines consistent with the shadow forecast and lets item-matched supplier
-- invoices replace the correct allowance without double-counting.
create or replace function public.expand_finance_ffe_category_to_items()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_items jsonb;
begin
  if new.source_type <> 'estimate_ffe_category' then
    return new;
  end if;

  select b.snapshot->'estimate'->'ffe_items'
  into v_items
  from public.forecast_baselines b
  where b.id = new.baseline_id;

  if v_items is null
     or jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) = 0 then
    return new;
  end if;

  insert into public.finance_forecast_lines (
    baseline_id,
    project_id,
    contribution_key,
    direction,
    source_type,
    source_record_id,
    source_version_id,
    description,
    dimension,
    planned_net_minor,
    timing_source,
    confidence
  )
  select
    new.baseline_id,
    new.project_id,
    'project:' || new.project_id::text || '|ffe_item:' || (item->>'id') || '|scope:base',
    'outflow',
    'estimate_ffe_item',
    (item->>'id')::uuid,
    new.source_version_id,
    coalesce(
      nullif(trim(item->>'name'), ''),
      nullif(trim(item->>'item_code'), ''),
      'FF&E - ' || coalesce(nullif(item->>'category', ''), 'Uncategorised')
    ),
    jsonb_build_object(
      'item_id', item->>'id',
      'item_code', item->>'item_code',
      'category', item->>'category',
      'quantity', coalesce((item->>'quantity')::numeric, 0),
      'pricing_confidence', coalesce(item->>'pricing_confidence', 'unknown')
    ),
    round(coalesce((item->>'total_ex_gst')::numeric, 0) * 100)::bigint,
    'unmapped',
    case
      when item->>'pricing_confidence' = 'placeholder' then 'low'
      when item->>'pricing_confidence' = 'quoted' then 'medium'
      else 'unknown'
    end
  from jsonb_array_elements(v_items) item
  where coalesce(item->>'cost_scope', 'direct') <> 'trade_package'
    and coalesce((item->>'total_ex_gst')::numeric, 0) > 0
  on conflict (baseline_id, contribution_key) do nothing;

  -- The item rows carry the complete FF&E amount; suppressing the legacy
  -- category row is the double-counting guard.
  return null;
end;
$$;

revoke all on function public.expand_finance_ffe_category_to_items()
  from public, anon, authenticated;

drop trigger if exists trg_finance_expand_ffe_category_to_items
  on public.finance_forecast_lines;
create trigger trg_finance_expand_ffe_category_to_items
before insert on public.finance_forecast_lines
for each row execute function public.expand_finance_ffe_category_to_items();

comment on function public.expand_finance_ffe_category_to_items() is
  'Transforms legacy category inserts into immutable item-level FF&E baseline lines when the saved estimate contains ffe_items.';

notify pgrst, 'reload schema';
