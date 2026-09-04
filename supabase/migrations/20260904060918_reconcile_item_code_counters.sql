-- Keep each project/category item-code counter ahead of every code already in the
-- register, including codes supplied explicitly by CSV imports. The original
-- counter only advanced for trigger-generated codes, so an import containing
-- TB-01..TB-03 could leave next_seq at 2 and make the next quick-add collide
-- with active TB-02.

create or replace function public.generate_item_code(p_project_id uuid, p_category text)
returns text
language plpgsql
set search_path = ''
as $function$
declare
  v_seq integer;
  v_next_available integer;
begin
  -- Reconcile against the register on every allocation. The counter row is
  -- then incremented by one atomic UPSERT, so concurrent quick-adds still
  -- serialize on the same project/category row.
  select coalesce(max(substr(item.item_code, length(p_category) + 2)::integer), 0) + 1
  into v_next_available
  from public.items as item
  where item.project_id = p_project_id
    and item.category = p_category
    and left(item.item_code, length(p_category) + 1) = p_category || '-'
    and substr(item.item_code, length(p_category) + 2) ~ '^[0-9]+$';

  insert into public.item_code_counters as counter (project_id, category, next_seq)
  values (p_project_id, p_category, v_next_available + 1)
  on conflict (project_id, category)
  do update set next_seq = greatest(counter.next_seq, v_next_available) + 1
  returning next_seq - 1 into v_seq;

  return p_category || '-' || lpad(v_seq::text, 2, '0');
end;
$function$;

create or replace function public.assign_item_code()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_suffix text;
begin
  if new.item_code is null or new.item_code = '' then
    new.item_code := public.generate_item_code(new.project_id, new.category);
  else
    -- Explicit numeric codes are valid for imports. Advance the same counter
    -- in the trigger transaction so later UI-created items cannot reuse them.
    v_suffix := substr(new.item_code, length(new.category) + 2);
    if left(new.item_code, length(new.category) + 1) = new.category || '-'
       and v_suffix ~ '^[0-9]+$' then
      insert into public.item_code_counters as counter (project_id, category, next_seq)
      values (new.project_id, new.category, v_suffix::integer + 1)
      on conflict (project_id, category)
      do update set next_seq = greatest(counter.next_seq, excluded.next_seq);
    end if;
  end if;

  return new;
end;
$function$;

-- Repair existing drift before the new trigger handles future imports.
insert into public.item_code_counters as counter (project_id, category, next_seq)
select
  item.project_id,
  item.category,
  max(substr(item.item_code, length(item.category) + 2)::integer) + 1
from public.items as item
where left(item.item_code, length(item.category) + 1) = item.category || '-'
  and substr(item.item_code, length(item.category) + 2) ~ '^[0-9]+$'
group by item.project_id, item.category
on conflict (project_id, category)
do update set next_seq = greatest(counter.next_seq, excluded.next_seq);

comment on function public.generate_item_code(uuid, text) is
  'Atomically allocates the next project/category item code while reconciling explicit imported codes.';

comment on function public.assign_item_code() is
  'Assigns missing item codes and advances counters for explicit numeric item codes.';
