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

## Proposal delivery skin (r25)

Approved via animated mockup 2026-07-11. The proposal email + page adopt the website's card/paper language. Sources of truth: docs/RESLU-Card-Design-Spec.md, docs/RESLU-Paper-Animation-Brief.md, and the WORKING implementation at "…/260611_RESLU Marketing & Branding overhall/Website/reslu-site/src/components/BeginForm.astro" (filmed fold: FV geometry fractions, video alignment/clip/feather technique, write() pen + .ink CSS, cardstock #faf6ec/#e6dfcf, emboss #e2dac5). COPY, don't reinvent.

1. Email (emails/proposal-sent.html rework): the CLOSED packet as email-safe HTML on bone #EDE8DE — debossed RESLU mark, "DESIGN PROPOSAL" taupe letterspaced label, client first names handwritten in pen blue #274690 (Caveat via webfont where supported, fallbacks 'Segoe Script','Bradley Hand',cursive, -0.5deg), DATE AS PLAIN TEXT (small letterspaced #313131 — Phillip's explicit correction: date is NOT handwritten), residence line, charcoal button "OPEN YOUR PROPOSAL" → /proposal/{token}. Real text, no baked image; single table cell conventions per card spec; no em dashes.
2. Page reveal on /proposal/[token] (skin over the r23 page — document content/signing unchanged): beat 1 packet centred on bone with name inked (write() pen animation, 36ms/char) + plain-text date; beat 2 the FILMED unfold — public/begin-unfold.mp4 (already generated: begin-fold.mp4 reversed, in spec repo public/) aligned/clipped/feathered exactly per BeginForm.astro's videoFold technique with FV fractions (same footage so same fractions; packet rect = start frame, sheet rect = end frame — mirror the geometry accordingly); beat 3 video's final full sheet cross-fades out as the proposal letter text rises in; page then scrolls normally.
3. Rules: plays once per visitor (sessionStorage flag) with a quiet "replay" control near the header; prefers-reduced-motion or video-not-ready → CSS fold fallback (mockup choreography) or straight to document; never blocks signing/scrolling after reveal; mobile-first (video technique degrades to CSS fold below a width if alignment breaks); Cormorant/serif + brand colours per card spec; the r23 page's rate-limit/noindex/sign machinery untouched.

## Proposal reveal — text lands on the filmed sheet (r25.1)

Phillip 2026-07-12: option 1 approved ("text on the page in sync with the page open"; mid-fold 3D tracking parked for later).
1. In ProposalReveal beat 2→3: as the film's sheet settles flat (~last 0.6s, reuse the existing seal threshold), the document's opening section (title, client, date, first letter paragraphs) fades up POSITIONED ON the filmed sheet — aligned to the sheet end-rect the geometry maths already derives (FV sx/sy fractions → on-screen box). The doc column width matches the sheet width at that moment.
2. When the film fades (overlay bg already transparent), the text does NOT move — the sheet dissolves around it and the same text is simply the top of the scrollable document (no translateY jump; the doc's in-flow position is arranged to coincide with the on-sheet position, or the layer hands off with a transform that eases to identity).
3. CSS-fold fallback + reduced-motion/skip paths: keep current behaviour (text fades in on clear bone) — the on-sheet landing only applies to the filmed path.
4. Preview file docs/preview-proposal-reveal.html updated to match (same choreography, embedded video preserved).

## Proposal reveal — final approved choreography (r25.2)

Phillip approved the preview (docs/preview-proposal-reveal.html) 2026-07-12 ("you got it"). Port its EXACT behaviour into ProposalReveal:
1. Sheet IS the reading column: size the video so the filmed sheet's width (FV sx span) equals the document column (~520px, 86vw cap); the in-flow document renders in exactly the sheet's on-screen box (top = video top + vh*sy0 + ~14px). NO landing-layer ease-to-position — text renders in place and never moves; the paper dissolves out from under it. (Replaces r25.1's handoff; remove/bypass the ease path on the filmed route.)
2. Front ink wipe: the packet overlay (name ink + date) does NOT pre-fade. Film starts with ink visible; overlay opacity driven by film clock: 1 until t=0.9s, linear to 0 by t=1.7s (constants WIPE_START/WIPE_END).
3. Proposal fade-in: begins at duration−1.4s, opacity transition ~1.1s ease.
4. Seal (film fade-out ~0.6s, bg already transparent) at duration−0.1s; scroll unlocks there.
5. Feather deepened per preview (horizontal 6%→26% / 74%→94%, vertical 2%→16% / 84%→98% of the frame).
6. Fallback paths (cssfold/skip/reduced-motion) unchanged. The preview file is the reference implementation — match it.

## Health + web push (r26)

Phillip 2026-07-13. Mini can't be reached from Vercel → mini heartbeats OUT; diagnostics = queued request the mini picks up. Monitoring must burn zero AI credits (dumb scripts + timestamp comparisons); Claude Code repair sessions run ONLY on explicit button press.

1. Migration 053: health_heartbeats (mini posts every ~5min: uptime, disk_free_gb, mem_free_gb, openclaw_up bool, pending_updates int, extra jsonb, created_at — keep latest + prune >7 days); health_channels (channel key: whatsapp group id/email/calendar, label, status ok|degraded|down, last_inbound_at, last_outbound_at, session_valid bool, note, updated_at); health_diagnostics (id, requested_by, requested_at, status pending|running|done|failed, report text, completed_at); push_subscriptions (user_id, endpoint unique, p256dh, auth, created_at); notifications (id, user_id null=all-admins, kind, title, body, link_href, created_at, read_at).
2. Web push WITHOUT new npm deps: check package.json first — if web-push present use it; otherwise payload-less push (VAPID ES256 JWT via node crypto; empty POST to endpoint wakes the service worker, which fetches /api/notifications/latest-unread and shows it). VAPID keys from env (NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY — CC generates). public/sw.js service worker (push + notificationclick → link_href); subscribe/unsubscribe toggle in Settings; store subscription per user.
3. Notification events wired NOW: (a) trade accepts/suggests dates (r20 respond route), (b) proposal signed (r23 accept route), (c) health reds: mini silent >15min, channel down/session invalid, cron missed, diagnostics done. All also insert notifications row + daily_brief_items where sensible (dedupe).
4. Health page (sidebar entry 'Health'): mini card (heartbeat age pill, uptime/disk/mem, pending macOS updates warning, 'Run diagnostics & repair' button → inserts health_diagnostics pending + notification on completion), channels list (per group chat: status, last in/out, session pill), Spec card (each cron's last success from email_sends/daily brief tables where derivable, failed email sends count, aria_queue stuck >24h, needs_aria backlog count). Brand pills reuse booking-status colour conventions (lib/booking-status.ts pattern — separate helper, don't couple).
5. Silence checker: /api/health/check route (cron — vercel.json is PROTECTED: document the cron line for CC, e.g. every 10 min) compares timestamps → fires push/notifications (dedupe: one alert per incident, not per check).
6. MCP tools (mini side talks through these): post_heartbeat, report_channel_status, get_pending_diagnostics, complete_diagnostic(id, report). Documented in docs/ARIA.md.
7. docs/MINI-HEALTH-HANDOFF.md for Claude Code: launchd plist + curl heartbeat script spec (payload fields, bearer auth same as Aria MCP), channel-status reporting from OpenClaw, diagnostics runner loop (poll get_pending_diagnostics; repair = restart WhatsApp bridge, verify session, check softwareupdate -l; report back), VAPID keygen one-liner, env vars, cron line for vercel.json.

## QA fix round (r27)

From the 5-scenario code audit + live browser lap 2026-07-13. Priorities in order:
1. LIVE BUG — selection seed: board checkbox selection + "Book selected → trade" must seed GroupBookPanel with the selected task lines (currently the panel ignores the seed and only lists trade-mapped tasks; picking a contact with no mapped tasks shows empty). Selected lines appear checked with their inline date fields regardless of trade mapping (the reassign-on-send warning already exists — reuse). Send request DISABLED until ≥1 line checked AND a trade chosen.
2. Trade notified when Phillip ACCEPTS his counter-date: resolve route accept_shift branch must sendOrQueue a confirmation (mirror keep_reply branch's send, template consistent with booking emails).
3. Ripple shifts not silent: shift-items route — for each reconfirm_visit_ids visit (other trades' confirmed visits whose dates moved) insert a dedupe-guarded daily_brief_items attention row 'Dates moved — {trade}, {task}: reconfirm' + push via sendPushToAdmins. (Auto-email stays manual — Phillip approves each reconfirm send; the system just refuses to let him forget.)
4. Day-before reminders for CONFIRMED visits: trade-reminders cron currently filters status IN (unconfirmed,tentative) — include confirmed visits (dedupe via email_sends as usual). A confirmed trade must get his day-before nudge.
5. Brief link rides the CONFIRMATION email: add ensureBriefToken + {{brief_link}} to the booking-time confirmation mergeData in both lead routes (POST /api/leads and PATCH /api/leads/[id]), so short-notice visits still deliver the questionnaire.
6. Proposal → project carry: create-project route, when the lead has an accepted proposal, seeds the project with (a) proposal reference stored on project, (b) SOW draft lines from content.scope_sections (section title → SOW section, bullets → lines, per existing sow schema), (c) brief_answers copied onto project notes/overview field (find the right home). Additive, skippable if absent.
7. Orphaned deposit invoices: migration 054 adds client_invoices.lead_id nullable FK; accept route sets it; create-project backfills project_id on any lead's invoices; Invoices tab (or Office) gains an 'Unlinked invoices' list showing project_id-null rows.
8. Stripe recovery: client invoice send route/UI — allow creating the payment link and RE-SENDING an updated invoice (resend route with email_sends dupe guard + 'updated invoice' subject); prevent the dead-end ordering.
9. Proposal prefill: creating a proposal from a lead substitutes client names, address/residence, date into letter/vision/scope placeholders ({{client name}} etc.) server-side at create time; brief_answers surfaced in a side panel in the editor for reference while writing.
10. Daily Brief self-close: resolving a trade suggestion (resolve route), approving/rejecting a supplier invoice, and proposal-accept related items mark their corresponding daily_brief_items row done (match by source/link dedupe key).
11. Supplier invoice push: Aria intake insert also fires sendPushToAdmins + notifications row.
12. Wire the dead attention aggregator: surface /api/projects/[id]/attention (ordering_due + missing_lead_times) as a board banner chip + My Work source (respecting the exhaustive KIND_LABEL gotcha).
13. Single-visit booking (book-visit route) email goes through sendOrQueue (dedupe, Adelaide window, email_sends log) instead of raw gmail sendTeamEmail; keep sender identity as-is.
14. DailyBrief.tsx source-label map: add missing 'proposal' label.
Middleware/vercel.json untouched (CC list: health cron line, visit-emails cron investigation, Aria wake, mini scripts).
