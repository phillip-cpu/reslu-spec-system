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
     native e-signature — see `docs/API-portal-additions.md`)
   - `supabase/migrations/013_boards_contacts.sql` (Address Book
     `contacts` table + link-point columns on `cost_lines`/`items`,
     project kanban board tables, Gantt `schedule_phases` table — see
     `docs/API-week9-additions.md`)
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
  `docs/API-portal-additions.md` for the new routes.

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
  `docs/API-week9-additions.md` for the new routes and the drag-drop
  sort scheme.

Client-portal financial gating and the real scraper pipeline (image/RRP
extraction + PDF document detection) were completed in Week 3. Role-based
admin enforcement for financial fields is now in place project-wide
(library, items, settings) as of Week 4.

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
