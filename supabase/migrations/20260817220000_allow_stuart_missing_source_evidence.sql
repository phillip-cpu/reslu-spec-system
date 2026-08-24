-- Source-less supplier candidates are evidence exceptions, not verified bills.
-- Keep the database finding-kind contract aligned with Stuart's review engine.

alter table public.stuart_finance_findings
  drop constraint if exists stuart_finance_findings_kind_check;

alter table public.stuart_finance_findings
  add constraint stuart_finance_findings_kind_check check (kind in (
    'overdue_receivable',
    'overdue_payable',
    'due_soon_receivable',
    'due_soon_payable',
    'missing_from_xero',
    'missing_source_evidence',
    'xero_conflict',
    'unmatched_accounts_email',
    'cost_change',
    'forecast_risk'
  ));

notify pgrst, 'reload schema';
