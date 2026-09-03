-- Create or enrich a supplier Address Book entry only after the application has
-- established a high-confidence, project-specific outgoing quote request.
-- The advisory transaction lock makes the case-insensitive lookup/insert atomic
-- across concurrent mailbox scans without imposing a new uniqueness constraint
-- on historical Address Book data.

create or replace function public.ensure_supplier_quote_contact(
  p_email text,
  p_company text,
  p_specialty text default null
)
returns public.contacts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_domain text;
  v_contact public.contacts%rowtype;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'A valid supplier email is required';
  end if;
  v_domain := split_part(v_email, '@', 2);
  if v_domain = 'reslu.com.au' or right(v_domain, length('.reslu.com.au')) = '.reslu.com.au' then
    raise exception 'Internal RESLU addresses cannot be added as supplier contacts';
  end if;
  if trim(coalesce(p_company, '')) = '' then
    raise exception 'A supplier company is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('supplier-contact:' || v_email, 0));

  select * into v_contact
  from public.contacts
  where deleted_at is null and lower(trim(email)) = v_email
  order by created_at, id
  limit 1
  for update;

  if found then
    update public.contacts
    set specialty = coalesce(nullif(trim(specialty), ''), nullif(trim(coalesce(p_specialty, '')), '')),
        category = coalesce(nullif(trim(category), ''), 'Supplier')
    where id = v_contact.id
    returning * into v_contact;
    return v_contact;
  end if;

  insert into public.contacts(company, email, specialty, category, notes)
  values (
    trim(p_company),
    v_email,
    nullif(trim(coalesce(p_specialty, '')), ''),
    'Supplier',
    'Automatically added from a matched outgoing supplier quote email.'
  )
  returning * into v_contact;

  return v_contact;
end;
$$;

revoke all on function public.ensure_supplier_quote_contact(text, text, text) from public, anon, authenticated;
grant execute on function public.ensure_supplier_quote_contact(text, text, text) to service_role;

comment on function public.ensure_supplier_quote_contact(text, text, text) is
  'Idempotently creates or enriches an external supplier contact after application-level quote/project validation.';

notify pgrst, 'reload schema';
