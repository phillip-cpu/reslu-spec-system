-- ============================================================
-- RESLU Spec System — Insurance required flag (Quick items round,
-- Phillip, 6 July 2026, item 1).
--
-- Replaces the category-heuristic "is this a trade" guess
-- (lib/insurance.ts's old isTradeCategory()/TRADE_CATEGORIES, migration
-- 023 era) with a single explicit column: contacts.insurance_required.
-- Single source of truth going forward — a human ticks "Certificate
-- needed" per contact (components/contacts/ContactsBrowser.tsx) instead
-- of the app guessing from free-text category. This migration's
-- one-time backfill sets the new column to true for exactly the
-- contacts that would have been flagged "missing" under the old
-- heuristic, so behaviour doesn't regress the moment this ships —
-- after that, the column is the only thing that matters; nothing
-- re-derives it from category again.
--
-- File-boundary note: owned entirely by this task. Does not touch any
-- table another concurrent task owns.
-- ============================================================
alter table contacts
  add column if not exists insurance_required boolean not null default false;

comment on column contacts.insurance_required is
  'Quick items round (6 July 2026): explicit "certificate needed" flag, ticked per contact from components/contacts/ContactsBrowser.tsx''s expand panel (PATCH /api/contacts/[id]). Single source of truth for whether lib/insurance.ts''s computeInsuranceStatus() can ever return ''missing'' for this contact — replaces the old category-based TRADE_CATEGORIES/isTradeCategory() heuristic entirely (see this migration''s one-time backfill below, which seeds this column from that exact former heuristic so existing trade contacts keep showing a badge on day one).';

-- ------------------------------------------------------------
-- One-time backfill — set insurance_required = true for every
-- non-deleted contact whose category (case-insensitive, trimmed)
-- matches the trades allow-list that used to live in lib/insurance.ts
-- as the TRADE_CATEGORIES constant. Copied here as literals (not a
-- runtime reference to that file — a SQL migration can't import a TS
-- module) so this one-time seed is reproducible and self-contained.
-- lib/insurance.ts's category heuristic is REMOVED by this same round
-- (see that file's own header comment) — this list now lives only
-- here, as a historical record of what seeded the column, and is not
-- read by application code again.
-- ------------------------------------------------------------
update contacts
set insurance_required = true
where deleted_at is null
  and category is not null
  and lower(trim(category)) in (
    'carpenters',
    'carpentry',
    'electrical',
    'electrician',
    'electricians',
    'plumbing',
    'plumber',
    'plumbers',
    'tiling',
    'tiler',
    'tilers',
    'painting',
    'painter',
    'painters',
    'plastering',
    'plasterer',
    'waterproofing',
    'demolition',
    'carpet & flooring',
    'flooring',
    'cabinetry',
    'cabinet makers',
    'joinery',
    'concreting',
    'bricklaying',
    'roofing',
    'landscaping',
    'glazing',
    'rendering',
    'insulation',
    'hvac',
    'air conditioning',
    'scaffolding',
    'site management',
    'builder',
    'building'
  );

notify pgrst, 'reload schema';
