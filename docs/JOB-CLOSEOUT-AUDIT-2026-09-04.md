# Job Closeout & Handover Audit

**Date:** 4 September 2026

**Audience:** RESLU operations and product team

**Scope:** How a job moves from active delivery through handover and
finalisation, including Work, FF&E, supplier invoices, client accounts,
signatures and the client handover pack.

## Executive decision

Do not add another project tab or another manually maintained checklist.
The system already has the right source records, but they were disconnected
at the point where a job closes. The recommended model is:

1. **Work** remains the source of truth for practical completion, defects
   and trade closeout tasks.
2. **FF&E** remains the source of truth for whether directly purchased
   items are installed.
3. **Supplier Invoices and Finance** remain the source of truth for costs,
   matching, client claims and payment state.
4. **Client** remains the source of truth for signatures and the curated
   handover pack.
5. **Job lifecycle** becomes the one closeout control:
   Construction → Handover → Finalised.

One read-only closeout cockpit now summarises those sources. It never copies
or owns their data. Finalisation requires a Handover review, but an admin can
explicitly finalise with disclosed financial or operational items still
open. That matters because legitimate payments, maintenance and warranty
work often continue after physical handover.

## What the live audit found

The production data was inspected read-only across the active job set.
No job had yet used the existing `completed` state, so the prior closeout
path was not proven in real use.

| Job | Stage | Closeout evidence |
| --- | --- | --- |
| Hone | Design | 11/11 Work items open; no Handover tasks; 70/70 direct FF&E items not Installed; 0/12 handover candidates selected; one supplier invoice needs matching |
| Goldsworthy Virgo | Construction | 46/96 Work items open; 15 Handover items open; 44/46 FF&E items not Installed; 0/27 handover candidates selected; seven supplier invoices need matching |
| Reslu Studio | Construction | 6/13 Work items open; 10/10 FF&E items not Installed; 0/2 handover candidates selected; four supplier invoices need matching; four approved supplier invoices unpaid; client billing and a signature also open |
| Radio Athens | Construction | 7/7 Work items open; one Handover item open; three approved supplier invoices unpaid |
| Conesa 11a | Design | 13/13 Work items open; seven Handover items open |
| Conessa 5 Central | Design | 10/10 Work items open; duplicate phase names; 9/9 FF&E items not Installed; 0/1 handover candidate selected |
| Gerardis | Design | 10/11 Work items open; 3/3 FF&E items not Installed; two supplier invoices need matching |

Additional usability findings:

- Construction previously advanced directly to Finalised, silently bypassing
  the existing Handover stage.
- The lifecycle graphic hid both Pre-construction and Handover, even though
  both existed in the stage selector and data model.
- Handover curation did not surface database read failures and allowed
  repeated checkbox interaction while a save was in flight.
- The existing Work template is stronger than many older jobs: it already
  includes practical completion, defects, compliance certificates, client
  walkthrough, handover documents, warranties/manuals, final account and
  archive tasks. Older jobs frequently have an empty Handover phase.
- Project types are mostly unset. Compliance rules therefore cannot safely
  be hard-coded as if every record is a new Class 1a house.

## External evidence

South Australian guidance treats practical completion as a usable building
that may still have minor omissions or defects, rather than a promise that
every post-build activity and payment has ended. The same guidance says
plumbing, gas and electrical trades must provide certificates of compliance.
For buildings where a Certificate of Occupancy applies, PlanSA says the
building cannot be occupied before the certificate is issued, and the
application relies on a signed Statement of Compliance and required
documentation.

- [CBS: Building, extending and renovating a home](https://www.cbs.sa.gov.au/documents/Building%2C-Extending-and-Renovating-a-home.pdf)
- [CBS: Important update for new house builders and owners](https://cbs.sa.gov.au/news/important-update-for-new-house-builders-and-owners)
- [PlanSA: Certificates of occupancy](https://plan.sa.gov.au/resources/building/certificates_of_occupancy)
- [SA Government: Certificates of compliance](https://www.sa.gov.au/topics/energy-and-environment/safe-energy-use/certificates-of-compliance)

Comparable construction products separate operational closeout from archival
state. Procore describes closeout as completing punch-list work and gathering
documents before changing a project from active to inactive. Autodesk tracks
issues through open/review/pending/closed states and centralises closeout
documents. Buildertrend has distinct Open, Warranty and Closed job states,
with assigned and documented warranty claims. Xero allows a closed project to
remain reportable and invoiceable, while preventing new time and expense
entries.

- [Procore: Close out a project](https://en-au.support.procore.com/products/online/user-guide/project-level/admin/tutorials/close-out-a-project)
- [Procore: Punch List](https://support.procore.com/products/online/user-guide/project-level/punch-list)
- [Autodesk Construction Cloud: Closeout](https://construction.autodesk.com/tools/closeout/)
- [Autodesk Build: Issue statuses](https://help.autodesk.com/view/BUILD/ENU/?guid=Issues_Statuses)
- [Buildertrend: Job management](https://buildertrend.com/help-article/job-management/)
- [Buildertrend: Warranty overview](https://buildertrend.com/help-article/warranty-overview/)
- [Xero: Delete or close a project](https://central.xero.com/0/article/Delete-a-project)

## Implemented control model

The closeout cockpit derives five areas:

| Area | Source and attention rule |
| --- | --- |
| Work & defects | Any active Work task is not in a Done/Complete column, or the job has no practical-completion/Handover task set |
| FF&E installation | Any direct FF&E item is not marked Installed; trade-package reference rows are excluded |
| Supplier costs | Supplier invoice is unmatched/proposed, or approved but not fully paid |
| Client account | Draft or sent/unpaid client invoice, proposed variation or pending signature |
| Client handover | Nothing is curated for handover; certificate, manual/warranty and final-photo counts remain visible without inventing one universal document rule |

The cockpit appears to admins during Construction, Handover and Finalised.
Handover opens it by default. Every area links back to its canonical screen.
The finalisation dialog describes exactly what Finalised changes and requires
an explicit acknowledgement when attention remains.

Finalised remains distinct from Archived and can be reopened by moving the
job back to an active stage. The implementation introduces no new database
table and no duplicated completion flags.

## Risks and follow-up

- The initial release should be exercised on a non-production fixture through
  clean, partially complete and heavily outstanding scenarios before any
  active job is changed.
- Older jobs with empty Handover phases need a deliberate “apply missing
  closeout template” workflow; it should not silently create tasks.
- Compliance blocking should later be conditional on project/building type
  and approval requirements once those fields are reliably populated.
- Post-handover warranty/maintenance work deserves a separate future review.
  It should not be disguised as an indefinitely open construction project.
- The client Handover pack is only exposed after Finalised. Portal regression
  testing must confirm the selected document/manual/photo mix without
  changing a live client’s project state.

## Acceptance standard

The release is acceptable when type checking, lint, focused unit/contract
tests and a production build pass; the focused closeout suite passes five
consecutive times; the UI is exercised at desktop and mobile widths; and live
read-only smoke tests confirm that at least three materially different jobs
produce counts consistent with their source screens.
