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
   dashboard and run the three files in this order:
   - `supabase/migrations/001_initial.sql` (creates all tables)
   - `supabase/migrations/002_grants.sql` (grants the app's database
     roles access to those tables — without this, every screen shows
     "permission denied for table …")
   - `supabase/migrations/003_profiles_provisioning.sql` (auto-creates a
     profile for each team member — without this, adding items fails
     with a foreign-key error)
   - `supabase/seed.sql` (adds the 21 category codes and a demo project)

3. Go to **Authentication → Providers** and make sure **Email** is enabled.
   Go to **Authentication → Settings** and turn **off** "Allow new users to
   sign up" — accounts for this app are created manually by an administrator,
   not via self sign-up.

4. Create a login for yourself: **Authentication → Users → Add user**, enter
   an email and a password. Repeat for each team member (Phillip, Tenille,
   Nathan, Tony).

5. Go to **Settings → API** in the Supabase dashboard. You'll need three
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
   from Step 2.5 above. Leave the Monday.com and Gmail values blank for now —
   they aren't used until later weeks, and the tokens mentioned in the
   original planning document must be rotated (replaced with new ones)
   before they're used anywhere, since they were exposed in a shared file.
3. Save the file. **Never share this file or commit it to git** — it holds
   real credentials once filled in.

## Step 4 — Run the app locally

```
npm run dev
```

Then open http://localhost:3000 in your browser. You should be redirected to
a login page. Sign in with one of the accounts you created in Step 2.4.

To stop the app, go back to Terminal and press `Ctrl + C`.

## What's built so far (Week 1 + Week 2)

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

Client-portal financial gating, the real scraper pipeline (image/RRP
extraction + PDF document detection), and role-based admin enforcement for
financial fields follow in later weeks per BUILD-SPEC.md.

## Troubleshooting

- **"Could not load projects" on the dashboard** — double-check the three
  Supabase values in `.env.local` are correct and that you ran both SQL
  files in Step 2.2.
- **Login page keeps reappearing after signing in** — check that the email
  auth provider is enabled in Supabase (Step 2.3).
- **`npm install` fails** — check your internet connection; if it still
  fails, send the exact error text to whoever maintains the app.
