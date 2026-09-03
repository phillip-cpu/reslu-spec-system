-- Cover the non-leading foreign keys used by cleanup/audit joins.  The
-- project and seed-email foreign keys are already covered by the first
-- matching migration.
create index if not exists idx_supplier_quote_email_matches_contact
  on public.supplier_quote_email_matches(contact_id)
  where contact_id is not null;
create index if not exists idx_supplier_quote_email_matches_package
  on public.supplier_quote_email_matches(package_id)
  where package_id is not null;
create index if not exists idx_supplier_quote_email_matches_reviewed_by
  on public.supplier_quote_email_matches(reviewed_by)
  where reviewed_by is not null;
create index if not exists idx_supplier_quote_email_match_lines_cost_line
  on public.supplier_quote_email_match_lines(cost_line_id);
