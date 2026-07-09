-- ============================================================
-- RESLU Spec System — Trade-scoped SOW extracts.
-- BUILD-SPEC.md "Trade-scoped SOW extracts": "Migration 044:
-- sow_lines.trade text null (single tag; trade names = the
-- trade-mapping presets' names — one vocabulary everywhere)."
--
-- Single-column addition, nothing else — no new table, no RLS change
-- (sow_lines already has its permissive "team_all" policy from
-- 019_versions_sow_analysis.sql; a new nullable column on an existing
-- table doesn't need a new policy), no new trigger (sow_lines'
-- existing set_updated_at() trigger already fires on ANY column
-- update, this one included).
--
-- `trade` is free text, not a foreign key / enum constrained to
-- app_settings('export_presets') — presets are studio-editable
-- config, not a lookup table, so a hard constraint here would break
-- the moment a preset is renamed/removed with existing tagged lines
-- still pointing at the old name. Every reader (lib/sow-trade-tags.ts,
-- the builder, the extract PDF routes) matches `trade` against the
-- CURRENT preset name list at read time instead — a line tagged with
-- a since-deleted preset name simply stops matching any of today's
-- trade chips (it doesn't error, and it doesn't silently show up
-- under a different trade either), same "resolve live, don't enforce
-- referentially" spirit as export_presets.contact_categories.
--
-- null = untagged (the common case for a freshly-added or
-- freshly-templated line before "Suggest trade tags" or manual
-- tagging runs) — extracts omit untagged lines entirely (see
-- lib/sow-trade-tags.ts's filterSectionsForTrade()).
--
-- Idempotent (add column if not exists) so a partial/re-run converges
-- cleanly, matching every prior migration's convention.
-- ============================================================
alter table sow_lines
  add column if not exists trade text;

comment on column sow_lines.trade is
  'Single trade tag, free text — matches an app_settings(export_presets) preset NAME (case-sensitive exact match at write time via lib/sow-trade-tags.ts''s suggestTradeTag(), case-insensitive at suggestion time only) when set by a team member or the auto-suggest heuristic. null = untagged; untagged lines are omitted from trade-scoped SOW extracts. Not a foreign key — presets are editable studio config, not a lookup table.';

notify pgrst, 'reload schema';
