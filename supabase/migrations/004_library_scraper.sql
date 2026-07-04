-- ============================================================
-- RESLU Spec System — Library trade price + scraper extension
-- BUILD-SPEC.md §"Scraper extension — document detection" and
-- §"Library — trade price capture & duplicate detection"
-- (both added 4 July 2026).
--
-- Filename note: the build task referred to this as
-- "002_library_scraper.sql", but 002 (grants) and 003 (profiles
-- provisioning) already exist in this working copy. Numbered 004 here
-- to avoid a filename collision / ambiguous apply order — content and
-- intent are unchanged from spec.
--
-- Note: `library_items.price_trade` and `items.price_trade` already
-- exist in 001_initial.sql — this migration does NOT re-add them.
-- It adds: trade-price provenance columns on library_items, URL
-- normalisation columns for duplicate detection on both items and
-- library_items, and a scraped_documents column on items to hold
-- detected-but-not-yet-attached PDF links from the product scrape.
--
-- Idempotent: every statement is guarded so this can be re-run safely.
-- ============================================================

-- ------------------------------------------------------------
-- library_items: trade price provenance
-- (price_trade itself already exists — see 001_initial.sql)
-- ------------------------------------------------------------
alter table library_items
  add column if not exists trade_price_received_at date,
  add column if not exists trade_price_source text;

-- ------------------------------------------------------------
-- Duplicate detection: normalised product URL, both tables.
-- Populated by the app layer via lib/scraper/normalize.ts
-- (normalizeProductUrl) whenever product_url is set/changed —
-- lowercase host, strip "www.", strip query/fragment/trailing slash.
-- ------------------------------------------------------------
alter table library_items
  add column if not exists product_url_normalized text;

alter table items
  add column if not exists product_url_normalized text;

create index if not exists idx_library_items_product_url_normalized
  on library_items(product_url_normalized);

create index if not exists idx_items_product_url_normalized
  on items(product_url_normalized);

-- ------------------------------------------------------------
-- items.scraped_documents: PDFs detected on the product page during
-- scrape (spec sheets, install manuals, etc.) that have not yet been
-- attached as a real item_files row. Each entry:
--   { url: string, guessedKind: 'spec_sheet'|'install_manual'|'other',
--     label: string }
-- Cleared/pruned by the app when a document is attached (moved into
-- item_files + Supabase Storage) — this column is a staging area only,
-- never the source of truth for attached documents.
-- ------------------------------------------------------------
alter table items
  add column if not exists scraped_documents jsonb not null default '[]';
