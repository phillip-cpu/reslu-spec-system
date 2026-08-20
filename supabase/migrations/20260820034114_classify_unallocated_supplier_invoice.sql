-- Classify an unallocated supplier invoice and write its finance audit event
-- in the same transaction. Only the service role may call this helper; the
-- Stuart API performs the user-facing authorization and confirmation checks.

create or replace function public.classify_unallocated_supplier_invoice(
  p_invoice_id uuid,
  p_scope text,
  p_project_id uuid default null,
  p_category text default null,
  p_recurring_commitment_id uuid default null,
  p_actor_id uuid default null
)
returns public.invoices
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  select * into v_invoice
  from public.invoices
  where id = p_invoice_id
  for update;

  if not found then raise exception 'Invoice not found'; end if;
  if v_invoice.expense_scope <> 'unallocated' then
    raise exception 'Only an unallocated invoice can be classified here';
  end if;
  if v_invoice.status not in ('unmatched', 'proposed') then
    raise exception 'An invoice that is already % cannot be reclassified', v_invoice.status;
  end if;

  if p_scope = 'project' then
    if p_project_id is null or p_category is not null or p_recurring_commitment_id is not null then
      raise exception 'Project classification requires only one project id';
    end if;
    if not exists (
      select 1 from public.projects
      where id = p_project_id and deleted_at is null and status <> 'archived'
    ) then
      raise exception 'The selected project is unavailable';
    end if;
  elsif p_scope = 'company' then
    if p_project_id is not null or p_category not in (
      'wages', 'superannuation', 'rent', 'marketing', 'entertainment',
      'software', 'insurance', 'utilities', 'professional_fees',
      'vehicles', 'other'
    ) then
      raise exception 'Company classification requires a supported category and no project';
    end if;
    if p_recurring_commitment_id is not null and not exists (
      select 1 from public.finance_recurring_commitments
      where id = p_recurring_commitment_id
        and status <> 'archived'
        and category = p_category
    ) then
      raise exception 'Recurring commitment is unavailable or has a different category';
    end if;
  else
    raise exception 'Classification scope must be project or company';
  end if;

  update public.invoices
  set expense_scope = p_scope,
      project_id = case when p_scope = 'project' then p_project_id else null end,
      company_expense_category = case when p_scope = 'company' then p_category else null end,
      recurring_commitment_id = case when p_scope = 'company' then p_recurring_commitment_id else null end,
      confidence_note = case when p_scope = 'project'
        then 'Human-confirmed project classification applied after unallocated invoice intake.'
        else 'Human-confirmed company expense classification applied after unallocated invoice intake.'
      end
  where id = p_invoice_id
  returning * into v_invoice;

  insert into public.finance_audit_events (
    project_id, actor_id, source, action, object_type, object_id, payload
  ) values (
    v_invoice.project_id,
    p_actor_id,
    'stuart_unallocated_invoice',
    'classify',
    'supplier_invoice',
    v_invoice.id,
    jsonb_build_object(
      'previous_scope', 'unallocated',
      'new_scope', v_invoice.expense_scope,
      'project_id', v_invoice.project_id,
      'company_expense_category', v_invoice.company_expense_category,
      'recurring_commitment_id', v_invoice.recurring_commitment_id,
      'supplier', v_invoice.supplier,
      'invoice_number', v_invoice.invoice_number,
      'human_confirmed', true
    )
  );

  return v_invoice;
end;
$$;

revoke all on function public.classify_unallocated_supplier_invoice(uuid, text, uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.classify_unallocated_supplier_invoice(uuid, text, uuid, text, uuid, uuid)
  to service_role;
