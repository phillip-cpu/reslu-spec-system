# Aria integration guide

Aria (OpenClaw, running on the Mac mini) drives the RESLU Spec System
two ways: directly against the REST API (Phase 1, documented here and
in `docs/API.md`), and via the MCP server at `mcp/` (Phase 2, thin tool
wrappers over the same routes — see `mcp/README.md`). This file covers
authentication, the endpoints her three automations use, what stays
entirely on her side (never proxied through this app), and rate
guidance. Read alongside BUILD-SPEC.md §"Agent control — Aria" and
§"Financial visibility".

## Authentication

Aria has her own Supabase Auth user — `aria@reslu.com.au`, profile
"Aria (agent)", `role: admin` — so every action she takes is attributed
and auditable exactly like a human team member's, and so she can see
financial data (leads, invoices, estimates) the way an admin does.
There is no shared login and no service-role key involved in her normal
operation.

Using `@supabase/supabase-js` (or any Supabase client SDK):

```js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY // anon key — this is a normal user sign-in
);

const { data, error } = await supabase.auth.signInWithPassword({
  email: process.env.ARIA_EMAIL,
  password: process.env.ARIA_PASSWORD,
});

const accessToken = data.session.access_token;
```

Every REST call then carries that token as a Bearer header:

```js
const res = await fetch(`${process.env.SPEC_URL}/api/leads/attention`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
```

The access token expires (Supabase default: 1 hour). On a `401`, sign
in again and retry the request once — don't retry in a loop. This is
exactly what `mcp/src/index.mjs`'s `apiFetch()` helper does if you'd
rather not reimplement it: sign in lazily, cache the token, and on a
`401` clear the cache, re-authenticate once, and retry once.

`ARIA_PASSWORD` should be rotated via Supabase Auth (not this repo) if
ever suspected compromised — same rule as every other credential in
this project (see `.env.local.example`'s header comment).

## Endpoint quick-reference for her three automations

All three of these are documented in full in `docs/API.md`'s "Leads
pipeline — Week 10" section; this is the condensed version for quick
reference while building/maintaining her launchd scripts.

### 1. Lead monitor

Polls for genuinely new leads (e.g. to post a Slack/WhatsApp alert when
one lands, or to keep a local cache in sync).

```
GET /api/leads?since=<ISO timestamp of the last successful poll>
```

Returns `{ leads: Lead[] }` — every lead created at or after `since`.
Store the current time before each poll and use it as the next poll's
`since` value (don't reuse a lead's own timestamp — a clock a few
seconds off between polls is harmless, a few seconds of double-counted
leads is not).

### 2. Lead nurturer

Finds leads that need a human (or Aria-drafted) nudge: proposals sent
too long ago with no response, proposals that were never sent, and
follow-ups that are due or overdue.

```
GET /api/leads/attention
```

Returns `{ nurture, stale_proposals, follow_ups_due,
site_visits_upcoming }` — four arrays of `Lead`. `nurture` = stage
"Proposal Sent" for 4+ days; `stale_proposals` = stage "Awaiting to
Send Proposal" for 7+ days; `follow_ups_due` = `follow_up_date` is
today or in the past; `site_visits_upcoming` = `site_visit_date` in
the next 7 days. A lead can appear in more than one group — that's
intentional, not a bug to dedupe around.

### 3. Site brief

Prepares Aria's site-visit brief (directions, client contact, what's
been discussed so far) ahead of an upcoming visit.

```
GET /api/leads?stage=Site+Visit+Booked
```

Returns `{ leads: Lead[] }` filtered to that exact stage. Cross-
reference `site_visit_date` client-side for "upcoming in the next N
days" if the brief should only cover near-term visits — this route
does not itself filter by date, only by stage.

## What stays Aria-side (never proxied through this app)

Per BUILD-SPEC.md's "Site Visit Booked stage" note and the general
"Agent control — Aria" framing: the Spec System is the **data** system
of record for leads; it is deliberately NOT where calendar, email
sending, or messaging integrations live. None of the following exist
as API routes or MCP tools, and none should be added here:

- **Google Calendar** — creating/updating the actual calendar event for
  a booked site visit. The Spec System only stores `site_visit_date` /
  `site_visit_location` as data; Aria owns turning that into a real
  calendar entry.
- **Gmail sends** — confirmation emails to leads, nurture emails,
  anything outbound. `lib/gmail/*` in this repo sends **internal team
  digest** notifications only (portal activity digests) — it is not a
  general-purpose outbound mail API and is not exposed to Aria. Her own
  Gmail access on the mini is the correct place for anything
  client-facing.
- **WhatsApp** — any alert or message to Phillip/the team or to a lead.
  Entirely Aria-side.

If a future automation needs the Spec System to know that a calendar
invite/email/WhatsApp message was sent (e.g. for an audit trail), the
right shape is Aria writing that fact back via the `add_lead_note` MCP
tool (migration 030 round — see "Lead notes" below) — **not** `PATCH
/api/leads/[id]` with a `notes` field any more: `leads.notes` is no
longer the writable notes surface (superseded by the attributed
`lead_notes` feed), so a stray PATCH there would land somewhere the UI
no longer reads. Not this app reaching out to Google/WhatsApp itself
either way.

## Rate guidance

- `GET /api/leads/attention` and `GET /api/leads?since=` are cheap and
  designed to be polled every few minutes — no special throttling
  needed for either.
- There is no dedicated rate limiter on the leads routes today (unlike
  the client portal routes, which are rate-limited per BUILD-SPEC.md
  §Security). Be a good citizen anyway: a poll interval of a few
  minutes is plenty for lead monitoring; there's no need to poll faster
  than a human could plausibly act on the result.
- Every `POST`/`PATCH`/`DELETE` under `/api/leads/**` is a real,
  immediate write — there is no draft/dry-run mode in the API layer
  (the one-time Monday import script is the only place with a
  `DRY_RUN` mode, and that's a one-off migration tool, not something
  Aria calls at runtime).
- All leads routes are admin-gated server-side — if Aria's role is ever
  changed away from `admin` in Settings (Phillip can do this any time,
  per BUILD-SPEC.md), every one of these calls starts returning `403`
  immediately. That's the intended safety rail, not a bug to work
  around.

## Diary workflow (Phase 11B)

BUILD-SPEC.md §"Phase 11 — Diary" + §"mobile pass": staff write rough
notes on their phone (with 1-2 photos picked from the site gallery),
Aria turns that into a polished magazine-style entry, and a human
publishes it. **Aria drafts — she never publishes.** Publishing a diary
entry is always a separate, explicit, one-tap human action; nothing in
this workflow gives her (or any MCP tool) the ability to make a diary
entry appear on the client portal.

### The pipeline

1. A team member, usually on their phone on site, opens the Gallery or
   the client area's Diary tab, picks or takes 1-2 photos, types a few
   rough notes into one plain textarea, and taps "Send to Aria". This
   creates a `portal_updates` row: `status: 'draft'`, `draft_source:
   'manual'`, linked to the chosen photos via `portal_update_photos`.
2. Aria calls the `draft_diary_entry` MCP tool WITHOUT `title`/
   `body_richtext` (fetch mode) — passing `project_id` and `update_id`.
   This returns the rough notes (`update.rough_notes`) and each linked
   photo's caption/date/signed URL (`photos[]`). She reads these, then
   writes a serif-headline-worthy title and a short, warm story in the
   entry's voice.
3. Aria calls `draft_diary_entry` AGAIN, this time WITH `title` and
   `body_richtext` (submit mode). This saves her polished copy onto the
   SAME row and flips it to `status: 'pending_approval'`,
   `draft_source: 'aria'`. Nothing is published yet.
4. A human sees the entry as an approval card (`DiaryApprovalCard` in
   `components/client-area/DiaryPanel.tsx` — "Ready to publish") in the
   client area, reviews Aria's draft, optionally taps "Edit" to tweak
   the copy inline, and taps "Publish" — one tap, phone-friendly. THIS
   is the only action that sets `published_at` and `status:
   'published'`. Publishing also marks the linked photos
   `published_to_portal = true` and fires a client email notification
   (best-effort, no-op if unconfigured — see `lib/notify-client.ts`).

### `draft_diary_entry` (MCP tool)

One tool, two modes, matching how the tool is actually called across
two separate model turns (read the rough notes and photos, think, then
write the polished copy):

- **Fetch mode** — call with `{ project_id, update_id }` only. Returns
  `{ update: { id, rough_notes, current_title }, photos: [{ id,
  caption, taken_at, url }] }`. 409s if the entry isn't currently
  `status: 'draft'` (i.e. someone already submitted or published it).
- **Submit mode** — call with `{ project_id, update_id, title,
  body_richtext }`. Saves the polished copy and sets `status:
  'pending_approval'`. Also 409s if the entry has moved on from
  `'draft'` in the meantime (e.g. a human somehow published a bare
  draft in between — shouldn't normally happen since a bare draft with
  no polished copy has nothing worth publishing, but the check is
  there regardless).

There is no separate "list pending drafts" tool — Aria discovers which
project's diary draft to work on from context (she's usually invoked
right after a team member sends notes, or a human tells her which
project), the same way `post_client_update` already works. Drafts are
also visible in the team client area's Diary tab if a human wants to
check on one directly.

### `list_site_photos` (MCP tool)

`{ project_id }` -> the project's full internal gallery (published AND
unpublished), so Aria can see what's available — captions, dates,
signed URLs — when deciding which photos best fit a story, or when a
team member asks her to reference something specific from a recent
site visit. Read-only; it never publishes or modifies anything.

### Why this split matters

The publish boundary is enforced structurally, not just by convention:
neither `draft_diary_entry`'s submit mode nor any other MCP tool sets
`published_at` or writes `status: 'published'` — only `PATCH
/api/projects/[id]/client-updates/posts/[postId]` with `{ publish:
true }` does that, and that route requires a real team session (Aria's
own session included, in principle) but is only ever actually called
from the human-facing "Publish" button in the client area UI. If
Aria's credentials were ever compromised, the worst she could do to the
Diary is draft copy sitting in `pending_approval` for a human to
review — never push it live herself.

## Plan analysis + SOW drafting workflow (Phase 12a-A)

BUILD-SPEC.md "SOW completion + Aria plan analysis" / "Aria takeoff
assist". Three new tools: `list_pending_plan_analyses`,
`submit_plan_analysis`, `draft_sow_section` (see `docs/API.md`'s
"Aria plan analysis + takeoff assist — Phase 12a-A" section for the
full request/response shapes — this section is the workflow
walkthrough).

### The plan-analysis loop

1. A team member uploads a plan set as a project document (`kind:
   'plans'`, existing Project Documents feature). Aria's automation
   polls `list_pending_plan_analyses({ project_id })` — files with no
   analysis yet, each with a signed URL she can actually open and read.
2. Aria reads the plan set (her own vision/reading capability — nothing
   in this app extracts anything from a PDF/image; that intelligence
   is entirely Aria-side) and identifies: every room name annotated,
   every FF&E item code referenced, and — where actually stated on the
   drawing — dimension annotations per room (length/width/ceiling
   height/opening count/whether it's a wet area).
3. Aria calls `submit_plan_analysis({ project_id, file_id, rooms,
   item_codes, dimensions? })`. **Nothing about extraction is trusted
   or re-verified by the server** — but everything downstream of the
   submission is fully deterministic, computed server-side, never by a
   model:
   - The **cross-reference engine** (`lib/takeoff.ts
     crossReferencePlans()`) diffs Aria's submitted rooms/codes against
     the live spec register, in both directions, plus a room-name
     mismatch check against both the plan's own room list and the
     project's `rooms` table. Result stored as `plan_analyses.discrepancies`
     and surfaced on the project Overview tab's "Plan Check" card.
   - If `dimensions` were included, the **takeoff assist**
     (`lib/takeoff.ts computeTakeoffs()`) computes floor/painting/tiling
     m² by plain arithmetic over exactly what was stated — see
     `docs/API.md` for the formulas and default constants (2.4 m
     ceiling height, 1.8 m² per opening). A room with no stated
     length/width gets **no measurement row at all** — it is never
     guessed, and the drawing is never scale-measured. Every written
     measurement lands as `status: 'draft'`, `source: 'takeoff'`, with
     a `provenance_note` explaining exactly where the figure came from.
4. A human reviews the Plan Check card, the register (fixing any
   flagged mismatches), and the Areas & Measurements tab (site-measuring
   to confirm each draft measurement — flipping it to `status:
   'verified'` via `PATCH /api/estimate/measurements/[id]`, the only way
   a draft becomes trusted). Nothing in this loop writes to the
   estimate directly — a verified measurement only affects cost lines
   that are explicitly linked to it (the pre-existing Estimate ↔
   Schedule integration), same as any hand-entered measurement.

### `draft_sow_section` (MCP tool)

Same "one tool, two modes across two turns" shape as
`draft_diary_entry` above:

- **Fetch mode** — call with `{ project_id }` only. Returns the
  project's current rooms (from the `rooms` table), each room's
  assigned FF&E items (item code, name, description, category,
  quantity), the latest plan analysis's discrepancies (so a draft can
  flag a known mismatch rather than silently gloss over it), and a
  clause-pattern skeleton per room (`lib/sow-templates.ts
  roomSectionTemplate()` — the recurring Demolition → Partitions &
  Plastering → Electrical → Waterproofing → Floor Finishes → Wall
  Tiling → Joinery → Stone → Sanitaryware & Tapware → Shower Screen →
  Painting → Specialty Items sub-heading shape both reference SOWs
  follow) to ground her drafting.
- **Submit mode** — call with `{ section_id, lines }`. `section_id`
  must already exist — a human (or Aria, via the normal SOW builder
  API) creates the empty section first (`POST
  /api/projects/[id]/sow/[sowId]/sections`), then this call populates
  it, line by line, via the same `POST
  /api/sow/sections/[sectionId]/lines` route a human's typing already
  uses. Every written line is an ordinary draft `sow_lines` row —
  editable, deletable, re-orderable in the builder exactly like a
  hand-typed one. **Nothing here ever issues or publishes a SOW** — the
  "Issue" button is a human, session-gated action
  (`POST /api/projects/[id]/sow/[sowId]/issue`), same structural
  separation as the Diary's publish boundary above.

### "Start from template" — not an Aria tool, a human one

The clause library itself (`lib/sow-templates.ts`) also powers a plain
UI button — "Start from template" in `SowBuilder.tsx` — for a team
member to pre-populate a brand-new draft SOW with the standard General
Notes / Site Management & Handover / Exclusions boilerplate plus one
section per project room, WITHOUT involving Aria at all. This is
deliberately not exposed as an MCP tool: it's a one-click bulk-populate
action a human triggers directly in the builder
(`POST /api/projects/[id]/sow/[sowId]/from-template`), not something
Aria needs to call as part of her drafting loop (her loop instead calls
`draft_sow_section` above, section by section, grounded in the actual
plan analysis rather than blanket boilerplate).

## Office board (Phase 13)

BUILD-SPEC.md §"13 Office" / `docs/OFFICE-BRIEF.md` (Aria's own Monday
board export, 5 Jul 2026). The Office board is **global** — not
per-project, not part of any job — it's RESLU's internal business
housekeeping board: Marketing, Website, Meta Ads, Google Ads,
Operations, Systems & Tech, Phillip's personal queue, and Archived.
Two new MCP tools: `create_office_task`, `list_office_tasks`.

### Her stated inbound-work pattern

Per OFFICE-BRIEF.md's "What Aria automates today": the old morning-brief
surfacing of this board was abolished 4 Jul 2026 (Phillip checks his own
inbox frequently now). What replaced it is a create -> resolve loop:

1. **Create** — any actionable item Aria encounters via email, WhatsApp,
   or conversation that doesn't belong on a client job board gets
   written to the Office board via `create_office_task`, assigned to
   whoever should own it (Phillip, by default, per the brief's
   "Outstanding items rule" — assigned to Phillip with a due date) with
   a due date.
2. **Resolve in 24-48 hours** — this is Aria's own stated turnaround for
   inbound work she's created a task for. She (or a human) works the
   item, then the task is completed via the normal UI (checkbox tick in
   the Office board grouped list) — completing moves it into the
   Archived group automatically (see BUILD-SPEC.md "13 Office" point 2
   / migration `021_office.sql`'s `prev_group_id` column). There is no
   MCP "complete" tool — Aria's role in this loop is creating and
   tracking via `list_office_tasks`, not marking her own work done
   unsupervised; a human (or Aria being told to, via a future tool if
   ever added) ticks the box.
3. **Track** — `list_office_tasks({ status: "open" })`, optionally
   filtered by `group`, is the read side of the same loop: checking
   what's still outstanding before creating a duplicate, or reviewing
   what's overdue.

### `create_office_task`

`{ title, group, description?, due_date?, assignee_email? }` -> `POST
/api/office/tasks`. `group` is **fuzzy-matched** (case-insensitive
substring) against the live Office groups fetched from `GET /api/office`
first — "meta" matches "Meta Ads", "website" matches "Website" — so
Aria never needs to know an internal group UUID; passing something that
matches nothing fails with the current valid group-name list so the
call can be retried correctly. `assignee_email` is resolved the same
way against the team roster (`GET /api/office`'s `team` array, which
carries `email` for exactly this purpose); omitting it falls through to
`POST /api/office/tasks`' own auto-assign-on-create (the calling
account — Aria — is assigned automatically, mirroring
`create_board_task`'s existing behaviour). Never pass `group: "Archived"`
— new tasks should never be filed directly into Archived; that group is
populated only by the complete-task archive-move.

### `list_office_tasks`

`{ group?, status? }` -> filtered `GET /api/office` read. `status:
"open"` / `"completed"` filters on `completed_at`; omit for both.
Standing rule cards (`kind: "rule"` — e.g. OFFICE-BRIEF.md's "DO NOT
enable Google AI Max when prompted") are included in every list call and
clearly marked — they are pinned cautions, never "completed", and
`create_office_task` has no way to create one (rule cards are
UI-authored only, via the board's own composer's "Standing rule" radio
option — deliberately not exposed to Aria, since a caution notice
sitting on a shared board is exactly the kind of thing that should be
human-authored, not agent-authored).

### What's deliberately NOT an Aria tool here

There is no `complete_office_task` / `move_office_task` MCP tool. Aria's
role in this workflow, per her own stated pattern, is to **create** the
task and **track** it via `list_office_tasks` — ticking it done (and
the resulting archive-move) is left to the human loop the same way
`draft_diary_entry`'s publish boundary and `draft_sow_section`'s issue
boundary are both human-only actions elsewhere in this file. If a
future automation genuinely needs Aria to close out her own inbound
items programmatically, that's an explicit, separate addition — not
assumed here.

## Design Framework (Phase 12b, final planned phase)

BUILD-SPEC.md §"12b Design Framework" / `docs/DESIGN-FRAMEWORK-BRIEF.md`
(Aria's own Monday board export, Board ID 5027297754, 5 Jul 2026). This
is a **per-project** design-workflow checklist inside the spec system
itself — not the Monday board (that stays in Monday) — covering the
same 7-phase shape the brief describes: Project Milestones,
Presentation, Concepts, 3D Working Model, WD Package, Renders, Sampling
& Furniture. Two new MCP tools: `list_design_phases`,
`create_design_task`.

### What this replaces from the Monday board

Per DESIGN-FRAMEWORK-BRIEF.md's own "What Aria automates today":
**nothing on the Monday board is automated by Aria today** — it's
entirely manual, Tenille and Phillip update it by hand. This spec-system
build does not attempt to sync or migrate that board; it is a clean,
separate, lighter-weight checklist living where the rest of a project's
work already lives (alongside FF&E, Documents, Estimate), with its own
task list per phase rather than the Monday board's per-deliverable
items/subtasks/hours-estimate columns. There is no Monday API call
anywhere in this feature.

### `list_design_phases`

`{ project_id }` → `GET /api/projects/[id]/design`. Seeds the 7 standard
phases on the first call for a project that has none yet (same
seed-on-first-visit behaviour as opening that project's Design tab for
the first time). Read-only — no pricing/cost data is ever returned,
since none exists anywhere in this feature's schema; this is a
design-workflow checklist, never a quoting surface.

### `create_design_task`

`{ project_id, phase, title, description?, due_date?, assignee_email?
}` → `POST /api/design-tasks`. `phase` is **fuzzy-matched**
(case-insensitive substring) against that project's live phase list
fetched from `GET /api/projects/[id]/design` first — "wd" matches "WD
Package", "concepts" matches "Concepts" — so Aria never needs to know
an internal `design_phase_id` UUID; passing something that matches
nothing fails with the current valid phase-name list so the call can be
retried correctly. `assignee_email` is resolved the same way against
the team roster (`GET /api/projects/[id]/design`'s `team` array, which
carries `email` for exactly this purpose, mirroring `OfficeTeamMember`);
omitting it falls through to `POST /api/design-tasks`' own
auto-assign-on-create (the calling account — Aria — is assigned
automatically, mirroring `create_board_task`'s and
`create_office_task`'s identical behaviour).

### The WD-Package hinge is NOT an Aria automation

BUILD-SPEC.md: "completing WD Package prompts SOW + estimate version
creation ('design package → quoting')." This hinge
(`components/projects/design/WdPackageHingePanel.tsx`) is a purely
client-side, human-facing prompt panel shown in the Design tab UI once
the "WD Package" phase is marked complete — there is no MCP tool that
triggers it, checks for it, or actions its two buttons ("Create SOW
from template" / "Save estimate version") on Aria's behalf. Marking a
design phase complete is not exposed as an MCP action at all (see
below) — this hinge is deliberately a human moment in the workflow, the
point where the team decides quoting should start, not an automatic
trigger Aria could fire unsupervised.

### What's deliberately NOT an Aria tool here

There is no `update_design_phase_status` / `complete_design_task`
MCP tool. Aria's role in this feature, per the same structural pattern
as the Office board above (and the Diary's publish gate, the SOW's
issue gate elsewhere in this file), is to **create** tasks and
**track** them via `list_design_phases` — ticking a task done, cycling
a phase's status, or actioning the WD-Package hinge are all left to the
human loop. If a future automation genuinely needs Aria to update
phase/task state programmatically, that's an explicit, separate
addition — not assumed here.

## Round B — materials price list (list/create still not an Aria tool)

BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 4 added a
global `materials` price list (`GET/POST /api/materials`,
`GET/PATCH/DELETE /api/materials/[id]`,
`POST /api/materials/[id]/refresh-price` — see `docs/API.md`'s "Round
B" section for the full route contract) and two client-side-only
calculators (timber frame, plasterboard) that link a material and can
insert a computed cost as a real estimate line.

**No `list_materials` / `create_material` MCP tool exists yet.**
Documented here as a known, deliberate gap rather than silently
omitted: the materials list is small, low-churn reference data (timber
profiles, plasterboard sheet sizes, screws/adhesive) that the team
manages by hand from inside a calculator's inline "+ Add material"
control — there was no immediate driver for Aria to read or write this
list programmatically the way she already does for `items`/`invoices`/
`leads`. If a future automation needs it (e.g. Aria bulk-importing a
supplier's price list), add `list_materials` (`GET /api/materials`,
straightforward passthrough) and `create_material` (same shape as
`create_office_task`/`create_design_task` above) as an explicit,
separate addition — the underlying REST routes already support it
fully; only the MCP tool wrapper is missing. (`submit_material_price`
— the PRICE-RESOLUTION half of materials — DOES now exist; see "Board
cockpit round" below. This gap is specifically about bulk list/create,
which remains unaddressed.)

The calculators themselves (timber frame / plasterboard) are NOT, and
are never expected to become, an Aria tool — they are pure client-side
math run interactively in the Estimate tab's UI (`lib/calculators.ts`
has no server route to call), the same "human-in-the-loop" framing as
the WD-Package hinge above: Aria has no reason to run a takeoff
calculation unsupervised, only the resulting `POST
/api/estimate/sections/[sectionId]/lines` call (already Aria-visible,
unchanged by this round) if she were ever asked to add an estimate
line directly.

## Board cockpit round (7 July 2026) — booking chase + blocked-site pricing

Two new tool PAIRS, each a "see what's outstanding" read tool plus a
"resolve it" write tool — same shape as the plan-analysis and diary
loops above, just single-call rather than two-turn.

### Booking chase: `get_bookings_overdue` + `book_trade_visit`

`get_bookings_overdue({})` → `GET /api/board-tasks/attention`. Cross-
project (no `project_id` filter, like `get_needs_attention`). Surfaces
two situations: a booked trade visit whose `booking_date` has passed
and is still `unconfirmed`/`tentative`/`proposed_change` (i.e. nobody
has actually locked it in), or a `kind: 'milestone'` card whose
`due_date` has passed. See `lib/board-cockpit.ts`'s
`computeBookingsOverdue()` for the exact rule.

`book_trade_visit({ task_id, phase_id, contact_id?, start_date,
end_date, arrival_slot?, arrival_time?, notes? })` → `POST
/api/board-tasks/[id]/book-visit`. Creates the `trade_visits` row and
links it to the card in one call (same route the Board's "Book trade"
button uses). **Booking EXECUTION is deliberately allowed here** — a
narrower exception to this file's usual "Aria drafts/creates, a human
publishes/confirms" pattern (Diary's publish gate, SOW's issue gate,
Office/Design's complete gates, all above). The reason booking is
different: booking a trade visit does not commit RESLU to anything
irreversible or client-facing by itself — the visit is created in
`status: 'unconfirmed'` and the **trade themselves** are the ones who
actually confirm it (via their own token link, `POST
/api/trade/[token]/respond` — see `docs/API.md`'s trade-confirmation
section). Aria proposing a date is exactly as provisional as a human
staff member proposing one from the Board UI; nothing becomes final
until the trade confirms. There is no `unlink`/`cancel` tool
(unlinking a booking is left to a human via the Board UI's "Unlink
booking" action) — Aria's role in this loop is chase-and-book, not
undo.

### Blocked-site pricing: `get_materials_needing_aria` + `submit_material_price`

BUILD-SPEC.md/verification note: `bunnings.com.au` and
`wilbrad.com.au` — two of the most commonly linked supplier sites for
`materials.product_url` — are VERIFIED to hang on a plain server-side
fetch (not a hypothetical edge case). `POST /api/materials/[id]/
refresh-price` already never hard-fails the request either way (see
`docs/API.md`), but until this round a hung/blocked refresh just left
the material's price stale with no signal that it needed a different
approach. It now sets `materials.price_refresh_status = 'needs_aria'` +
`price_refresh_requested_at` on any failed refresh (bad fetch, non-HTML
response, or no price found on the page).

`get_materials_needing_aria({})` → `GET /api/materials/attention`.
Every material currently flagged `needs_aria`, so Aria can pick these
up the same way she works `get_bookings_overdue`/`get_needs_attention`.

`submit_material_price({ material_id, price, source_note? })` → `PATCH
/api/materials/[id]` with `{ price, notes: source_note }`. Sets the new
price, stamps `price_refreshed_at`, and clears `price_refresh_status`
back to `null` — resolving the outstanding request the same way a
successful automated scrape would have. `source_note` REPLACES the
material's `notes` field (materials have one flat `notes` field, not an
append-only log like item notes) — Aria should mention where the price
came from (e.g. "Bunnings product page, checked by phone 7 Jul") so a
human reviewing the materials list later has context. The Materials UI
(`components/calculators/MaterialLinkControl.tsx`) shows a "Waiting for
Aria" caption on any material in this state, so a team member browsing
the calculator sees the same signal Aria is working from.

## Lead notes — migration 030 round (7 July 2026)

New tool: `add_lead_note`. `leads.notes` (the old flat free-text
column) is no longer the writable notes surface for anyone, Aria
included — it's been superseded by an attributed, timestamped
`lead_notes` feed (same shape as item notes), and the UI
(`components/leads/LeadDetailPanel.tsx`) no longer offers the old field
for editing at all.

```
add_lead_note({ lead_id, text })
```

→ `POST /api/leads/[id]/notes`, `{ text }`. Admin-only (leads are
admin-only, financial-adjacent — same gate as every other leads
route/tool). `author_name` is stamped server-side from Aria's own
profile (`"Aria (agent)"`), exactly like every note/task she creates
elsewhere in this system — never passed in the tool call.

**This is the tool to use for exactly the "write it back" cases this
file's "What stays Aria-side" section above calls out** — logging that
a call was made, an email was sent, a WhatsApp message went out, or any
other outcome worth keeping on the lead's record, without this app
ever reaching into Google/WhatsApp/Gmail itself. Worked example:

> Aria calls a lead per the nurturer automation, gets voicemail, then
> calls `add_lead_note({ lead_id: "...", text: "Called 7 Jul, 2:15pm —
> no answer, left voicemail asking to call back re: proposal
> follow-up." })` so the next person (human or Aria) who opens this
> lead sees the attempt logged, timestamped and attributed, in the
> feed — not buried in a single overwritable `notes` string.

Distinct from `move_lead_stage`: this tool never changes the lead's
stage, it only appends to the notes feed — the two are independent
actions and neither implies the other.

## Reading RESLU plans — drawing conventions reference

When analysing uploaded plan sets (plan-analysis loop), consult `docs/DRAWING-CONVENTIONS.pdf` — RESLU's drawing layout style guide. It documents: the drawing sequence (A000 cover → A100 plans → A200 elevations → A300 sections → A400 internal details → A500 window/door schedules → A600 joinery), text conventions (Gill Sans Light, all caps, sizes per label type), the item-code prefixes as used ON DRAWINGS, joinery labels (DRW drawers, HR hanging rail, FS fixed shelf, ADJ adjustable shelf), dimension conventions (blocked/uniform, benchtops one measurement per size with edge profiles via legend), and QA notes (shower grate locations, pop-up wastes must appear on plans). Use it to disambiguate codes and labels during extraction; note the FF&E register's category prefixes (not this guide's older list) are canonical when they conflict.
