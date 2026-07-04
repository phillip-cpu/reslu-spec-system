-- ============================================================
-- RESLU Spec System — Dev seed data
-- Categories per BUILD-SPEC.md §3 (Goldsworthy codes are canonical,
-- plus non-conflicting extras from the RESLU Layout Style Guide).
-- Plus a Goldsworthy demo project for local development.
-- ============================================================

-- ------------------------------------------------------------
-- Categories (21 total)
-- ------------------------------------------------------------
insert into categories (prefix, name, sort_order) values
  ('FA', 'Furniture & Accessories', 10),
  ('SW', 'Sanitaryware',            20),
  ('LA', 'Laminate',                30),
  ('LI', 'Lighting',                40),
  ('EL', 'Electrical',              50),
  ('MH', 'Mechanical',              60),
  ('TL', 'Tiles',                   70),
  ('TW', 'Tapware & Accessories',   80),
  ('HD', 'Cabinet Hardware',        90),
  ('ST', 'Stone',                  100),
  ('CP', 'Carpet',                 110),
  ('PF', 'Paint',                  120),
  ('DR', 'Doors',                  130),
  ('CF', 'Cabinet Furniture',      140),
  ('TB', 'Timber',                 150),
  ('AP', 'Appliances',             160),
  ('PR', 'Profile',                170),
  ('GF', 'Glass Finish',           180),
  ('MF', 'Metal Finish',           190),
  ('DE', 'Decor',                  200),
  ('FC', 'Feature Coatings',       210)
on conflict (prefix) do nothing;

-- ------------------------------------------------------------
-- Goldsworthy demo project
-- ------------------------------------------------------------
insert into projects (id, name, client_name, address, status, budget)
values (
  '00000000-0000-0000-0000-000000000001',
  'Goldsworthy',
  'Goldsworthy',
  '12 Goldsworthy Road, Adelaide SA 5000',
  'active',
  250000.00
)
on conflict (id) do nothing;

-- A handful of representative demo items across a few categories,
-- reflecting real field names found in the Goldsworthy FF&E export
-- (Review §1C). item_code is left blank so the DB trigger assigns it.
insert into items (
  project_id, category, name, description, supplier, supplier_email, brand,
  quantity, unit, location, application_note, colour, material, finish,
  width_mm, height_mm, length_mm, depth_mm, status, price_rrp, price_trade,
  markup_pct
) values
  (
    '00000000-0000-0000-0000-000000000001', 'TW', 'Yabby Tapware Mixer', 'Wall mixer, matte black',
    'Yabby Tapware', 'orders@yabbytapware.com.au', 'Yabby',
    2, 'ea', 'Ensuite', null, 'Matte Black', 'Brass', 'Matte',
    50, 200, null, 50, 'Specced', 420.00, 260.00, 65
  ),
  (
    '00000000-0000-0000-0000-000000000001', 'SW', 'Undermount Basin', 'Rectangular undermount basin',
    'Reece', 'trade@reece.com.au', 'Caroma',
    1, 'ea', 'Powder Room', 'POWDER ROOM', 'White', 'Vitreous China', 'Gloss',
    450, 150, 350, null, 'Specced', 380.00, 240.00, 60
  ),
  (
    '00000000-0000-0000-0000-000000000001', 'LI', 'Wall Light', 'Exterior-rated wall light',
    'Beacon Lighting', 'trade@beaconlighting.com.au', 'Beacon',
    4, 'ea', 'Facade', null, 'Black', 'Aluminium', 'Powdercoat',
    120, 250, null, 120, 'Quoted', 145.00, 95.00, 55
  ),
  (
    '00000000-0000-0000-0000-000000000001', 'HD', 'Cabinet Hinge', 'Soft-close concealed hinge',
    'Hafele', 'orders@hafele.com.au', 'Hafele',
    48, 'ea', null, 'ALL JOINERY HINGES', null, 'Steel', 'Nickel Plated',
    null, null, null, null, 'Ordered', 8.50, 4.90, 70
  ),
  (
    '00000000-0000-0000-0000-000000000001', 'PF', 'Feature Wall Paint', 'Low-sheen interior acrylic',
    'Dulux', 'trade@dulux.com.au', 'Dulux',
    1, 'ea', 'Living Room', null, 'Natural White', null, 'Low Sheen',
    null, null, null, null, 'Specced', 89.00, 62.00, 45
  )
on conflict do nothing;
