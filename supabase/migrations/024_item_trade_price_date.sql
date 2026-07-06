-- ============================================================
-- 024: items.trade_price_received_at — parity with library_items
-- (004 added it to library_items only). Needed by the
-- update_item_pricing MCP tool (Aria records quoted trade prices
-- with provenance) and the trade-price staleness hint.
-- Idempotent.
-- ============================================================
alter table items
  add column if not exists trade_price_received_at date;
