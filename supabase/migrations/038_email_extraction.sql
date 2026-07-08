-- ============================================================
-- RESLU Spec System — Second Brain, Step 9: emails.extraction column.
-- docs/RESLU-second-brain-build-brief.md, Step 9.
--
-- The brief's Step 9 JSON schema (job_mentions/item_mentions/
-- price_facts/lead_time_facts/actions_requested/confidence) has
-- nowhere to persist — emails (migration 037) only has
-- triage_label/triage_confidence (Step 8's own output). Step 10
-- (matching) and Step 11 (proposals) both need this output sitting
-- somewhere between Step 9 and their own runs.
-- ============================================================
alter table emails
  add column if not exists extraction jsonb;

comment on column emails.extraction is
  'RESLU Second Brain, Step 9 (docs/RESLU-second-brain-build-brief.md). Raw Sonnet extraction output for an actionable email: {job_mentions[], item_mentions[], price_facts[], lead_time_facts[], actions_requested[], confidence}. Every fact array item carries a mandatory source_quote — Step 11''s verification gate asserts it appears verbatim in clean_text or an email_attachments.extracted_text row before a proposal is ever created. Null until status reaches extracted.';

notify pgrst, 'reload schema';
