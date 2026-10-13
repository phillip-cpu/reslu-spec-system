-- Separate review item: display-only labels scoped to one SOW section and trade.
-- No data backfill, no trade identity changes, no global sanding replacement.
-- Migration runner must wrap this file and its history record in one transaction.
alter table public.sow_sections add column if not exists trade_heading_overrides jsonb not null default '{}'::jsonb;
create or replace function public.guard_sow_trade_heading_overrides()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare parent_status text; k text; v jsonb;
begin
  if tg_op='UPDATE' and new.trade_heading_overrides is not distinct from old.trade_heading_overrides then return new; end if;
  if tg_op='INSERT' and new.trade_heading_overrides='{}'::jsonb then return new; end if;
  select status into parent_status from public.sow_documents where id=new.sow_id for share;
  if parent_status is distinct from 'draft' then raise exception 'Issued scope headings are immutable; create a new revision'; end if;
  if jsonb_typeof(new.trade_heading_overrides) is distinct from 'object' then raise exception 'Heading overrides must be an object'; end if;
  for k,v in select * from jsonb_each(new.trade_heading_overrides) loop
    if length(btrim(k)) not between 1 and 160 or k in ('__proto__','constructor','prototype')
      or jsonb_typeof(v)<>'string' or length(btrim(v#>>'{}')) not between 1 and 160
      or (v#>>'{}') ~ E'[\r\n]' then raise exception 'Invalid trade display heading'; end if;
  end loop;
  return new;
end $$;
drop trigger if exists sow_trade_heading_override_guard on public.sow_sections;
create trigger sow_trade_heading_override_guard before insert or update of trade_heading_overrides on public.sow_sections
for each row execute function public.guard_sow_trade_heading_overrides();
revoke all on function public.guard_sow_trade_heading_overrides() from public,anon,authenticated;
comment on column public.sow_sections.trade_heading_overrides is 'Per-section display label keyed by unchanged sow_lines.trade identity. Used only by UI/PDF. Empty object preserves existing labels.';
