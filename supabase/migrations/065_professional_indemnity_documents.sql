-- ============================================================
-- RESLU Spec System — Professional indemnity documents.
--
-- Engineers and other professional consultants can now have their
-- professional indemnity certificate stored directly or requested
-- through the same secure upload flow as other contact documents.
-- It is tracked independently and does not change the existing trade
-- public-liability/workers-comp compliance status.
-- ============================================================

alter table contact_documents
  drop constraint if exists contact_documents_kind_check;
alter table contact_documents
  add constraint contact_documents_kind_check
    check (
      kind in (
        'public_liability',
        'professional_indemnity',
        'workers_comp',
        'licence',
        'other'
      )
    );

alter table contact_document_requests
  drop constraint if exists contact_document_requests_kinds_allowed;
alter table contact_document_requests
  add constraint contact_document_requests_kinds_allowed
    check (
      requested_kinds <@ array[
        'public_liability',
        'professional_indemnity',
        'workers_comp',
        'licence'
      ]::text[]
    );

notify pgrst, 'reload schema';
