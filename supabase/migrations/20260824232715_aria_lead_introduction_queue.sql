-- Give newly detected client introductions their own durable, deduplicated
-- Aria work item. Second Brain triage creates this row; the local heartbeat
-- claims it and wakes Aria. This is internal review only and grants no send,
-- booking, publication, spending or client-commitment authority.

alter table aria_queue
  drop constraint if exists aria_queue_kind_check;
alter table aria_queue
  add constraint aria_queue_kind_check
    check (kind in (
      'price_request','trade_reminder','lead_flag','approval_needed',
      'email_proposal','draft_proposal','daily_review','weekly_review',
      'invoice_candidate','calendar_sync','followup_draft','followup_approved',
      'meeting_transcription','organic_review','diary_draft',
      'email_reply_requested','finance_routing_feedback','lead_introduction'
    ));

comment on column aria_queue.kind is
  'Operational work kind. lead_introduction is created once per inbound email when Second Brain triage identifies a genuine prospective client or project; it wakes Aria for verified internal follow-up preparation without authorising an external send.';

notify pgrst, 'reload schema';
