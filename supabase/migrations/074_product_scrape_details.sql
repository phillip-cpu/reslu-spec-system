-- Structured product specifications captured from supplier product pages.
-- These stay separate from the editable description so scraper refreshes
-- cannot overwrite project-specific notes written by the team.
alter table items
  add column if not exists product_details jsonb not null default '[]'::jsonb;

comment on column items.product_details is
  'Supplier product specifications captured by the product-page scraper as [{label,value}].';
