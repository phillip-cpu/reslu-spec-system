# RESLU Spec System

A project specification and procurement platform for RESLU, replacing Programa.
Built with Next.js 16, TypeScript, Tailwind, and Supabase.

This README covers **local setup only** — written for someone without a software
background. If something doesn't match what you see on screen, stop and ask
before continuing.

## What you need before you start

1. **Node.js** installed on your computer (version 20 or later). Check by opening
   Terminal and typing:
   ```
   node -v
   ```
   If that fails, download Node from https://nodejs.org (choose the LTS version).

2. **A Supabase account** — free to create at https://supabase.com. Ask Phillip
   if a RESLU Supabase project already exists before creating a new one.

3. **This project folder** on your computer, e.g. `reslu-spec-system`.

## Step 1 — Install dependencies

Open Terminal, move into the project folder, and run:

```
cd path/to/reslu-spec-system
npm install
```

This downloads everything the app needs. It can take a few minutes the first time.

## Step 2 — Set up Supabase

1. Go to https://supabase.com/dashboard and create a new project (or open the
   existing RESLU one). Name it `reslu-spec`, region `ap-southeast-2 (Sydney)`.
   Use the **Pro plan** — the free plan pauses the database after 7 days of
   inactivity, which would take the app offline unexpectedly.

2. Once the project is created, open the **SQL Editor** in the Supabase
   dashboard and run these files **in order** (each is idempotent — safe
   to re-run if you're not sure whether it already applied):
   - `supabase/migrations/001_initial.sql` (creates all tables)
   - `supabase/migrations/002_grants.sql` (grants the app's database
     roles access to those tables — without this, every screen shows
     "permission denied for table …")
   - `supabase/migrations/003_profiles_provisioning.sql` (auto-creates a
     profile for each team member — without this, adding items fails
     with a foreign-key error)
   - `supabase/migrations/004_library_scraper.sql` (library trade-price
     provenance + duplicate-detection columns + scraped-document staging)
   - `supabase/migrations/005_portal_approvals.sql` (approval-reset audit
     log)
   - `supabase/migrations/006_monday_email.sql` (adds `projects.settings`
     JSON column used for per-project Monday column mapping, and creates
     the `portal_digest_queue` table used by the team email digest)
   - `supabase/migrations/007_estimating.sql` (Estimate module tables +
     creates the **`item-images`** storage bucket, public — durable
     product/cover images embedded in the register, portal, and PDF)
   - `supabase/migrations/008_project_files.sql` (Project Documents table)
   - `supabase/migrations/009_assets_bucket.sql` (creates the **`assets`**
     storage bucket, private + measurement-linking columns on
     `cost_lines` + `projects.cover_image_path`) — **this is the fix for
     the "spec sheet attach fails" bug**: earlier working copies of this
     app never created the `assets` bucket at all (nothing did — it was
     assumed to exist), so every item-document/project-document/invoice
     upload failed in a fresh Supabase project until this migration was
     added. If you're upgrading an existing deployment, run this one
     migration and the uploads will start working with no other changes.
   - `supabase/migrations/010_storage_policies.sql`,
     `supabase/migrations/011_sow_overview.sql`,
     `supabase/migrations/012_portal_expansion.sql` (Storage RLS
     policies, Scope of Works builder + overview hub, portal expansion +
     native e-signature — see `docs/API.md` §"Portal expansion & native
     e-signature — Week 8B")
   - `supabase/migrations/013_boards_contacts.sql` (Address Book
     `contacts` table + link-point columns on `cost_lines`/`items`,
     project kanban board tables, Gantt `schedule_phases` table — see
     `docs/API.md` §"Address Book, Project board & Gantt — Week 9")
   - `supabase/migrations/014_leads.sql` (Leads pipeline: `leads` +
     `lead_stage_events` tables, `projects.lead_id` link column — see
     `docs/API.md` §"Leads pipeline — Week 10" and "Leads + Aria" below)
   - ... migrations 015–027 (see `docs/API.md`'s dated sections for
     each — Trade visits & Timeline v2, Portal v2/diary/gallery,
     My Work/Board v2/housekeeping, Office board, Insurance flag,
     Design Framework, Fix Round A, Round A, Round B)
   - `supabase/migrations/028_job_numbers.sql` (adds `projects.job_number`
     — auto-generated 3-digit job number per project, unique;
     **backfills existing projects sequentially by creation date, and
     specifically sets any project literally named "Goldsworthy" to
     `026`** — that's their real pre-existing job number, not a
     placeholder, so don't rename the demo project away from
     "Goldsworthy" before running this migration if you want that
     backfill rule to apply to it)
   - `supabase/migrations/029_board_cockpit.sql` (Board cockpit round —
     `board_tasks.kind`/`visit_id`/`booking_date`/`booking_end_date`,
     `phase_task_templates` app setting, `materials.price_refresh_status`
     — see `docs/API.md`'s dated section)
   - `supabase/migrations/030_standards_lead_notes.sql`
     (`library_items.is_standard` flag + `lead_notes` table, replacing
     `leads.notes` as the editable notes surface — folds any existing
     `leads.notes` text into one imported `lead_notes` row per lead on
     first run; see `docs/API.md` §"Standard spec items + lead notes —
     migration 030 round")
   - `supabase/migrations/031_board_v3.sql` (Board v3 — Monday parity
     round; see `docs/API.md`'s dated section)
   - `supabase/migrations/032_visit_document_pack.sql` (adds
     `trade_visits.document_pack jsonb` — frozen "Include documents"
     choices from `BookVisitPanel`, powering the trade booking page's
     new DOCUMENTS section; no RLS change, additive column on an
     already-permissive table — see `docs/API.md`'s "Trade booking
     document pack" section)
   - `supabase/seed.sql` (adds the category codes and a demo project)
   - `supabase/seed_contacts.sql` (optional — Address Book seed data
     parsed from RESLU's Monday.com export, ~109 companies across 30
     trade categories; idempotent, safe to re-run)

3. Storage buckets are now fully created by the migrations above — no
   manual Storage dashboard step needed. For reference: `item-images` is
   **public** (product/cover images, safe to be public-read — nothing
   sensitive lives there), `assets` is **private** (item documents,
   project documents, invoice PDFs — client-related files, served via
   short-lived signed URLs minted server-side, never a permanent public
   link).

4. Go to **Authentication → Providers** and make sure **Email** is enabled.
   Go to **Authentication → Settings** and turn **off** "Allow new users to
   sign up" — accounts for this app are created manually by an administrator,
   not via self sign-up.

5. Create a login for yourself: **Authentication → Users → Add user**, enter
   an email and a password. Repeat for each team member (Phillip, Tenille,
   Nathan, Tony).

6. Go to **Settings → API** in the Supabase dashboard. You'll need three
   values from this page in the next step:
   - Project URL
   - `anon` `public` key
   - `service_role` key (keep this one especially private)

## Step 3 — Configure environment variables

1. In the project folder, copy the example environment file:
   ```
   cp .env.local.example .env.local
   ```
2. Open `.env.local` in a text editor and paste in the three Supabase values
   from Step 2.6 above. Leave the Monday.com and Gmail values blank until
   you're ready to turn those integrations on (see "Monday.com and Gmail
   integrations" below) — the tokens mentioned in the original planning
   document must be rotated (replaced with new ones) before they're used
   anywhere, since they were exposed in a shared file.
3. Save the file. **Never share this file or commit it to git** — it holds
   real credentials once filled in.

## Step 4 — Run the app locally

```
npm run dev
```

Then open http://localhost:3000 in your browser. You should be redirected to
a login page. Sign in with one of the accounts you created in Step 2.4.

To stop the app, go back to Terminal and press `Ctrl + C`.

## What's built so far

- Project scaffold, brand styling (cream/charcoal/sand, no rounded corners)
- Database schema with categories, projects, items, files, approval history
- Login page and route protection (you can't view the app without signing in)
- Dashboard showing all projects, with a "New Project" form
- A demo project ("Goldsworthy") is included in the seed data once you run it
- **Spec register** (`/projects/[id]`) — Programa-style grid grouped by
  location or category, with inline editing (name, supplier, brand, quantity,
  location, status, and an expandable detail row for the rest: colour,
  material, finish, dimensions with an implausible-dimension warning,
  description, product URL). No pricing or ordering data appears here — the
  list endpoint explicitly selects spec-view columns only.
- Item images (upload or paste a URL — copied into Supabase Storage),
  documents (spec sheet / install manual / other, stored in Supabase
  Storage), and attributed notes, all from the expanded item row.
- A **"Fetch details"** button next to Product URL, wired to
  `POST /api/items/[id]/scrape` — stubbed (501) until the real scraper lands
  in Week 3.
- **CSV import** (`/projects/[id]/import`) — upload a Programa-ish export,
  confirm the auto-suggested column mapping, and bulk-create items. Explicit
  item codes in the file are respected; blank codes are assigned by the
  database. Duplicate item codes are skipped and reported, not overwritten.
  A worked example lives at `supabase/fixtures/goldsworthy-import.csv`
  (parsed from the real Goldsworthy tender FF&E schedule — a few rows are
  flagged in its Notes column where the source PDF was ambiguous).
- Internal **Pricing & Procurement** view (toggle above the register) —
  trade price, markup, lead time, order/ETA/delivered dates. Never shown on
  the client portal or the builder PDF.
- Product library, client portal, PDF export, and Monday.com sync (one-way,
  on status → Ordered).
- **Week 4** — Monday.com sync rebuilt properly (`lib/monday/client.ts` +
  `lib/monday/sync.ts`): real column mapping (status, supplier, quantity,
  product URL, ordered/ETA dates) driven by each project's
  `settings.monday.columns` JSON, `change_multiple_column_values` for
  re-syncing an already-created item, and a manual retry route
  (`POST /api/monday/sync/[itemId]`). Every Monday GraphQL call uses
  variables only — never string interpolation. The item PATCH route's
  edit whitelist gained the fields the scrape/duplicate-detection flows
  need (`image_options`, `scrape_status`, `scraped_documents`,
  `product_url_normalized`), and now strips `price_trade`/`markup_pct`
  from both reads and writes for non-admin sessions, matching the
  library API's gating pattern.
- **Week 4** — Team email digest redesigned around a durable queue
  (`portal_digest_queue`, migration 006) instead of sending on every
  portal click: `lib/gmail/digest.ts`'s `recordPortalAction()` queues
  each client approve/flag, and `POST /api/digest/flush` (any signed-in
  team member) batches pending rows per project and emails all admins,
  e.g. "Goldsworthy — client activity: 2 approved, 1 flagged (SW-04:
  'wrong colour')" with a link to the register.
- **Week 4** — Settings gained a real **Team** section (admin can change
  roles via `PATCH /api/profiles/[id]`, blocked from demoting the last
  admin) and a real **Integrations** section (green/grey dots reflecting
  whether `MONDAY_API_TOKEN` / the Gmail credential trio are present on
  the server — never exposes the values themselves). A new
  **Project Settings** page (`/projects/[id]/settings`) covers project
  field edits, the Monday board ID, the client portal link (copy +
  admin-only regenerate), and admin-only archiving.

- **Week 8B — Client portal expansion + native e-signature.** The portal
  (`/portal/[token]`) is now sectioned, mobile-first, with a sticky anchor
  nav: **Schedule & approvals** (unchanged), **Documents** (project files
  with `share_to_portal` on, grouped by kind), **Contracts & signatures**
  (pending/signed/void signature requests, with a link to the dedicated
  sign page), **Variations** (shared variations — description + cost
  **inc GST only**, the one deliberate pricing exception, with
  Approve/Decline + an optional note), **Progress photos** (grid, newest
  first, simple full-width lightbox), and **Updates** (published posts as
  a feed, rendered through a tiny hand-written markdown renderer —
  paragraphs/`**bold**`/`- lists` only, never `dangerouslySetInnerHTML`).
  All of it token-gated, rate-limited, and `noindex`, same trust model as
  the original Week 3B portal.
  **Native e-signature** (`/portal/[token]/sign/[requestId]`): the client
  opens the document in an embedded viewer, draws a signature on a plain
  `<canvas>`, types their full name, and ticks a binding consent
  statement. `POST /api/portal/[token]/sign/[requestId]` recomputes the
  document's SHA-256 **server-side** from the actual stored bytes, saves
  the drawn signature as a private PNG, and inserts an **append-only**
  `signature_events` row (hash, typed name, signature image path, portal
  token, IP, user agent, timestamp — RLS on that table grants INSERT +
  SELECT only, no UPDATE/DELETE policy exists for anyone). A branded
  signature-certificate PDF is generated via React-PDF and stored as a
  new file alongside the original (the original is never overwritten —
  no PDF-stamping library is in this project, so the certificate is a
  separate document by design) and emailed to admins if Gmail is
  configured. Editing a signed variation's cost/description automatically
  voids its signature request (a database trigger); a superseded project
  file (new revision row) is voided manually by the team from the new
  **client area**.
  **Team-side client area** (`/projects/[id]/client`, not yet linked from
  the project tab bar — see Troubleshooting): upload progress photos
  (multi-file, captions), write and publish update posts (draft list,
  publish/unpublish), request signatures against a project document
  (status chips, certificate link), and toggle which documents/variations
  are shared to the portal. Team-visible throughout, **except** the
  variation share toggle, which is admin-only (enforced server-side —
  sharing a variation exposes a client-facing price) and shows a
  "Last update published N days ago" cadence hint (amber past 14 days).
  New tables: `portal_updates`, `progress_photos`, `signature_requests`,
  `signature_events`; `project_files`/`variations` gained `share_to_portal`;
  `variations` gained `client_response`/`client_response_note`/
  `client_responded_at` (migration `012_portal_expansion.sql`). See
  `docs/API.md` §"Portal expansion & native e-signature — Week 8B" for
  the routes.

- **Week 9 — Boards, Gantt, Address Book** (replaces Monday.com task/
  scheduling functionality). **Address Book** (`/contacts`, sidebar
  entry between Library and Settings): global, searchable, grouped-by-
  category trade/supplier directory (company, contact, phone, email,
  website, specialty, category, notes), add/edit inline, soft delete.
  Seeded from RESLU's Monday export (`supabase/seed_contacts.sql`, ~109
  companies). Contacts link onto estimate cost lines (who's quoting/
  doing the trade — shows a company chip) and onto item supplier fields
  (picking a contact autofills supplier/supplier email if empty).
  **Project board** (new "Board" tab): a per-project kanban with
  editable columns (seeded To Do / In Progress / Waiting / Done),
  cards showing title, assignee initials, linked contact, and due date
  (red if overdue), native HTML5 drag-and-drop between columns, add-card
  composer per column, rename/add/delete columns (delete only when
  empty). **Procurement board** (third toggle option, "Board", on the
  FF&E workspace, alongside Spec/Pricing & Procurement): a read-only-
  pricing kanban lens over the same items grouped by status
  (Specced/Quoted/Ordered/On Site/Installed) — dragging a card between
  columns calls the exact same status-PATCH path the other two views
  use, so the existing Monday sync-on-"Ordered" still fires; no pricing
  is ever shown here. **Timeline** (new "Timeline" tab): a CSS-grid
  Gantt — phase names down the left, weeks across the top (capped 52,
  month labels), bars positioned by grid-column start/span in
  brand-muted colours, inline edit panel per phase (name/dates/colour/
  contact/notes), mirrored read-only (bars + dates only, no contacts/
  notes) into the client portal's new "Timeline" section. New tables:
  `contacts`, `board_columns`, `board_tasks`, `schedule_phases`
  (migration `013_boards_contacts.sql`). See
  `docs/API.md` §"Address Book, Project board & Gantt — Week 9" for the
  routes and the drag-drop sort scheme.

- **Phase 11A — Trade confirmation engine + Timeline v2.** Each phase
  can now hold multiple trade visits (`trade_visits` — dates, arrival
  slot/time, status, contact) — the phase row itself stays a single
  bar with a compact strip of status dots; full detail (add/edit/
  delete a visit, contact picker, arrival slot/time) lives in the
  existing phase edit panel. An auto-maintained **"Site Setup" umbrella
  band** renders as a full-width, system-managed row spanning the whole
  project schedule whenever the estimate's "Preliminaries & Site" cost
  section has live line items — its dates are recomputed every time the
  Timeline tab loads, and tapping it shows the section's line
  descriptions (no pricing) instead of an edit form. Long schedules get
  a **week/month zoom toggle** (grids over 12 weeks), a collapsible
  **"Completed" phases group**, and a vertical **today line**; on
  mobile the phase-name column stays sticky while scrolling weeks, and
  tapping a visit dot opens a bottom sheet with a one-tap "confirm on
  behalf of trade" button.
  Trades themselves respond via a public, unauthenticated page at
  `/trade/[token]` (same unguessable-token trust model as the client
  portal) — **Confirm as-is**, **Confirm a different time** (same day,
  auto-accepted, no staff approval needed), or **Propose another day**
  (staff then accepts or counters from the team side). The trade page
  shows a "who else is on site" list (company + status only — never
  another trade's contact name, phone, or email) and, if no arrival
  time has ever been nominated, requires choosing one before a first
  confirm can complete. A daily reminder email (`/api/trade-reminders`,
  cron `0 21 * * *` — 07:30 Adelaide time) nudges trades 1–2 days
  before an unconfirmed visit. A **needs-attention** endpoint surfaces
  pending trade counter-proposals and visits starting within 3 days.
  New table: `trade_visits`; `schedule_phases` gains `kind`
  (`'phase'|'umbrella'`) and `cost_section_id` (migration
  `015_trade_visits.sql`). See `docs/API.md` §"Trade visits & timeline
  v2 (Phase 11A)" for the full route list.

- **Week 10 — Leads pipeline + Aria API/MCP layer.** New sidebar entry
  **Leads** (`/leads`, admin-only — hidden from the sidebar and
  page-gated for non-admins, same "restricted" pattern as Invoices),
  covering first-contact-to-construction: a 10-stage kanban
  (Potential Lead → Site Visit Booked → Awaiting to Send Proposal →
  Proposal Sent → Design Work In Progress → Construction In Progress,
  plus Unable to Contact / Lead Lost / Complete / Potential Future Lead
  visually muted at the end) with a list-view toggle, drag-drop stage
  changes, an add-lead composer, and a detail panel (all fields
  editable, single-save pattern like estimate lines, stage-history
  timeline, notes). Moving a lead to "Design Work In Progress" surfaces
  a one-click **Create project** button that creates a real project
  from the lead's name/first name/location and links both records
  together. A **needs-attention panel** surfaces four groups at the top
  of the page (follow-ups due, proposals sent 4+ days with no
  follow-up, proposals never sent after 7+ days, site visits in the
  next 7 days), and a **pipeline dashboard** strip shows total active
  pipeline value plus active-stage count/value/avg-days-in-stage chips.
  `Potential Future Lead` is shown separately as **future nurture** and,
  like Unable/Lost/Complete, contributes zero to every pipeline tally
  while retaining its individual indicative construction value on the
  lead record. New tables: `leads`, `lead_stage_events` (append-only, populated
  by a DB trigger on every stage change — migration `014_leads.sql`);
  `projects` gained `lead_id`. Leads are the first data in this app
  called out as needing stronger-than-usual protection ("admin-only,
  financial-adjacent") — enforcement is still API-layer-only (whole-
  route 403, same shape as Invoices/Estimate), consistent with every
  other table's RLS in this schema (see that migration's own extended
  comment on why).

  **One-time Monday leads import** (`scripts/import-monday-leads.mjs`,
  plain Node, run by hand on the mini — never in this sandbox): reads
  every item off Monday board `1808939489`, maps each item's Monday
  **group title** to one of the 10 stages (the `META`/`DIRECT` groups
  both map to `Potential Lead` with `source` set accordingly), and
  upserts into `leads` keyed on `monday_item_id` — safe to re-run.
  Defaults to `DRY_RUN=1` (prints what it would do, writes nothing);
  set `DRY_RUN=0` to actually import. This is a **one-time** migration,
  not an ongoing sync — per the locked Monday-replacement strategy, the
  native `leads` table becomes the sole source of truth after this runs
  once, and no code anywhere reads Monday leads-board state back into
  the app.

  **Aria API layer**: `docs/API.md` §"Leads pipeline — Week 10"
  documents the full leads CRUD + stage-move + needs-attention routes;
  `docs/API.md` itself is now the single consolidated API doc — the
  two per-week "additions" files (`docs/API-portal-additions.md`,
  `docs/API-week9-additions.md`) have been folded in and deleted.
  `docs/ARIA.md` is new: how Aria authenticates
  (`supabase-js signInWithPassword` → Bearer token), the exact
  endpoints her lead-monitor/nurturer/site-brief automations should
  poll, what deliberately stays on her side (Google Calendar, Gmail
  sends, WhatsApp — none of that is proxied through this app), and
  rate guidance.

  **MCP server** (`mcp/`, a separate Node package installed on the
  mini, not a dependency of this app): exposes 15 tools
  (`list_projects`, `get_project`, `list_items`, `create_item`,
  `update_item_status`, `list_leads`, `move_lead_stage`,
  `get_needs_attention`, `list_invoices`, `create_invoice`,
  `post_client_update`, `draft_diary_entry`, `list_site_photos`,
  `list_contacts`, `create_board_task`) — each a thin `fetch()` against
  the REST API using Aria's own bearer token (lazy sign-in, cached, one
  retry on a 401). See `mcp/README.md` for install steps and an
  OpenClaw/Claude Code MCP config snippet.

Client-portal financial gating and the real scraper pipeline (image/RRP
extraction + PDF document detection) were completed in Week 3. Role-based
admin enforcement for financial fields is now in place project-wide
(library, items, settings) as of Week 4.

- **Phase 11B — Portal v2, diary, site gallery, notifications.**
  Migration `016_portal_v2.sql`. The client portal (`/portal/[token]`)
  is now: What's next (derived this-week/next-week banner) → Selections
  (FF&E approvals restyled to scale to 200+ items: progress bar, filter
  chips, room-grouped bulk approve, full-screen one-by-one review
  stepper, design-phase decision deadlines) → Timeline → Diary
  (magazine-style journal, replacing "Updates") → Documents (+
  certificates, signed badges) → Contracts & signatures → Variations →
  Progress photos → Handover (manuals/warranties/certificates/gallery,
  shown only once a project is marked Completed). A new internal
  **Gallery** tab (`/projects/[id]/gallery`) is the staging area for
  site photos — "Take photo" (camera-direct on phones) or "Upload"
  (multi-select), client-side compressed to max 2000px before upload,
  grouped by date, with a publish toggle and "Add to diary draft". The
  **Diary** composer in the client area is phone-first: pick photos,
  write rough notes in one big textarea, tap "Send to Aria" — she
  drafts a polished title + story via the `draft_diary_entry` MCP tool,
  and a human one-taps "Publish" (she never publishes herself). Client
  email notifications (`lib/notify-client.ts`) fire on diary publish,
  new shared documents, and shared variations (no-op without Gmail
  config or a project `client_email`). See `docs/API.md`'s "Portal v2,
  diary, gallery & notifications (Phase 11B)" section and
  `docs/ARIA.md`'s "Diary workflow" section for full detail.

- **Phase 12a-B — My Work, Board v2, housekeeping, client events.**
  Migration `020_mywork_board_events.sql`. New sidebar entry **My
  Work** (`/my-work`) — per-user Overdue / Today / This week / No date
  feed across board tasks, admin lead follow-ups, diary drafts pending
  approval, trade-visit proposals, and overdue client decisions, plus a
  personal notes panel. **Board v2**: cards now support multiple
  assignees (stacked initials), auto-assign the creator on card create
  (overridable), a new **Grouped list** view (Monday-style phase tables
  — Site Prep/Demolition/Rough-in/Waterproofing & Tiling/Fit-off/
  Handover, seeded on first visit to that view), and new boards seed
  columns Waiting-first. **Housekeeping**: project `alias` (Settings →
  shown muted on the dashboard card, project header, My Work — never
  client-facing), the project name in every sub-tab header now links
  back to Overview, and the project tab bar gained a right-aligned
  "View client portal ↗" + "Copy link". **Client events**: the project
  Client area gained a "Meetings" tab (`client_events` table) and the
  portal shows an "Upcoming meetings" card next to What's Next; a
  day-before reminder email sends via `POST /api/client-events/remind`
  — **this route has NO cron entry yet** (`vercel.json` is out of this
  change's scope) — see "Cron jobs" note below. See `docs/API.md`'s "My
  Work, Board v2, housekeeping, client events — Phase 12a-B" section.

- **Phase 13 — Office board.** Migration `021_office.sql`. New sidebar
  entry **Office** (`/office`) — a GLOBAL (not per-project) Monday-style
  grouped list covering business housekeeping: Marketing, Website, Meta
  Ads, Google Ads, Operations, Systems & Tech, Phillip (personal queue),
  Archived. Multi-assignee + subtasks ('2/5' progress chip, expand a
  row to tick them) on every task card; **standing rule cards**
  (pinned, sand-left-border, no checkbox/due date, un-completable — e.g.
  "DO NOT enable Google AI Max"). Ticking a task complete moves it into
  the Archived group automatically (original group remembered so
  un-completing restores it); Archived renders collapsed by default.
  Feeds `/my-work` as a new source. See `docs/API.md`'s "Office board —
  Phase 13" section and `docs/ARIA.md`'s "Office board (Phase 13)"
  section (new MCP tools `create_office_task` / `list_office_tasks`).

- **Phase 12b — Design Framework (final planned phase).** Migration
  `025_design_framework.sql`. New project tab **Design** (between
  Overview and FF&E) — a fixed 7-phase design checklist per project
  (Project Milestones, Presentation, Concepts, 3D Working Model, WD
  Package, Renders, Sampling & Furniture, seeded on first visit),
  each phase a vertical section with a status control (not
  started/in progress/complete/N/A), a task list (multi-assignee,
  auto-assign creator, red-overdue due dates), an add-task composer,
  and a progress chip. Completing **WD Package** shows a one-time,
  dismissible "Design package complete — start quoting?" prompt
  linking to **Create SOW from template** and **Save estimate
  version** (the design-to-quoting hinge). Adds a Design progress
  card to the project Overview and a new `design_task` source to
  `/my-work`. See `docs/API.md`'s "Design Framework — Phase 12b"
  section and `docs/ARIA.md`'s matching section (new MCP tools
  `list_design_phases` / `create_design_task`).

- **Small round (6 July 2026)** — item image picker moved into a
  proper modal (was a cramped inline strip), "Add to calendar ▾"
  (download .ics or open in Google Calendar, with an invitee picker)
  on the lead detail panel's site visit and every client event row,
  and item codes are now editable via the API (`PATCH /api/items/[id]`
  — codes are sticky and never auto-renumber; see `docs/API.md`'s
  "Small round" section). The item-code edit UI itself is a follow-up
  — see `docs/HANDOFF-code-editing.md`.

- **Round A (6 July 2026)** — Timeline bars are now drag/resize
  interactive (day-snapped, optimistic PATCH) with a right-click
  context menu (edit dates, shift ±1 week, book trade, change colour,
  add phase at a clicked week — long-press on touch); the Board's
  Grouped-list view gained compact start/end date inputs on
  phase-linked group headers (PATCHes the same phase Timeline edits);
  and the project tab bar now animates a sliding underline instead of
  a static border. See `docs/API.md`'s "Round A" section for the full
  breakdown.

- **Round B (6 July 2026)** — Spec-register items can now link to a
  measurement (Areas & Measurements) so their quantity is DERIVED
  (value × wastage%, coverage-converted to boxes/lengths) instead of
  hand-typed — same UX the Estimate module's cost lines already had,
  now on items too, wired into the Pricing & Procurement view (Spec
  view follow-up documented in `docs/HANDOFF-item-qty-links.md`); the
  FF&E rollup uses this derived quantity when a link is present. New
  global **materials price list** (`/api/materials`, with a
  "Refresh price" button that reuses the item scraper's price
  extraction) backs two new **Calculators** — timber frame (studs,
  plates, noggins, jack studs/lintels, greedy bin-packing onto stock
  lengths) and plasterboard (net area → sheets) — in a new
  Calculators tab on the Estimate workspace, each able to insert its
  result straight in as a real estimate line. See `docs/API.md`'s
  "Round B" section for the full breakdown.

- **Round — focus links, job numbers, grouped add (6 July 2026
  evening)**. Migration `028_job_numbers.sql`. **Auto job numbers**:
  every project gets a 3-digit number (`#026` style) auto-assigned on
  creation (rolls to 4 digits naturally past 999), overridable in
  Settings, shown muted next to the project name in the header and
  dashboard card, and printed as "Project No. 026" on both the FF&E
  schedule PDF (cover + footer) and the SOW PDF cover (replacing the
  old UUID-prefix stand-in). **My Work focus deep-links**: clicking a
  My Work item now scrolls straight to that exact card/row on the
  target page and pulses a sand outline around it for two seconds
  (board tasks, office tasks, diary drafts, trade proposals, design
  tasks; item/register rows are an interim wire-up — see
  `docs/HANDOFF-focus-register.md`). **Grouped-list add-task**: each
  phase group in the Board's Grouped list view now has its own inline
  "+ Add task" composer (previously only the kanban columns did). See
  `docs/API.md`'s "Three from Phillip — 6 July 2026 evening" section
  for the full breakdown.

- **Board cockpit round (7 July 2026)**. Migration `029_board_cockpit.sql`.
  Board cards can now be **booked directly to a trade** ("Book trade"
  button on the card editor — kanban and grouped-list share the same
  full editor now) with a live status badge, and carry a distinct
  **booking date (works)** alongside the existing **due date (to-do)**.
  Cards can be marked **milestones** (diamond marker on the card and the
  Gantt timeline), which prompt a dismissible "start a diary draft?"
  nudge when moved to Done. **Phase task templates** (Settings) seed a
  checklist of board cards automatically whenever a phase is seeded —
  ships with a default Site Setup checklist (fencing/toilet/skip/
  signage). New **shared searchable ContactPicker** (keyboard-navigable)
  replaces five separate hand-rolled contact pickers across the Board,
  Timeline, and Estimate tabs. The Gantt timeline now shows tick markers
  for every linked card's due/booking date (plus milestone diamonds),
  clickable straight back to the card, and a proper **Day/Week/Month**
  zoom toggle. **Aria booking-chase** and **blocked-site pricing**
  attention feeds (`bookings_overdue`, `price_refreshes_pending`) plus
  two new MCP tools (`book_trade_visit`, `submit_material_price`) close
  the loop on trades that need chasing and Bunnings/Wilbrad-type
  supplier pages that hang on a plain fetch. Timber frame calculator
  gains a "Double studs each side of openings" toggle. See
  `docs/API.md`'s "Board cockpit round — 7 July 2026" section for the
  full breakdown.

- **Round — visit sub-bars, $/m² rate, design task templates (7 July
  2026, no new migration)**. The internal Timeline gains an
  **expandable trade-visits layer**: each phase row gets a chevron
  (auto-expanded at Day zoom; expansion remembered per project via
  `localStorage`) revealing one thin, drag/resize-able sub-bar per
  trade visit — status-styled (confirmed solid, unconfirmed/tentative
  dashed, proposed-change amber), reusing the exact same grid math and
  drag helpers (`lib/gantt.ts`, `lib/phase-drag.ts`) phase bars already
  use. Dragging a **confirmed** visit's dates now surfaces a
  non-blocking **"Dates changed — re-send confirmation?"** button
  (new `POST /api/visits/[id]/resend-confirmation`) — see
  `docs/API.md` for the state-machine finding this uncovered (creating
  a visit never sent an email in the first place). The **plasterboard
  calculator** now derives and shows a **$/m² materials rate** from the
  linked material's price ÷ the selected sheet size, included in the
  inserted estimate line's note — display-only, no schema change (sheet
  size still isn't stored on `materials`). **Design task templates**
  (Settings → "Design task templates") seed each of the 7 Design
  Framework phases with a starting checklist extracted from
  `docs/DESIGN-FRAMEWORK-BRIEF.md`'s real Monday board content, created
  alongside a project's Design phases on first visit — editable,
  code-level fallback (no migration seed this round). See
  `docs/API.md`'s matching section for the full breakdown.

- **Round — book-visit prefill fix + brick calculator (7 July 2026
  evening, no new migration)**. Fixed a bug where opening **"Book
  trade"** from a board card (any surface — kanban card, Stacked
  section, or the Grouped-list view, the daily driver) always opened
  the booking popover with phase/trade/dates blank instead of
  prefilled from the card — root cause was the popover component
  itself never accepting that context as props, not just a missed
  wire-up; both are fixed and prefilled values stay fully editable
  before submitting. New **Brick calculator** (third tab in
  Calculators, alongside Timber frame/Plasterboard): brick length/
  height/width mm start blank (no assumed brick spec), 10mm mortar
  joint default, wall dims + openings + wastage %, bricks-per-m²/total
  bricks/a clearly-labelled approximate mortar volume, unit-aware
  costing (divides by 1000 for "per 1000"-priced materials), and a new
  **"Request pricing via Aria"** action for materials with no price or
  an already-stale one — reuses the existing `refresh-price` route
  (`?mode=supplier_quote`) and needs_aria mechanism with a distinct
  "Supplier quote needed" email, same once-only guard, same "Waiting
  for Aria" badge. See `docs/API.md`'s matching section for the full
  breakdown, including the one gap (no supplier-contact column on
  `materials`) this round documented rather than filled with a
  migration.

- **Round — Timeline Day-zoom polish (7 July 2026, no new migration)**.
  Fixed the Day-zoom bar-scale bug (bars were still positioned/sized in
  whole-WEEK units under the hood, only the columns had been widened) by
  introducing `lib/gantt-window.ts` — a single windowed, day-granularity
  geometry source that phase bars, the umbrella band, visit sub-bars,
  and tick/milestone markers all now read from at Day/Week zoom (Month
  zoom is unchanged, still whole-project week math). Day/Week zoom gain
  a real day-of-month header with a today highlight, ◀ ▶ / Today period
  navigation with a visible-range label and ←/→ keyboard nav, a
  transform-based drag preview with 10px edge zones and a floating
  "22 Jul → 26 Jul" date chip, and continuation chevrons on bars clipped
  at the window edge. Phase names link to their Board group
  (`?focus=group-<id>`) and Board group headers gain a reciprocal "View
  on timeline ↗" link; left-column date ranges now render "22 Jul → 25
  Jul" instead of raw ISO. Portal `TimelineSection.tsx` is untouched —
  it keeps `lib/gantt.ts`'s original whole-range week math.

- **Standard spec items + lead notes (7 July 2026, migration
  `030_standards_lead_notes.sql`)**. Library items can now be flagged
  **"★ Standard"** (toggle in the Library UI) — a "Standard spec items ·
  N" checklist, pre-ticked and untickable, then shows up both at
  **Create Project** and at the leads **"Progress to job"** step
  (compact variant), and every ticked item is copied onto the new
  project's register via the existing library→project copy logic
  (shared, not duplicated — `lib/library-items.ts`). Renders nothing
  when no items are flagged standard. Separately, **leads gain an
  attributed, timestamped notes feed** (`lead_notes`, same shape as
  item notes) replacing the old single free-text `leads.notes` field —
  the migration folds any pre-existing `leads.notes` text into one
  imported note per lead so nothing is lost; the column itself isn't
  dropped, just no longer editable from the UI. New MCP tool
  `add_lead_note` for logging call/email outcomes against a lead. See
  `docs/API.md`'s "Standard spec items + lead notes — migration 030
  round" section for the full breakdown.

- **Board v3 — Monday parity (migration `031_board_v3.sql`)**. The
  Grouped list view is now the board's default — full-width tables per
  stage, a 4px coloured left bar + coloured title (a 5-colour rotating
  palette by sort order), column headers reading exactly "ITEM · WHO ·
  STATUS · CONTACT · WORKS · DUE · AFTER", ~30px compact rows, a
  collapse chevron + "N items · M done" summary, and an inline "+ Add
  item" row. The phase template is now the **real 13-stage construction
  sequence** (Site Establishment → Handover & Close Out, each ending in
  its own "◆ Stage complete" milestone — Stage 13 ends with a plain
  item instead) — existing projects get the same one-click **"Apply
  stage template"** backfill affordance the Design tab already has,
  shown only when the whole board is empty, and idempotent per group
  (never duplicates tasks). **Sub-items** (`board_tasks.parent_task_id`,
  one level deep, enforced in the API not the DB) — expandable rows
  under a parent with a "└" prefix and a "done/total" count chip that
  is a pure display summary only (no auto-rollup into the parent's own
  status). New boards now seed **Not Booked / Booked / In Progress /
  Done** status columns (replacing Waiting/To Do/In Progress/Done) with
  tinted pills — existing boards are never migrated. A task with a
  **confirmed** booking shows the Booked column's colour purely for
  display whenever the board has a column matching `/booked/i` — this
  never changes the task's real status. Muted "after ◆ {previous
  stage's milestone}" dependency chips are shown display-only on each
  stage's first item — no blocking, no schema. See `docs/API.md`'s
  "Board v3 — Monday parity round" section for the full breakdown.

- **Board v3.1 — display-first cells + phase date rollup.** Board
  cells (status/dates) now display as quiet text/pills, becoming
  controls only on click; a group's stage header shows a computed
  works-date range (read-only, "derived from item dates") whenever any
  of its tasks has a booking date set, kept in sync with the Timeline
  via a server-side rollup. See `docs/API.md`'s "Board v3.1 —
  display-first cells + phase date rollup" section.

- **Board v3.2 — two-way timeline sync + reorder animation.** Dragging
  a DERIVED phase's Timeline bar now writes back to its linked group's
  tasks instead of the phase row directly — the bar BODY shifts every
  task's works dates by the drag delta (`POST
  /api/phases/[id]/shift-items`), the EDGE zones move only the
  first/last item's own boundary date (`POST
  /api/phases/[id]/adjust-boundary`) — a confirmed trade visit whose
  dates move this way still gets the existing "re-send confirmation?"
  affordance. Manual (non-derived) phases are unaffected. Board
  drag-reorder (grouped list + sub-items) now animates: neighbouring
  rows slide apart to open a slot with a 2px sand drop-line while
  dragging, settling with a brief transform on drop — pure CSS
  transforms, no changes to the underlying drag/drop or sort
  persistence. See `docs/API.md`'s "Board v3.2 — two-way timeline sync
  + reorder animation" section for the full breakdown.

- **Board v3.3 — placeholder dates + booking actually sends.** Reverses
  v3.1's read-only works-date deviation: the WORKS cell is a genuine
  start/end popover again, PATCHing `board_tasks` directly (syncing a
  linked visit's dates + flagging re-confirm when it changes a confirmed
  booking). Booking a trade from a card now sends its confirmation email
  immediately instead of staying silent until the day-before cron (which
  still fires unchanged as a second nudge). `BookVisitPanel` shows a
  "From: {card title}" trace line and locks its phase field when opened
  from a card. See `docs/API.md`'s "Board v3.3 — placeholder dates +
  booking actually sends" section for the full breakdown.

- **Trade booking document pack (migration `032_visit_document_pack.sql`).**
  `BookVisitPanel` gains an "Include documents" section — three
  checkboxes (Plans, Schedule, Scope of Works), each defaulting ON when
  the corresponding document is available. Schedule auto-picks a
  category-filtered export preset by matching the booking contact's own
  category against the studio's export presets (which now support an
  optional "Applies to contact categories" field in Settings), falling
  back to a small trade-keyword heuristic, then the full schedule. The
  three choices are frozen onto the visit as `document_pack` and shown
  on the trade's own `/trade/[token]` booking page as a new DOCUMENTS
  section — Plans (latest revision), "Your schedule — {preset}" (the
  same pricing-free spec PDF the team downloads, filtered to the picked
  categories), and the Scope of Works (latest issued revision) — each
  served through a new tokened proxy endpoint
  (`/api/trade/[token]/documents/plans|schedule|sow`) that re-checks the
  visit token and the specific pack choice on every request, so a trade
  can only ever reach documents their own booking actually offered. The
  booking confirmation, resend, and day-before reminder emails all gain
  one shared, brief mention line when a visit's pack has anything
  ticked. See `docs/API.md`'s "Trade booking document pack" section for
  the full breakdown.

- **Order-by engine — product deadlines from trade bookings (8 July
  2026, no new migration).** An item a trade installs must be ordered a
  lead time before that trade's works date — e.g. a sliding door frame,
  Carpenter booked 21 Jul, 3-week lead time = order by 30 Jun. Computed
  entirely from existing schema (`items.lead_time_weeks`/`ordered_at`,
  `trade_visits`, `board_tasks.booking_date`, `contacts.category`) by
  new pure module `lib/order-by.ts`, matching each unordered item's
  category to a trade booking via the same export-presets mapping the
  document-pack Schedule auto-pick already uses (Settings now labels
  this list "Trade mappings", copy only). Surfaces: a new **ORDER BY**
  column in the Pricing & Procurement view (red/overdue, amber/due-soon,
  amber "Set lead time", a subtle dot on any item missing a lead time
  even before a booking exists); a new admin-only
  `GET /api/projects/[id]/attention` feed (`ordering_due` +
  `missing_lead_times`, additive alongside every existing per-domain
  attention endpoint); a My Work rollup line ("Order 4 items for
  Carpentry — works 21 Jul"); and an Aria MCP tool
  (`get_ordering_attention`, per-project) plus a `lead_time_weeks` arg on
  `update_item_pricing` so lead times get recorded straight from a
  supplier quote. See `docs/API.md`'s "Order-by engine" section and
  `docs/ARIA.md`'s "Order-by engine — chasing overdue orders" section
  for the full breakdown.

## Cron jobs — one still needs wiring up (Phase 12a-B)

`vercel.json` currently schedules `/api/digest/flush` and
`/api/trade-reminders`. Phase 12a-B adds a THIRD reminder route,
`POST /api/client-events/remind` (day-before email for upcoming client
meetings), but does not add its cron entry — that file is out of this
change's boundary. To wire it up, add this entry to `vercel.json`'s
`crons` array (same UTC slot as the existing trade-reminders entry —
both are once-a-day "day before" nudges):

```json
{ "path": "/api/client-events/remind", "schedule": "0 21 * * *" }
```

The route already accepts both `GET` and `POST` and authenticates via
`CRON_SECRET` exactly like the other two cron routes, so no other
change is needed once the entry is added and deployed.

## Daily Brief cron (migration 041)

BUILD-SPEC.md §"Daily Brief" — a single shared team brief on the My
Work page, generated each morning from the existing attention feeds
(bookings_overdue, ordering_due, lead nurture/stale, trade
proposed_change, expiring insurance) plus manual/Aria-appended items.

**Migration file-number note**: this round's brief asked for
`supabase/migrations/033_brief_and_due_times.sql`, assuming migrations
001–032 were the full set. This working copy already had migrations up
to 040 (the RESLU Second Brain rounds — `033_aria_queue.sql` through
`040_change_proposals.sql`) by the time this round ran, so the actual
new file is `supabase/migrations/041_brief_and_due_times.sql` — see
that file's own header comment for the full explanation. Nothing else
about the schema's substance changed from the brief (plus one
additive, documented deviation — `converted_office_task_id` — see the
same file's "SECOND DEVIATION NOTE").

Two entries are needed in `vercel.json`'s `crons` array (that file is
out of this round's boundary — CC adds these):

```json
{ "path": "/api/brief/generate?send=1", "schedule": "30 21 * * *" }
```

`21:30 UTC` = `07:00 ACST` (South Australia standard time, UTC+9:30) —
i.e. correct for winter (the current season, per the "8 July 2026"
dates throughout BUILD-SPEC.md). **DST caveat**: South Australia
observes daylight saving (ACDT, UTC+10:30) roughly October–April. This
single fixed cron line will fire at **08:00 ACDT** during that window,
not 7:00am, since Vercel Cron always runs in UTC with no DST
adjustment (the exact same limitation `/api/digest/flush`'s own doc
comment already documents for its own multi-slot schedule — see that
route's header). Two options if a genuinely-fixed 7am matters
year-round: (a) accept the one-hour DST drift (simplest — a slightly-
early or slightly-late brief once or twice a year is low-stakes for a
"whenever Phillip gets to his desk" morning digest), or (b) add a
SECOND cron entry at `"30 20 * * *"` (7:00am ACDT) and have the route
itself gate on the Adelaide-local hour, mirroring `/api/digest/flush`'s
own `DIGEST_HOURS` gate — not implemented here since option (a) matches
this feature's own low-urgency framing ("sticky-note", not a
time-critical send).

The generator route (`POST`/`GET /api/brief/generate`) is idempotent —
running it more than once in a day (the cron entry above, plus any
manual "regenerate" trigger) never creates duplicate brief items; see
`lib/daily-brief.ts`'s and `lib/daily-brief-generate.ts`'s own header
comments for the exact dedupe rule. `?send=1` additionally sends the
7am glance email (skips cleanly with zero admin recipients, zero open
items, or no Gmail configured) — see `docs/API.md`'s "Daily Brief"
section for the email's exact content.

## Site-visit lifecycle emails (migration 043)

`docs/RESLU-Spec-Visit-Emails-Brief.md`: client-facing "your site visit
is booked" / "your site visit is tomorrow" emails, for both lead site
visits (`leads.site_visit_date`) and project client_events
(`starts_at`). Three on-machine steps before real client emails go out:

1. **Set `RESEND_API_KEY`** (see `.env.local.example`) — a SECOND
   Resend API key in the same account as the website's own, not a
   reused key. Until this is set, every send/queue attempt no-ops
   cleanly (logged `'skipped'`, `reportError('visit-emails', ...)`) —
   nothing crashes, nothing is lost.
2. **Copy the real templates** from the website repo —
   `reslu-site/emails/visit-confirmation.html` and
   `reslu-site/emails/visit-reminder.html` — into this repo's
   `emails/` folder, overwriting the two placeholder files shipped
   with this round. See `emails/README.md` for the exact paths; no
   code change is needed, `lib/visit-emails.ts`'s `loadTemplate()`
   reads them by filename at send time.
3. **Add the reminder cron entry** to `vercel.json`'s `crons` array
   (that file is out of this round's edit boundary — CC adds this,
   same as the client-events-remind entry above):
   ```json
   { "path": "/api/visit-emails/run", "schedule": "45 21 * * *" }
   ```
   `21:45 UTC` = `07:15 ACST` (winter). **DST caveat** (same limitation
   as every other fixed-UTC cron line in this codebase — see the Daily
   Brief cron section above): this lands at `08:15 ACDT` during South
   Australia's daylight-saving window (roughly October-April), not
   7:15am — low-stakes here, since `GET/POST /api/visit-emails/run`
   re-checks the Adelaide 7am-7pm sending window itself at send time
   regardless of when the cron actually fires (see
   `app/api/visit-emails/run/route.ts`'s own header comment for the
   full write-up).

Everything else is already wired up once those three steps are done:
`PATCH /api/leads/[id]` and `POST /api/leads` send/queue a confirmation
whenever `site_visit_date` is set (and cancel any still-pending queued
send when it's cleared); `POST /api/projects/[id]/client-events` sends/
queues a confirmation when the project has a `client_email`; `DELETE
/api/client-events/[id]` cancels any still-pending queued send.
`GET/POST /api/visit-emails/run` flushes due queued sends and sends the
"day before" reminder sweep. See `docs/API.md`'s "Site-visit lifecycle
emails" section for the full endpoint/guard/window write-up.

Migration file-number note: this round's brief specifically named
`supabase/migrations/043_visit_emails.sql` (assuming migrations
001-042 were the full set) — this working copy's migrations already
run through `042_lead_intake.sql` at the time this round ran, so
`043` is in fact the correct next number with no renumbering needed
(contrast with the Daily Brief round above, whose brief's assumed
number was already taken).

## Trade-scoped SOW extracts (migration 044)

"Select all carpentry" -> a condensed PDF scope for just that trade.
No on-machine steps — everything ships working once migration `044`
is applied (Step 2 above covers this automatically for a fresh
install; an existing environment just needs the one new file run).

- **Tag lines with a trade** — each SOW line in the builder
  (`components/sow/SowBuilder.tsx`) gets a small trade `<select>`
  (renders as a sand chip once set). Trade names are your existing
  **Trade mappings** list (Settings -> the same `app_settings
  ('export_presets')` rows the FF&E schedule export and the Order-by
  engine already use) — one vocabulary for "which trade" everywhere in
  the app.
- **Auto-suggest** — "Start from template" tags every room section's
  lines automatically by clause label (e.g. a "WALL TILING — ..." line
  becomes Tiler); the builder's **"Suggest trade tags"** button
  re-runs the same heuristic against any currently-untagged lines on
  an existing draft SOW and reports how many it tagged. See
  `docs/API.md`'s "Trade-scoped SOW extracts" section for the full
  keyword table.
- **Download an extract** — the SOW area's download group now shows
  "Full" plus one chip per trade that has at least one tagged line in
  the current revision. An extract keeps General Notes and Exclusions
  in full (site conditions/compliance/exclusions apply to everyone)
  and filters every other section down to that trade's tagged lines
  only, omitting anything left empty.
- **Trade booking pack** — when a trade is booked with the Scope of
  Works included, the booking page automatically prefers that trade's
  own extract over the full document, IF the latest issued SOW
  currently has any lines tagged for that trade (re-checked live, not
  frozen at booking time) — otherwise it falls back to the full SOW,
  same as before this round.

## Client invoicing — phase 1: design fees (migration 046)

BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 5: branded tax
invoice PDFs, numbered, GST-compliant, emailed with the PDF attached.
Money IN (RESLU billing its own client) — deliberately separate from
the pre-existing supplier **Invoices** queue (money OUT, trade bills),
which is untouched by this round. Table `client_invoices` (migration
`046_client_invoices.sql`) — Step 2 above covers applying it
automatically for a fresh install; an existing environment just needs
the one new migration file run.

**On-machine setup steps (in order):**

1. **Run migration 046** (via the Supabase SQL editor, or your usual
   migration runner — see Step 2 above). This also widens
   `email_sends.record_type`'s check constraint to accept
   `'client_invoice'` (a small, additive change — nothing about the
   existing site-visit email rows changes).
2. **Enter real bank details** — Settings -> **"Client invoicing — bank
   details"** (admin only). Account name, BSB, account number. This is
   **not pre-filled with anything** — until you save real values here,
   every invoice PDF prints "Bank details not configured" instead of a
   payment panel. Nothing in this codebase ever invents/guesses a bank
   account number.
3. **`RESEND_API_KEY`** — reused from the site-visit lifecycle emails
   feature (see below); invoice sends use the same key with a different
   from-address (`RESLU <accounts@reslu.com.au>`). If you haven't set
   this up yet, invoice "Send" will 503 with a clear message until you
   do — the invoice itself still gets created/PDF-previewed fine.
4. **`STRIPE_SECRET_KEY`** (optional) — only needed if you want the
   per-invoice "Create payment link" button. Creating the Stripe
   account and generating this key is entirely your own task (never
   automated by Claude/Aria — it's a financial account). See
   `.env.local.example`'s own comment block for the exact env var and
   what it unlocks. Bank transfer remains the standard payment method
   either way; Stripe is an optional add-on for small (design-fee-sized)
   invoices only.

**How it works day-to-day:**

- On a project's **Invoices** tab, the new **"Client invoices — money
  in"** section sits above the existing **"Supplier invoices — money
  out"** section (same page, clearly separated headings so the two
  directions of money are never confused).
- **New invoice**: pick design fee/other, line items (description +
  amount ex GST, add/remove rows), due days. Client name/email/address
  prefill from the project but are stored as the invoice's OWN
  snapshot — editing the project's client details later never rewrites
  an already-created invoice. GST/subtotal/total are always computed
  server-side (`lib/client-invoices.ts`), never trusted from the
  browser.
- **Numbering**: `{job_number}-{seq}` (e.g. `026-01`) for a project with
  a job number (see migration `028_job_numbers.sql`), or `GEN-{seq}` for
  a project without one / no project at all. A voided invoice's number
  is never reissued.
- **Preview PDF** works on a draft (no send required) — useful for a
  final check before emailing.
- **Send** emails the branded PDF (attached directly, not linked) via
  Resend and flips the invoice to `sent`. Unlike the site-visit
  lifecycle emails, invoice sends are **not** restricted to the 7am-7pm
  Adelaide window — an admin-triggered send goes out immediately.
- **Mark paid** / **Void** are manual, explicit actions — MYOB stays the
  ledger of record (manual entry, no API sync in phase 1, per BUILD-
  SPEC.md DECISIONS).
- **Create payment link** (only shown when `STRIPE_SECRET_KEY` is set)
  creates a Stripe Payment Link for the invoice's exact total and turns
  on the PDF/email's "Pay online" button. Never created automatically.

**Deliberately out of scope for phase 1** (documented, not forgotten):
a global cross-project `/invoices` list (project-scoped only for now),
progress-claim/estimate-driven line item generation (manual entry
only), and MYOB API sync (manual entry stays the process).

## CPD tracker (migration 047)

BUILD-SPEC.md "CPD point tracker" — tracks Continuing Professional
Development points per team member, per licence year. That section's
own placeholders (exact annual target, licence-year start month, CBS
category split) were never resolved to real regulatory numbers, so
this ships with sensible, **admin-editable** defaults instead of a
guess: **12 points/year, licence year starting July**. Table
`cpd_entries` (migration `047_cpd.sql`) — Step 2 above covers applying
it automatically for a fresh install; an existing environment just
needs the one new migration file run.

**On-machine setup steps:**

1. **Run migration 047** (Supabase SQL editor, or your usual migration
   runner). Nothing else is required — unlike the client invoicing
   round's bank details, CPD ships with working defaults straight away
   (12 points/July start), so there's no "not configured yet" state to
   fill in before the page is useful.
2. **Adjust the defaults if they're wrong** — Settings -> **"CPD"**
   (admin only): annual target (points) and licence year start month.
   Applies studio-wide; there is no per-person target in this version
   (see `lib/cpd.ts`'s own doc comment for the extension point a future
   round would need).

**How it works day-to-day:**

- **`/cpd`** (sidebar, between Library and Address Book) — every team
  member tracks their own entries: date, activity, provider, points,
  category (free text, with suggestions), optional evidence upload
  (certificate/confirmation email/screenshot — private `assets` bucket,
  signed URLs), optional notes. One combined add/edit form (mobile-
  friendly), edit/delete your own entries.
- **Header progress**: "`{points-to-date} / {target} points · Licence
  year ends {date}`", a sand progress bar that fills fully (and shows
  "Target reached") once you're at or over target for the current
  licence year.
- **Admin "All team" toggle**: switches the entries list to every team
  member's entries, grouped by person with their own mini progress bar
  each — the admin-only view for checking the whole studio's compliance
  at a glance.
- **Download CSV**: builds a CSV **client-side** from whatever's
  currently loaded (your own entries, or the whole team if the toggle
  is on) — audit-friendly columns (date, activity, provider, category,
  points, notes, logged by, evidence on file). **PDF export is
  deliberately deferred** to a future round.
- **My Work nudge**: if your CPD points-to-date fall behind a
  straight-line pro-rata pace toward the annual target (only checked
  once you're 2+ months into the licence year, so a fresh year never
  nags early), one gentle line appears on `/my-work` — "CPD: 4 / 12
  points — behind pace" — linking straight to `/cpd`. Per-user, not
  admin-gated.
- **Aria**: logs CPD entries from webinar/course confirmation emails via
  the `add_cpd_entry` MCP tool — see `docs/ARIA.md`'s "CPD logging"
  section. Evidence attachment via that path is deferred (no automated
  "forward confirmation email → attach evidence" pipeline yet); Aria
  notes the confirmation email's existence in the entry's `notes`
  field instead.

**Monday.com CPD board (seed note):** RESLU previously tracked CPD on a
Monday.com board (board id `5028780272`). A one-off import script to
pull that board's history into `cpd_entries` is **deferred** — at the
current volume (a handful of entries per person per year), re-entering
the recent history by hand into `/cpd` (or asking Aria to log the
handful of confirmation emails still in the inbox via `add_cpd_entry`)
is faster than writing and testing a one-off Monday API import script.
Revisit this if/when CPD tracking is rolled out to more team members
and the backlog grows large enough to make manual entry impractical.

**Deliberately out of scope for v1** (documented, not forgotten):
per-user annual target override (one studio-wide target for everyone),
a fixed CBS category list (free text with suggestions instead), PDF
export, the Monday board import script above, and browsing PAST
licence years — `/cpd` always shows the CURRENT window only (computed
fresh from today's date + the licence-year start month); there is no
year picker yet. A past year's entries still exist in `cpd_entries`
(nothing is deleted), they're just not surfaced in the UI until a
future round adds that view.

## Lead flow (migration 048)

`docs/RESLU-lead-flow-brief.md` + `docs/DESIGNER-NOTES.md`: wires the
designer-built "paper card" client journey into the Site-visit
lifecycle emails machinery above — real, brand-approved
`visit-confirmation.html`/`visit-reminder.html` templates (superseding
the r15 placeholders that shipped with that round) and a new
interactive `project-brief.html` pre-visit questionnaire, all staged
in `emails/`. See `docs/API.md`'s "Lead flow" section for the full
endpoint/mechanics write-up; this section covers on-machine steps only.

**BUILD-SPEC.md note:** this round's task brief also names "BUILD-
SPEC.md section 'Lead flow package'" as a source. No file named
`BUILD-SPEC.md` exists in this working copy — checked before writing
this. `docs/RESLU-lead-flow-brief.md` + `docs/DESIGNER-NOTES.md`'s own
CORRECTIONS section were followed as the sole authoritative brief
instead, flagged here rather than silently deviating.

**On-machine steps:**

1. **Run migration 048** (Step 2 above covers this for a fresh
   install; an existing environment just needs the one new file run).
2. **Add the middleware allowlist line** — `lib/supabase/middleware.ts`
   is protected/out of this round's edit boundary. Without this one
   addition, `/brief/[token]` and `/api/brief-submit/[token]` are
   redirected to `/login` before they ever run (both routes are fully
   built and correct otherwise). Add, alongside the existing
   `/trade`/`/api/trade` lines in `isPublicPath`:
   ```ts
   pathname.startsWith("/brief") ||
   pathname.startsWith("/api/brief-submit") ||
   ```
3. **Nothing else changes for `RESEND_API_KEY`** — same key, same
   verified domain as the existing Site-visit lifecycle emails setup
   above. The one change is the FROM address itself: lead-visit emails
   (both templates, for BOTH lead site visits and project
   client_events) now send as `Aria — RESLU <aria@reslu.com.au>`
   (previously `Phillip — RESLU <visits@reslu.com.au>`) — see
   `.env.local.example`'s Resend section for the full note. Reply-To is
   unchanged (`phillip@reslu.com.au`).

**Reminder cron window:** the existing `vercel.json` cron line for
`/api/visit-emails/run` (see the Site-visit lifecycle emails section
above — unchanged, no edit needed) now drives TWO different reminder
windows inside that one route: LEAD site visits fire ~2 days out
("the Adelaide day two days from today" — the closest whole-day
approximation a once-daily cron can give to the brief's "48 hours
before the visit"), while project client_events keep firing the day
before, exactly as before this round. See `app/api/visit-emails/run/
route.ts`'s own header comment for the full reasoning.

**Everything else is already wired up** once the migration is run and
the middleware line lands: `PATCH /api/leads/[id]` / `POST /api/leads`
attach `invite.ics` + `{{calendar_link}}` to every confirmation send
and bump `visit_ics_sequence` on a genuine reschedule; the reminder
sweep mints each lead's `/brief/[token]` link on first need and
attaches its own `invite.ics`; `POST /api/brief-submit/[token]` stores
the client's answers straight onto the lead record and surfaces a
"Brief submitted — {lead}" item on the Daily Brief; `LeadDetailPanel`
renders the submitted answers read-only; moving a lead to "Lead Lost"
clears its follow-up date and cancels any still-pending reminder.

## Fee proposal phase (migration 051)

`docs/BUILD-SPEC.md` §"Fee proposal phase (r23)" + `docs/proposal-
reference-content.md`: one signable document — proposal + terms merged,
replacing the old LawDepot service contract. Full mechanics in
`docs/API.md`'s "Fee proposal phase" section; this section covers
on-machine steps only.

**On-machine steps:**

1. **Run migration 051** (Step 2 above covers this for a fresh install;
   an existing environment just needs the one new file run). No new
   storage bucket is created — signed proposal PDFs reuse the existing
   private `assets` bucket (009/010).
2. **Add the middleware allowlist lines** — `lib/supabase/middleware.ts`
   is protected/out of this round's edit boundary. Without this
   addition, `/proposal/[token]` (the client-facing document + sign
   page) and `POST /api/proposal/[token]/accept` both redirect to
   `/login`/401 before they ever run (both are fully built and correct
   otherwise). These must be BOUNDARY-AWARE (not a bare `startsWith`) —
   a bare `pathname.startsWith("/proposal")` would also incorrectly
   match the admin-only `/proposals/[id]` editor route, and a bare
   `pathname.startsWith("/api/proposal")` would also match the
   admin-only `/api/proposals` CRUD API. Add, alongside the existing
   `/brief`/`/trade-request` lines in `isPublicPath`:
   ```ts
   pathname === "/proposal" ||
   pathname.startsWith("/proposal/") ||
   pathname.startsWith("/api/proposal/") ||
   ```
3. **Nothing else changes for `RESEND_API_KEY`** — same key, same
   verified domain as the existing Site-visit lifecycle emails setup.
   The "send" email (`emails/proposal-sent.html`) goes out as `Aria —
   RESLU <aria@reslu.com.au>`, reply-to `phillip@reslu.com.au` — same
   sender identity as the lead-flow/trade-booking emails. The signed-
   copy confirmation email (sent to the client + `phillip@reslu.com.au`
   once they sign) uses the same sender/reply-to, inline HTML, no
   template file.
4. **MCP**: `mcp/src/index.mjs` gains two additive tools —
   `get_proposal`/`set_proposal_draft` — no separate install step beyond
   whatever `mcp/README.md` already documents for picking up new tool
   definitions on the Mac mini (the tool list is served live from this
   same file on every `tools/list` call, no build step of its own).

**Everything else is already wired up** once the migration is run and
the middleware lines land: creating a fee proposal from a lead's detail
panel (or a project's Invoices tab — both mount the same
`ProposalsSection`) seeds one of three templates
(`lib/proposal-templates.ts`); the Builder UI at `/proposals/[id]`
(draft-commit-on-blur, matching `LeadDetailPanel`'s own save pattern)
edits letter/vision/scope/fees/timeline/exclusions/terms and shows a
live "Live preview" link to `/proposal/{token}` even before Send;
Send emails the client a branded button link; the client signs on that
same page (draw + type, reusing `components/portal/SignatureCanvas.tsx`);
acceptance is idempotent (double-POST/double-tap safe), stores a signed
`ProposalPdf`, emails both parties a copy, drafts (never auto-sends) a
deposit invoice via the existing client-invoicing machinery, and drops
a dedupe-guarded Daily Brief item; a proposal sent more than 5 days ago
and still not accepted surfaces on My Work (`proposal_followup`) with a
link straight to its editor, where the existing Resend action lives.

## Monday.com and Gmail integrations

Both are optional and dormant until configured — the app works fully
without them.

- **Monday.com**: set `MONDAY_API_TOKEN` in `.env.local` (or the Vercel
  project's environment variables). Then, per project, set a **board ID**
  in that project's Settings page (or the register's inline picker) and
  optionally a **column map** in `projects.settings` — see
  `lib/monday/sync.ts`'s `MondayColumnMap` doc comment for the JSON shape
  and documented example column IDs (`status`, `supplier`, `quantity`,
  `product_url`, `ordered_at`, `eta`). Monday column IDs are board-specific
  and auto-generated by Monday, so there's no universal default — open the
  target board, add/identify the columns you want populated, and copy
  their IDs (Monday's column settings menu → "Column settings" shows the
  ID, or use the Monday API playground) into that JSON.
- **Gmail** (team digest): set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
  `ARIA_GMAIL_REFRESH_TOKEN` (and optionally `GMAIL_TOKEN_URI` if not
  using Google's default). These must be freshly rotated credentials for
  the `aria@reslu.com.au` mailbox — the ones referenced in the original
  planning document are considered compromised. `POST /api/digest/flush`
  sends any pending client-activity digest; as of Week 7 this is wired
  up to Vercel Cron (`vercel.json`, hourly — `0 * * * *`) so it fires
  automatically once deployed, no manual trigger needed. Set
  `CRON_SECRET` (see `.env.local.example`) in Vercel's project
  environment variables so the route can authenticate the scheduled
  call — a signed-in team member can still trigger it manually from a
  browser session too (the route accepts either).

## Leads + Aria (Week 10)

The **Leads** page (`/leads`) is admin-only — Phillip's account should
have `role: admin` in Settings for it to be visible in the sidebar.
Nothing about the leads feature needs a manual Supabase Dashboard step
beyond running migration `014_leads.sql` in Step 2.2 above.

**One-time Monday leads import** — run this once, by hand, on whichever
machine has network access and the right env vars (the Mac mini, once
set up per BUILD-SPEC.md's migration note, or any machine with
`MONDAY_API_TOKEN` + the Supabase values in its shell environment):

```bash
# Dry run first (default) — prints what would be imported, writes nothing:
MONDAY_API_TOKEN=xxx \
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=xxx \
node scripts/import-monday-leads.mjs

# Once the dry-run output looks right, actually import:
DRY_RUN=0 MONDAY_API_TOKEN=xxx \
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=xxx \
node scripts/import-monday-leads.mjs
```

Safe to re-run (upserts on `monday_item_id`) — but once the leads
module is in daily use, don't re-run it against live data without
checking with Phillip first, since it will overwrite native edits with
whatever the Monday board looks like at run time. See the script's own
header comment for the exact group→stage mapping rules.

**Aria's MCP server** (`mcp/`) is a separate Node package, installed
and run on Aria's Mac mini — not part of this app's `npm install`.  See
`mcp/README.md` for the full install/config steps; in short:

```bash
cd mcp
npm install
# set SPEC_URL, ARIA_EMAIL, ARIA_PASSWORD, NEXT_PUBLIC_SUPABASE_URL,
# NEXT_PUBLIC_SUPABASE_ANON_KEY in the environment that launches it
node src/index.mjs
```

`docs/ARIA.md` covers how she authenticates and which endpoints her
lead-monitor/nurturer/site-brief automations should call.

## Deploying to Vercel

1. Push this repository to the private GitHub repo (`reslu-spec-system`)
   — Vercel deploys from GitHub, not from a local folder.
2. In the Vercel dashboard, **Add New → Project**, import the repo. Leave
   the framework preset as Next.js (auto-detected).
3. Under **Settings → Environment Variables**, add every variable from
   `.env.local.example` with real, rotated values (Production environment
   at minimum; add Preview too if you want preview deployments to work
   against the same Supabase project). Include
   `NEXT_PUBLIC_APP_URL=https://<your-domain>` — this is used to build the
   client portal link shown in Settings and in digest emails, so it must
   be the real deployed URL, not `localhost`.
4. `vercel.json` already sets longer function timeouts for the routes that
   need them on Vercel's default (Node.js) runtime:
   - `app/api/projects/[id]/pdf/route.ts` → 60s (PDF generation embeds
     images and can take longer than the 10s default)
   - `app/api/items/[id]/scrape/route.ts` → 30s (fetches an external
     product page)
   - `app/api/projects/[id]/import/route.ts` → 30s (bulk CSV row inserts)
   No changes needed unless a new long-running route is added later.
5. Deploy. On the first visit, sign in with a Supabase Auth account
   created in Step 2's item 5 above (self-signup is disabled by design).
6. **Supabase Pro plan**: confirm the Supabase project is on Pro before
   relying on this in production — the free tier pauses the database after
   7 days of inactivity, which would silently take the live app offline.
7. Storage buckets: confirm both `assets` (private) and `item-images`
   (public) exist in the Supabase project connected to this Vercel
   deployment — both are now created automatically by running the
   migrations (`item-images` since 007, `assets` since
   `009_assets_bucket.sql`, Week 7). If you're on an older working copy
   that already has real data and never got a manually-created `assets`
   bucket, run migration 009 before deploying — item spec-sheet/install-manual
   attachments, project documents, and invoice PDF uploads all depend
   on it and will fail with a clear "Storage: ... bucket not found ...
   run migration 009" error until it exists.
8. Cron: `vercel.json`'s `crons` entry (`POST /api/digest/flush`, hourly)
   is picked up automatically on deploy — no separate setup beyond
   setting `CRON_SECRET` in step 3 above. Confirm it in the Vercel
   dashboard under the project's **Cron Jobs** tab after the first
   deploy.

## Fonts (builder PDF)

The FF&E schedule PDF (`components/pdf/SchedulePdf.tsx`) uses Cormorant
Garamond Light for the cover title, page headers, and item names — this
copy already has `public/fonts/CormorantGaramond.ttf` in place. If that
file is ever missing (e.g. a fresh clone before it's been added back),
the PDF route does **not** fail — it falls back to the built-in
Times-Roman serif automatically. Drop a `CormorantGaramond.ttf` file
into `public/fonts/` to bring the brand font back (or update the
`CORMORANT_PATH` constant near the top of `SchedulePdf.tsx` if you'd
rather use a different filename, e.g. `CormorantGaramond-Light.ttf`).
The print bundle's separator/documents-index pages
(`components/pdf/DocBundlePages.tsx`) register the same font
independently with the identical fallback behaviour.

## PDF print bundle (pdf-lib)

The export dialog's "Include item documents" checkbox (BUILD-SPEC.md
"Export + board batch" item 3) merges the FF&E schedule with each
in-scope item's attached spec sheet/install manual PDFs into ONE
print-ready download, using `pdf-lib` for the byte-level page merge
(`lib/pdf-bundle.ts`). **This dependency was added to `package.json`
in this round but is not yet installed** — the on-machine engineer
needs to run:

```
npm install
```

once (picks up `pdf-lib` from `package.json`; `package-lock.json` was
intentionally left untouched by this round rather than hand-edited —
`npm install` will refresh it correctly on first run). Until that's
done, any request with `?docs=1` (or the dialog's "Include item
documents" checkbox ticked) will fail at the `import { PDFDocument }
from "pdf-lib"` line in `lib/pdf-bundle.ts`; the bare schedule (no
`?docs=1`) is completely unaffected and needs no new install.

`pdf-lib`'s import is confined to server-only files
(`lib/pdf-bundle.ts`, imported only from
`app/api/projects/[id]/pdf/route.ts`) — never reachable from a client
component bundle.

**Bundle size / function timeout caveat:** per-item document fetches
inside the bundle builder are sequential by design (one bad/slow file
must never block or fail the rest of the bundle — same reasoning as
the existing PDF image pre-pass). `vercel.json` (protected, not edited
by this round) already sets the PDF route's `maxDuration: 60`; a
project with an unusually large number of attached PDF documents (many
items, each with a hefty spec sheet PDF) could exceed that budget
purely on download+merge time, since each fetch is a separate signed
Storage read. If that starts happening in practice, the fix is a
one-line bump to `app/api/projects/[id]/pdf/route.ts`'s entry in
`vercel.json`'s `functions.maxDuration` — deliberately not applied
pre-emptively here since `vercel.json` is out of this round's edit
boundary.

## Troubleshooting

- **"Could not load projects" on the dashboard** — double-check the three
  Supabase values in `.env.local` are correct and that you ran both SQL
  files in Step 2.2.
- **Login page keeps reappearing after signing in** — check that the email
  auth provider is enabled in Supabase (Step 2.3).
- **`npm install` fails** — check your internet connection; if it still
  fails, send the exact error text to whoever maintains the app.
- **"Storage: Bucket not found" when attaching a spec sheet / uploading a
  project document or invoice** — migration `009_assets_bucket.sql`
  hasn't been run against this Supabase project yet. Run it (Step 2
  above) and retry; no other change is needed.
- **An item's image shows broken after upgrading to Week 7** — if this
  item's image was uploaded before the Week 7 fix (when the image route
  still wrote into the `assets` bucket), its `selected_image_url` may
  still point at `.../object/public/assets/items/...`. Once `assets` is
  private, that URL 403s. Fix: open the item, re-upload the image (now
  goes to the public `item-images` bucket) — a one-time fix per
  affected item. New uploads and anything the PDF pre-pass has already
  touched are unaffected.
- **Can't find the "Client area" from the project page** — it's a real
  route (`/projects/[id]/client`) but isn't linked from the project tab
  bar yet (`components/projects/ProjectTabs.tsx` is outside this
  feature's file boundary — see BUILD-SPEC.md Week 8B). Navigate there
  directly by URL for now; adding a "Client" tab entry is a one-line
  follow-up whenever that file is next touched.
