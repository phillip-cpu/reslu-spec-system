-- Replay only Bunnings supplier-invoice emails that reached extraction before
-- readable PDF attachment text was passed into the cloud extraction step.
-- Existing invoice-candidate queue records are explicitly excluded, so this
-- cannot duplicate invoices that already made it through review.

update emails as email_row
set
  status = 'triaged',
  extraction = null,
  processed_at = null
where email_row.status = 'extracted'
  and email_row.triage_label = 'supplier_invoice'
  and (
    lower(email_row.from_addr) like '%bunnings.com.au%'
    or lower(coalesce(email_row.subject, '')) like '%bunnings%'
  )
  and exists (
    select 1
    from email_attachments as attachment
    where attachment.email_id = email_row.id
      and (
        attachment.mime = 'application/pdf'
        or lower(coalesce(attachment.filename, '')) like '%.pdf'
      )
      and nullif(btrim(attachment.extracted_text), '') is not null
  )
  and not exists (
    select 1
    from aria_queue as queue_row
    where queue_row.kind = 'invoice_candidate'
      and queue_row.payload ->> 'source_email_id' = email_row.id::text
  );

notify pgrst, 'reload schema';
