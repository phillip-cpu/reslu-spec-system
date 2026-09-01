-- Preserve exact category-approved net and GST-inclusive totals when a
-- saved FF&E estimate is expanded to item identities. The snapshot builder
-- apportions rounding remainders deterministically, so these integer values
-- must flow through without being recalculated per item.
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
    planned_tax_minor,
    planned_gross_minor,
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
    amounts.net_minor,
    amounts.gross_minor - amounts.net_minor,
    amounts.gross_minor,
    'unmapped',
    case
      when item->>'pricing_confidence' = 'placeholder' then 'low'
      when item->>'pricing_confidence' = 'quoted' then 'medium'
      else 'unknown'
    end
  from jsonb_array_elements(v_items) item
  cross join lateral (
    select
      coalesce(
        (item->>'cost_net_minor')::bigint,
        round(coalesce((item->>'total_ex_gst')::numeric, 0) * 100)::bigint
      ) as net_minor,
      coalesce(
        (item->>'cash_gross_minor')::bigint,
        round(coalesce((item->>'total_ex_gst')::numeric, 0) * 110)::bigint
      ) as gross_minor
  ) amounts
  where coalesce(item->>'cost_scope', 'direct') <> 'trade_package'
    and amounts.net_minor > 0
    and amounts.gross_minor >= amounts.net_minor
  on conflict (baseline_id, contribution_key) do nothing;

  return null;
end;
$$;

revoke all on function public.expand_finance_ffe_category_to_items()
  from public, anon, authenticated;

comment on function public.expand_finance_ffe_category_to_items() is
  'Transforms legacy category inserts into immutable, cent-exact item-level FF&E baseline lines when the saved estimate contains ffe_items.';

notify pgrst, 'reload schema';
