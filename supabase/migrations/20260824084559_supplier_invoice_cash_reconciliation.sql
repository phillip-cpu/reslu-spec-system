-- Supplier invoice approval records an accrued project cost. Cash payment is
-- a separate lifecycle event, otherwise approving a bill incorrectly makes it
-- look as though money has already left the bank.
alter table invoices
  add column if not exists due_date date,
  add column if not exists payment_status text not null default 'unpaid',
  add column if not exists amount_paid numeric(12,2) not null default 0,
  add column if not exists paid_at date;

alter table invoices
  drop constraint if exists invoices_payment_status_check,
  add constraint invoices_payment_status_check
    check (payment_status in ('unpaid', 'part_paid', 'paid')),
  drop constraint if exists invoices_amount_paid_check,
  add constraint invoices_amount_paid_check
    check (amount_paid >= 0 and amount_paid <= total),
  drop constraint if exists invoices_payment_state_check,
  add constraint invoices_payment_state_check check (
    (payment_status = 'unpaid' and amount_paid = 0 and paid_at is null)
    or
    (payment_status = 'part_paid' and amount_paid > 0 and amount_paid < total and paid_at is not null)
    or
    (payment_status = 'paid' and amount_paid = total and paid_at is not null)
  );

create index if not exists idx_invoices_project_payment_due
  on invoices(project_id, payment_status, due_date)
  where status = 'approved';

comment on column invoices.due_date is
  'Supplier bill due date used for accrued cashflow timing. Null falls back to invoice_date and remains explicitly lower confidence.';
comment on column invoices.payment_status is
  'Cash settlement state, independent of review status. Approval means accrued cost, not paid cash.';
comment on column invoices.amount_paid is
  'Gross cash paid including GST. Distributed across invoice allocations for cashflow reconciliation.';
comment on column invoices.paid_at is
  'Date of the latest recorded supplier payment. Required for part-paid and paid invoices.';
comment on column cost_lines.actual_paid_ex_gst is
  'Legacy name: approved/accrued supplier allocation total ex GST. It does not prove that supplier cash payment occurred; invoices.payment_status and amount_paid are authoritative for cash.';
