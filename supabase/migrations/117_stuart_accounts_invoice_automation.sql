-- Stuart-owned Accounts inbox invoices. The existing human approval workflow
-- remains unchanged; 'stuart' only identifies who staged the draft.
alter table invoices drop constraint if exists invoices_source_check;
alter table invoices add constraint invoices_source_check
  check (source in ('manual', 'aria', 'stuart'));

comment on column invoices.source is
  'manual = human upload; aria = legacy Aria proposal; stuart = securely staged from the Accounts mailbox. All remain approval-gated in Spec; Stuart may additionally create Xero DRAFT bills only.';

-- Stop legacy Aria wakes for Accounts invoices that were queued before the
-- route changed ownership. The emails and attachments remain untouched.
update aria_queue as queue
set status = 'done',
    resolved_at = coalesce(queue.resolved_at, now()),
    error = 'Routing corrected: Accounts supplier invoices are owned by Stuart.'
where queue.kind = 'invoice_candidate'
  and queue.status in ('pending', 'picked_up')
  and exists (
    select 1 from emails
    where emails.id::text = queue.payload->>'source_email_id'
      and emails.ingested_mailboxes @> array['accounts@reslu.com.au']::text[]
  );

notify pgrst, 'reload schema';
