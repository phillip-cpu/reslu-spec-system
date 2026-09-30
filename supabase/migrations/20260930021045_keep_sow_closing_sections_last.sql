-- Rooms added after template creation used to land after the closing clauses.
-- Persist their order here so the builder, full PDF and trade PDFs agree.
-- Only the two standard, unlinked closing sections move; authored content,
-- room order and issued/deleted revisions are preserved.

create or replace function public.keep_draft_sow_closing_sections_last()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Serialize inserts for a revision before inspecting its current sections.
  perform 1 from public.sow_documents
  where id = new.sow_id and status = 'draft' and deleted_at is null
  for update;
  if not found then
    return new;
  end if;

  with classified as (
    select id, sort,
      case when source_room_id is null then
        case lower(btrim(heading))
          when 'site management & handover' then 1
          when 'exclusions' then 2
          else 0
        end
      else 0 end as closing_rank
    from public.sow_sections
    where sow_id = new.sow_id
  ), closing_order as (
    select id,
      coalesce((select max(sort) from classified where closing_rank = 0), 0)
        + row_number() over (order by closing_rank, sort, id) as new_sort
    from classified
    where closing_rank > 0
  )
  update public.sow_sections as section
  set sort = closing_order.new_sort
  from closing_order
  where section.id = closing_order.id
    and section.sort is distinct from closing_order.new_sort;

  return new;
end;
$$;

revoke all on function public.keep_draft_sow_closing_sections_last() from public, anon, authenticated;

-- Do not trigger on sort-only updates: the room editor swaps two sort values
-- using separate requests. Renumbering between those requests breaks the swap.
drop trigger if exists trg_sow_sections_closing_order on public.sow_sections;
create trigger trg_sow_sections_closing_order
after insert or update of heading, source_room_id on public.sow_sections
for each row execute function public.keep_draft_sow_closing_sections_last();

-- Repair existing editable scopes, including rooms added after the template.
with classified as (
  select section.id, section.sow_id, section.sort,
    case when section.source_room_id is null then
      case lower(btrim(section.heading))
        when 'site management & handover' then 1
        when 'exclusions' then 2
        else 0
      end
    else 0 end as closing_rank
  from public.sow_sections as section
  join public.sow_documents as sow on sow.id = section.sow_id
  where sow.status = 'draft' and sow.deleted_at is null
), closing_order as (
  select closing.id,
    coalesce((select max(ordinary.sort) from classified as ordinary
      where ordinary.sow_id = closing.sow_id and ordinary.closing_rank = 0), 0)
      + row_number() over (partition by closing.sow_id order by closing.closing_rank, closing.sort, closing.id) as new_sort
  from classified as closing
  where closing.closing_rank > 0
)
update public.sow_sections as section
set sort = closing_order.new_sort
from closing_order
where section.id = closing_order.id
  and section.sort is distinct from closing_order.new_sort;
