-- Route inbound messages that explicitly expect a response into Aria's
-- existing timeout-safe work queue. Triage remains multi-purpose: its
-- primary label drives extraction while reply_requested independently
-- creates this queue kind.

alter table aria_queue
  drop constraint if exists aria_queue_kind_check;
alter table aria_queue
  add constraint aria_queue_kind_check
    check (kind in (
      'price_request','trade_reminder','lead_flag','approval_needed',
      'email_proposal','draft_proposal','daily_review','weekly_review',
      'invoice_candidate','calendar_sync','followup_draft','followup_approved',
      'meeting_transcription','organic_review','diary_draft',
      'email_reply_requested'
    ));

comment on column aria_queue.kind is
  'Operational work kind. email_reply_requested is created by Second Brain triage when an inbound sender explicitly expects a response; replies remain human-approved drafts.';

notify pgrst, 'reload schema';
