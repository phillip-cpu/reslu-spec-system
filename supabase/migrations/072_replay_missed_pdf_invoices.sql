-- Replay supplier-invoice emails received in the last three weeks that reached
-- extraction before readable PDF attachment text was passed into the cloud
-- extraction step. Existing invoice-candidate queue records are explicitly
-- excluded, so this cannot duplicate invoices that already made it through
-- review. The extraction route's attachment-hash dedupe remains a second guard
-- for an original email and a forwarded copy of the same invoice.

update emails as email_row
set
  status = 'triaged',
  extraction = null,
  processed_at = null
where email_row.status = 'extracted'
  and email_row.triage_label = 'supplier_invoice'
  and email_row.received_at >= now() - interval '21 days'
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
