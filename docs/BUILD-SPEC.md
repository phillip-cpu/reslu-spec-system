# RESLU Spec System — BUILD-SPEC (decisions record)

NOTE 2026-07-10: the original BUILD-SPEC.md was lost from the tree (never git-committed).
This file reconstructs the standing rulings from the build history, then continues live.
Claude Code: please commit this file so it can't vanish again.

## Standing rulings (reconstructed)
- Roles: Fable specs + builds via agents; Claude Code owns ALL git commits, migrations, deploys ("write code and pause"). Aria (OpenClaw, Mac mini) operates via MCP; drafts only — humans approve/publish/complete.
- Brand: cream #EDE8DE, off-white #F5F1E8, charcoal #313131, near-black #1A1A1A, sand #A08C72; sharp corners; Cormorant Garamond display / Helvetica body; ALWAYS the actual logo file (public/reslu-logo.png), never typeset.
- Financial gating: pricing admin-only (Phillip), stripped server-side; portal/trade/PDF never show item pricing (variations inc-GST sole exception). Aria may set quoted trade prices only, never RRP/actuals.
- Migrations: one numbered migration per round, no renumbering/reuse; Second Brain owns 033–040, 042, 045.
- Protected files (agents never touch): lib/supabase/middleware.ts, vercel.json, app/api/digest/**, SpecRegister.tsx, RoomAssignBar.tsx, RoomBuilder.tsx, ItemRoomsEditor.tsx, lib/csv.ts, app/api/projects/[id]/import/**, types/index.ts, Second Brain files.
- Emails: Resend (own key) for client-facing; Gmail lib for team; every send logged in email_sends; sends only 7am–7pm Australia/Adelaide; Adelaide timezone for all date maths.
- Second Brain: embeddings via Supabase gte-small (384) — NO OpenAI, data stays inside Supabase/Vercel/the mini; human-approval gate mandatory on change_proposals (no path from email content to DB write without approval); personal email excluded; calendar via dedicated "RESLU" Google calendar.
- Unified phases: schedule_phases ↔ board_groups (phase_id); phase dates roll up from task booking dates; two-way timeline↔board sync via shift-items/adjust-boundary.
- Board v3.3: cells render as text/pills, controls only on click; works dates PATCH-editable as placeholders until trade booked; booking start-date pick snaps end date to same day.
- Order-by engine: export presets = trade mappings (prefixes + contact_categories); order-by = works date − lead_time_weeks; items without lead time flag.
- Trade bookings (r15/16): trade_visits with confirm tokens, arrival slots, frozen document_pack (plans/schedule/SOW extract), immediate booking email + day-before reminder; "show the trade" preview.
- Client invoicing (046): numbering {job_number}-{seq}; GST per-component rounding; bank details from app_settings only; Stripe payment_links via plain fetch when STRIPE_SECRET_KEY set.
- CPD (047): 12-point default, July year start, evidence uploads, pro-rata nudge, add_cpd_entry MCP tool.
- Lead flow (048): sender 'Aria — RESLU <aria@reslu.com.au>'; reminder ~48h (today+2 Adelaide); GCal link + invite.ics (METHOD:PUBLISH, stable UID lead-visit-{id}, SEQUENCE bump on reschedule); /brief/[token] page + brief_answers; Monday is retired; assets hotlink from reslu.com.au.
- SOW: trade free-text with suggestions; wet-area screed lines present as per-job editable placeholders (order vs waterproofing left per-job); SowPdf pagination fixed (no whole-section wrap=false).

## Grouped trade booking (r20)

Problem: booking one trade for several spaced-apart tasks (tiler: screed, waterproofing, tiling) fires one email per visit — spam. New flow: propose dates on the board, send ONE email covering all tasks, trade responds per line.

Mechanics (approved via mockup 2026-07-10):
1. Migration 049: trade_booking_requests (id, project_id, contact_id, token unique, status draft|sent|responded|closed, sent_at, responded_at, created_at) + trade_visits.booking_request_id FK null + trade_visits response fields (suggested_start date, suggested_end date, response_note text, line_status proposed|accepted|date_suggested null).
2. Book-trade panel gains "group" mode: picking a trade contact gathers ALL that trade's tasks on the project with proposed booking dates; undated tasks listed greyed + excluded (and flag as usual). One document pack (plans frozen, schedule, SOW trade extract — reuse r15/r16 pack machinery). Send = one email listing every task + date range + single tokened link.
3. Trade response page /trade-request/[token] (mirror /trade/[token] patterns: token gate, rate limit, noindex, no login, mobile-first, RESLU brand cream/off-white/charcoal, real logo). Per line: Accept, or Suggest date (date range picker + optional note). Partial responses allowed: accepted lines lock immediately (visit → confirmed, existing confirmation email/reminder machinery per visit — day-before reminders unchanged, per visit not per blob). Confirm button submits remaining.
4. Suggestions NEVER move the board automatically. Each suggestion → attention/daily-brief item + lead… er, project board badge. Admin actions on the visit/panel: "Accept new date + shift timeline" (apply suggested dates, then offer the existing shift-items downstream ripple) or "Keep original + reply" (frees line back to proposed, sends short reply email).
5. Lines are independent — accepting one does not re-date others (Phillip confirmed default). The downstream shift is offered only on the admin accept action via existing shift-items route.
6. No response after 3 days → follow-up flag on the request (surfaces in My Work follow-ups), re-send option (same token, SEQUENCE-style resend guard in email_sends).
7. Single-visit booking flow (r15) stays for one-off bookings; grouped mode is additive.

## Booking status visibility (r20.1)

Follow-up to grouped trade booking. Two faults Phillip flagged:
1. Sending a booking request (grouped or single) must update the visible status of the affected task(s) on the board — the status cell should read the booking state, not stay stale.
2. Timeline bars must colour by booking status so the schedule reads at a glance.

Canonical booking-state ladder (derive from trade_visits/line_status — single source of truth, no new duplicated column unless unavoidable):
- none/placeholder — dates set, nothing sent → neutral (existing bar colour)
- requested — request sent, awaiting trade → sand/amber tone
- date_suggested — trade countered → warning/orange tone + badge (already has attention item)
- booked/confirmed — trade accepted / visit confirmed → green tone
- done — task completed → existing done colour wins

Rules: board status pills and timeline bars use the SAME colour mapping (one shared helper/constant, e.g. lib/booking-status.ts); works for both r15 single-visit and r20 grouped flows; legend on the timeline; don't break existing phase colours — booking state colours the task bar/pill, phase grouping stays as-is; keep-original+reply admin action returns bar to requested (not neutral) since request is still open.

## Site capture + mobile QoL (r21)

From Phillip's field-use notes 2026-07-10.

1. **Site capture** — save-to-homescreen URL for capturing on site. Two entry points:
   a. /capture (authenticated, Phillip/team): job picker at top (active projects), then ONLY two actions — take/upload photos (camera capture) and add a note. Mobile-first, huge touch targets, PWA manifest + apple-touch-icon so Add-to-Home-Screen gives an app-like icon.
   b. Trade side: capture section added to the existing /trade/[token] visit page (no new token infra) — trade can drop photos/notes onto the job they're booked on; author recorded as the contact.
2. **Notes**: plain textarea (iOS keyboard dictation covers live voice→text, zero infra) PLUS hold-to-record audio (MediaRecorder → Supabase storage). Audio rows queue for transcription by Aria's Mac mini (local Whisper — per the no-external-AI ruling); transcript lands back on the row via MCP.
3. Migration 050: site_captures (id, project_id FK, kind photo|note|audio check, storage_path text null, text_content text null, transcript text null, transcript_status pending|done|failed null (audio only), author_user_id null, author_contact_id null (exactly one set), trade_visit_id null, created_at). Storage bucket site-captures (private).
4. **Surfacing**: project page gains "Site diary" — reverse-chronological captures, date-stamped (Adelaide), photo thumbnails, notes, audio player + transcript. Everything automatically date-stamped; no manual filing.
5. **MCP (Aria)**: list_pending_transcriptions, set_capture_transcript(capture_id, transcript), list_site_captures(project). ALSO fix: Aria cannot read lead notes — expose lead notes through get_lead/list_leads or a get_lead_notes tool (read-only, whatever matches existing MCP conventions).
6. **My Work checkboxes**: office/task items on My Work get an inline checkbox to mark complete (writes the same completion the source screen would).
7. **Mobile sidebar**: on small screens the left nav auto-collapses after a nav tap (and starts collapsed), hamburger reopens; desktop unchanged.

## Email signatures page (r22)

Package: emails/signatures/ (reference-signature-phillip.html = markup source of truth between SIGNATURE STARTS/ENDS; reference-installer-phillip.sh = working Apple Mail installer; people.json = team, TBC values).

1. Settings → Email signatures section, visible to all users, no secrets. One card per person: live rendered preview, "Copy signature" (rich-text clipboard, same copySig() technique as reference page), "Download Mac installer" (install-signature-<id>.sh, generated server-side from the reference script with the same substitutions).
2. Per-person generation substitutes ONLY: name (Caveat pen line), title (letterspaced label), phone (display + tel: href). Email not shown. Prefer Spec team records (profiles) for title/phone if such fields exist; else people.json with TBC shown as-is.
3. Design LOCKED — reproduce exactly: logo https://www.reslu.com.au/reslu-logo-sig.png at 100×41 (never full-size logo), pen name Caveat 600 30px #274690, title 10px ls-3px #313131 + 1px #1A1A1A rule, details 12px Helvetica Neue Light #313131, strapline 9px ls-3px #A08C72 "ONE PROJECT · ONE TEAM · ONE STANDARD", no box, ONE table cell (no nested tables), middots, phone "+61 439 870 594" format, no em dashes.
4. Collapsible install instructions per CLAUDE.md (Gmail paste / Mac: quit Mail, bash script, Full Disk Access note, edits most-recent .mailsignature or takes path arg / iPhone: email-to-self + shake-to-undo trick).
5. No migration expected (use existing profiles/settings if fields exist; do NOT add columns without checking — if title/phone missing from profiles, ship people.json-driven and note it).

## Fee proposal phase (r23)

Decisions (mockup approved 2026-07-10; references: docs/proposal-reference-content.md):
- ONE signable document: proposal + terms merged (replaces LawDepot service contract). Client signs on the tokened page → signed PDF stored + emailed → deposit invoice auto-DRAFTED (never auto-sent) via 046 machinery → attention item. Lead flip to project stays a manual button.
- Aria pre-drafts intro letter + vision alignment from lead brief_answers + site captures/notes (draft only, Phillip edits; proposal can never send without Phillip pressing send).
- No moodboard page in v1.

Build:
1. Migration 051: proposals (id, lead_id FK null, project_id FK null — at least one, token unique, status draft|sent|accepted|closed, content jsonb, total_inc numeric, deposit_inc numeric, viewed_at, sent_at, signed_name, signed_at, signature jsonb, signed_pdf_path, created_at, updated_at). content jsonb: {letter, vision, scope_sections[{title, intro?, bullets[], deliverables[]}], fees{mode staged|single, stages[{label, total_inc, milestones[{label, amount_inc}]}] , payment_lines[]}, timeline[{phase, duration}], exclusions{bullets[], allowance}, terms_md}.
2. Templates: three seeds (renovation/new build/multi-phase) built from docs/proposal-reference-content.md, stored like sow-templates (lib file or seed table — match existing convention). Default terms_md from the same doc.
3. Builder UI on lead detail (+ projects): create from template → section editor (letter, vision, scope sections add/remove/reorder, fee stages with milestone rows + auto-sum + GST-inc display, timeline rows, exclusions, allowance, terms editable) → live client-page preview → Send (Aria sender via Resend, email_sends log, Adelaide window; email = branded button link like booking request).
4. Client page /proposal/[token]: brief-page patterns (rate limit, noindex, mobile-first, brand, real logo). Full document incl. terms (collapsible), then sign-to-accept: reuse existing e-signature machinery (draw/type), stamped date/IP. Accept → status accepted, signed ProposalPdf (@react-pdf, Neave layout: cover/letter/vision/scope/fees/timeline/exclusions/terms/signature page) stored in bucket + emailed to client and Phillip, deposit invoice drafted from deposit_inc, daily_brief_items row. viewed_at set on first GET.
5. Aria: aria_queue item 'draft_proposal' created when proposal created from a lead with brief answers; MCP tools get_proposal, set_proposal_draft (letter/vision only, only while status draft). Documented in docs/ARIA.md.
6. Follow-up: sent >5 days not accepted → My Work follow-ups + re-send option (dupe-guarded).
7. Middleware: /proposal + /api/proposal-* public — if existing prefixes don't cover, document exact allowlist line for CC (do not touch middleware).

## Booking selection v2 + Aria supplier invoices (r24)

From Phillip's field testing 2026-07-11 (screenshot: Painting phase card, works dates all "—", per-item Book trade only).

A. Booking selection v2 (rework of r20 entry points — r20 backend machinery stays):
1. Lines (board rows + phase-card item rows) get selection checkboxes. Select any lines → action bar "Book selected → one trade" appears. All selected lines go into ONE grouped booking request (r20 trade_booking_requests) to ONE trade contact chosen in the panel.
2. The grouped panel gains INLINE proposed-date editing: undated selected tasks are NOT excluded — they show editable start/end date fields right in the panel (writing back to the task as works placeholders on send). No more pre-filling the board first, no more greyed-out exclusions.
3. Per-item "Book trade" button routes to the same panel, pre-listing ALL tasks on the project mapped to that item's trade/contact (selected by default), plus the rest of the project's tasks collapsibly addable. The ••• "Group book a trade" menu entry is replaced by these two entry points.
4. "eg all the carpentry lines → one single booking email to the trade" is the acceptance test.

B. Aria supplier-invoice intake (money out):
5. Second Brain email pipeline flags likely supplier invoices (attachment/pdf + amount/invoice-number heuristics on ALREADY-INGESTED emails). Aria (mini) extracts: supplier, ABN, invoice number, invoice date, total inc GST, GST, line hints, job hints. MCP tool propose_supplier_invoice(payload incl. source email id) creates a DRAFT entry in the existing supplier-invoice queue (whatever its table is — study InvoiceQueue) marked source 'aria', status needing approval, with proposed project match + cost-line/item matches. HARD RULE: draft only — nothing applies without Phillip's explicit approve action in the UI (standing prompt-injection ruling; email content NEVER writes financials directly).
6. Approval UI in the Supplier invoices section: review extracted fields + matches (editable), Approve & apply / Reject. PDF attachment stored on the job.
7. Cost flow-through: when a supplier invoice application (Aria-proposed OR manual) confirms costs against matched items, the confirmed cost writes to those items' actual/confirmed cost fields AND (toggle per line, default on when a library product is linked) updates the linked library product's cost record so future quotes use real numbers. Admin-only, server-side gated like all financials.
8. Migration 052 only for what's genuinely missing after studying the existing supplier-invoice tables (extraction/source columns, status, email link). One migration.
