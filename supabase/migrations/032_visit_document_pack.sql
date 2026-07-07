-- ============================================================
-- RESLU Spec System — Trade booking document pack.
-- BUILD-SPEC.md "Trade booking document pack" item 1: "trade_visits
-- gains document_pack jsonb — stores the CHOICES made in
-- BookVisitPanel's 'Include documents' section at booking time, not a
-- live/derived view."
--
-- Conventions carried over from every prior migration:
--   - idempotent (add column if not exists) so a partial/re-run
--     converges cleanly
--   - no RLS change needed — trade_visits already has its permissive
--     "team_all" policy (016_trade_visits.sql); this is a new column
--     on an existing table, not a new table
--   - no set_updated_at() special-casing needed either — trade_visits'
--     existing trigger already fires on ANY column update, this one
--     included
-- ============================================================

-- document_pack shape (frozen at booking time — see BookVisitPanel.tsx
-- and POST /api/board-tasks/[id]/book-visit's own doc comments for the
-- full "frozen choices vs live revisions" design note):
--
--   {
--     "include_plans": boolean,
--     "schedule_categories": string[] | null,   -- KEY MAY BE ABSENT; see below
--     "include_sow": boolean
--   }
--
-- THREE-STATE schedule_categories (the one wrinkle worth flagging at
-- the schema level, not just in application code — see
-- types/trade-doc-pack.ts's DocumentPackChoices for the fullest
-- statement): the literal BUILD-SPEC.md wording for this item gives
-- exactly these three top-level keys, with no separate
-- "include_schedule" boolean — so Schedule's own on/off state is
-- carried by whether the "schedule_categories" KEY IS PRESENT in the
-- jsonb object at all, not by its value:
--   - key ABSENT           -> Schedule was unticked, nothing offered.
--   - key present, null     -> Schedule ticked, full schedule (no filter).
--   - key present, string[] -> Schedule ticked, filtered to these
--                              upper-cased category prefixes.
-- Every writer/reader in application code (BookVisitPanel.tsx, the
-- trade page, the three tokened proxy routes, the email mention-line
-- helpers in lib/trade-doc-pack.ts) checks presence first (`in` / `!==
-- undefined`), then null-vs-array — never assumes the key exists.
--
-- Column-level null means "no pack was ever configured for this
-- visit" (every visit created before this round, and any created by a
-- caller that never sends `document_pack`) — the trade page's
-- DOCUMENTS section (Phase "Trade booking document pack" item 3)
-- renders nothing at all in that case. BookVisitPanel never writes a
-- non-null document_pack with all three choices simultaneously "off"
-- (its own `anyIncluded` gate omits the whole field when nothing is
-- ticked) — so in practice, a non-null document_pack always has at
-- least one thing to offer.
alter table trade_visits
  add column if not exists document_pack jsonb;

comment on column trade_visits.document_pack is
  'Frozen document-pack choices made in BookVisitPanel at booking time: {include_plans: boolean, schedule_categories?: string[]|null (key absent = Schedule unticked; null = full schedule; array = filtered), include_sow: boolean}. Column null = no pack configured. See lib/trade-doc-pack.ts / types/trade-doc-pack.ts for the shared types + resolution helpers.';

notify pgrst, 'reload schema';
