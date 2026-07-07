-- ============================================================
-- RESLU Spec System — master estimate template seed
-- Generated from docs/estimate-template-seed.json by a one-off
-- python script (see BUILD prompt) — do not hand-edit the VALUES
-- blocks below; regenerate from the JSON if the template changes.
-- Source: 'RESLU Standard Estimate' — 22 sections, 178 lines.
--
-- Idempotent: safe to re-run. Uses a DO block with an explicit
-- existence check on estimate_templates.name + is_default,
-- since estimate_templates has no natural unique key on name
-- (per 007_estimating.sql, only is_default is uniquely
-- constrained, and only while true).
-- ============================================================

do $$
declare
  v_template_id uuid;
  v_section_id  uuid;
begin
  if exists (select 1 from estimate_templates where is_default = true) then
    raise notice 'A default estimate template already exists — skipping seed.';
    return;
  end if;

  insert into estimate_templates (name, is_default)
  values ('RESLU Standard Estimate', true)
  returning id into v_template_id;

  -- ---- Section 1: Preliminaries & Site ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Preliminaries & Site', 1)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Site establishment & temporary fencing', null, 1),
    (v_section_id, 'Scaffolding', null, 2),
    (v_section_id, 'Site amenities (toilet, skip bins)', null, 3),
    (v_section_id, 'Waste removal & general clean during construction', null, 4),
    (v_section_id, 'Council / DA / permit fees', null, 5),
    (v_section_id, 'Surveyor / building inspector fees', null, 6),
    (v_section_id, 'Structural engineer', null, 7),
    (v_section_id, 'Hydraulic engineer', null, 8),
    (v_section_id, 'Building permit application', null, 9),
    (v_section_id, 'Site manager / project management', null, 10);

  -- ---- Section 2: Demolition ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Demolition', 2)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Internal wall removal', null, 1),
    (v_section_id, 'Floor covering removal', null, 2),
    (v_section_id, 'Tile removal', null, 3),
    (v_section_id, 'Fixture & fitting removal (kitchen, bathroom)', null, 4),
    (v_section_id, 'Door & window removal', null, 5),
    (v_section_id, 'Ceiling removal / alterations', null, 6),
    (v_section_id, 'Disposal of demolition waste', null, 7);

  -- ---- Section 3: Earthworks / Footings ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Earthworks / Footings', 3)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Site cut & fill', null, 1),
    (v_section_id, 'Excavation', null, 2),
    (v_section_id, 'Footings / slab concrete', null, 3),
    (v_section_id, 'Retaining walls', null, 4),
    (v_section_id, 'Drainage alterations', null, 5);

  -- ---- Section 4: Framing / Carpentry ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Framing / Carpentry', 4)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'New partition walls — framing', null, 1),
    (v_section_id, 'Ceiling framing alterations', null, 2),
    (v_section_id, 'Door frames & lining', null, 3),
    (v_section_id, 'Window frames', null, 4),
    (v_section_id, 'Skirting boards', null, 5),
    (v_section_id, 'Architraves', null, 6),
    (v_section_id, 'Bulkheads / soffits', null, 7),
    (v_section_id, 'Structural beams (if applicable)', null, 8),
    (v_section_id, 'Decking / external timber', null, 9);

  -- ---- Section 5: Roofing ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Roofing', 5)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Roof tiling / sheeting — repairs & alterations', null, 1),
    (v_section_id, 'New roof sheeting / tiles — supply & install', null, 2),
    (v_section_id, 'Fascia & barge boards', null, 3),
    (v_section_id, 'Gutters & downpipes — supply & install', null, 4),
    (v_section_id, 'Flashings & penetrations', null, 5),
    (v_section_id, 'Sarking / insulation blanket', null, 6),
    (v_section_id, 'Roof plumbing certification', null, 7);

  -- ---- Section 6: Bricklaying & Masonry ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Bricklaying & Masonry', 6)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'New brickwork — walls', null, 1),
    (v_section_id, 'Brick infill / openings', null, 2),
    (v_section_id, 'Blockwork — structural', null, 3),
    (v_section_id, 'Brick cleaning & acid wash', null, 4),
    (v_section_id, 'Lintels — supply & install', null, 5),
    (v_section_id, 'Repointing / repairs to existing', null, 6),
    (v_section_id, 'Rendered masonry piers / fences', null, 7);

  -- ---- Section 7: Plasterboard & Render ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Plasterboard & Render', 7)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'New partition plasterboard — supply & fix', null, 1),
    (v_section_id, 'Plasterboard to ceilings', null, 2),
    (v_section_id, 'Wet area plasterboard (Wetcheck)', null, 3),
    (v_section_id, 'Cornice supply & install', null, 4),
    (v_section_id, 'Set & sand — walls', null, 5),
    (v_section_id, 'Set & sand — ceilings', null, 6),
    (v_section_id, 'Decorative feature panels / wall treatment', null, 7),
    (v_section_id, 'Patching — existing walls & ceilings', null, 8);

  -- ---- Section 8: Waterproofing ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Waterproofing', 8)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    -- Screed beds precede the membranes (falls formed in the bed) —
    -- added per Phillip 7 Jul: was missing from the Excel template too.
    (v_section_id, 'Wet area screed beds / subfloor prep — falls to waste', null, 1),
    (v_section_id, 'Bathroom floor & shower — waterproofing membrane', null, 2),
    (v_section_id, 'Ensuite floor & shower — waterproofing membrane', null, 3),
    (v_section_id, 'Laundry — waterproofing membrane', null, 4),
    (v_section_id, 'Balcony / wet area waterproofing', null, 5),
    (v_section_id, 'Independent waterproofing inspection & certificate', null, 6);

  -- ---- Section 9: Tiling ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Tiling', 9)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Bathroom — floor tiles', null, 1),
    (v_section_id, 'Bathroom — wall tiles', null, 2),
    (v_section_id, 'Bathroom — shower tiles', null, 3),
    (v_section_id, 'Ensuite — floor tiles', null, 4),
    (v_section_id, 'Ensuite — wall tiles', null, 5),
    (v_section_id, 'Ensuite — shower tiles', null, 6),
    (v_section_id, 'Laundry — floor tiles', null, 7),
    (v_section_id, 'Laundry — wall tiles', null, 8),
    (v_section_id, 'Kitchen — splashback tiles', null, 9),
    (v_section_id, 'Entry / living — floor tiles', null, 10),
    (v_section_id, 'Grout — supply & apply', null, 11),
    (v_section_id, 'Tile trim / edge profiles', null, 12),
    (v_section_id, 'Silicone — all wet area junctions', null, 13),
    (v_section_id, 'Tile adhesive & bed preparation', null, 14),
    (v_section_id, 'Tile supply (if via RESLU)', null, 15),
    (v_section_id, 'Independent tiling inspection & certificate', null, 16);

  -- ---- Section 10: Plumbing ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Plumbing', 10)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Bathroom — rough-in (relocate / extend services)', null, 1),
    (v_section_id, 'Ensuite — rough-in (relocate / extend services)', null, 2),
    (v_section_id, 'Laundry — rough-in (relocate / extend services)', null, 3),
    (v_section_id, 'Kitchen — rough-in (relocate / extend services)', null, 4),
    (v_section_id, 'Hot water system supply & install', null, 5),
    (v_section_id, 'Tapware supply & install — bathroom', null, 6),
    (v_section_id, 'Tapware supply & install — ensuite', null, 7),
    (v_section_id, 'Tapware supply & install — kitchen', null, 8),
    (v_section_id, 'Basin / vanity — supply & connect', null, 9),
    (v_section_id, 'Bath — supply & connect', null, 10),
    (v_section_id, 'Toilet suite — supply & connect', null, 11),
    (v_section_id, 'Shower rose / rail — supply & install', null, 12),
    (v_section_id, 'Laundry trough & mixer — supply & connect', null, 13),
    (v_section_id, 'Dishwasher connection', null, 14),
    (v_section_id, 'Drainage alterations / stormwater', null, 15),
    (v_section_id, 'Gas rough-in & final connections', null, 16);

  -- ---- Section 11: Electrical ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Electrical', 11)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Switchboard upgrade / alterations', null, 1),
    (v_section_id, 'New circuits — lighting', null, 2),
    (v_section_id, 'New circuits — power / GPOs', null, 3),
    (v_section_id, 'New circuits — appliances (oven, dishwasher, AC)', null, 4),
    (v_section_id, 'Downlight supply & install', null, 5),
    (v_section_id, 'Feature / pendant lighting — supply & install', null, 6),
    (v_section_id, 'Exhaust fans — supply & install', null, 7),
    (v_section_id, 'Bathroom heating — supply & install', null, 8),
    (v_section_id, 'External / sensor lighting', null, 9),
    (v_section_id, 'Data / NBN points', null, 10),
    (v_section_id, 'TV points', null, 11),
    (v_section_id, 'USB GPOs — supply & install', null, 12),
    (v_section_id, 'Smart home / dimmer switches', null, 13),
    (v_section_id, 'Air conditioning supply & install', null, 14),
    (v_section_id, 'Certificate of electrical compliance', null, 15);

  -- ---- Section 12: Joinery / Cabinetry ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Joinery / Cabinetry', 12)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Kitchen cabinetry — supply & install', null, 1),
    (v_section_id, 'Kitchen island — supply & install', null, 2),
    (v_section_id, 'Bathroom vanity — supply & install', null, 3),
    (v_section_id, 'Ensuite vanity — supply & install', null, 4),
    (v_section_id, 'Laundry cabinetry — supply & install', null, 5),
    (v_section_id, 'Wardrobe / robes — supply & install', null, 6),
    (v_section_id, 'Linen press / storage — supply & install', null, 7),
    (v_section_id, 'Pantry joinery', null, 8),
    (v_section_id, 'Feature shelving / built-ins', null, 9),
    (v_section_id, 'Hardware — handles, hinges (supply only)', null, 10),
    (v_section_id, 'Joinery delivery & installation allowance', null, 11);

  -- ---- Section 13: Stone & Benchtops ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Stone & Benchtops', 13)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Kitchen benchtop — supply & install', null, 1),
    (v_section_id, 'Island benchtop — supply & install', null, 2),
    (v_section_id, 'Bathroom vanity top — supply & install', null, 3),
    (v_section_id, 'Ensuite vanity top — supply & install', null, 4),
    (v_section_id, 'Laundry benchtop — supply & install', null, 5),
    (v_section_id, 'Splashback — stone', null, 6),
    (v_section_id, 'Stone templating & fabrication', null, 7),
    (v_section_id, 'Stone delivery & crane / lift allowance', null, 8);

  -- ---- Section 14: Painting & Decorative Finishes ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Painting & Decorative Finishes', 14)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Internal walls — 2 coats (all areas)', null, 1),
    (v_section_id, 'Ceilings — 2 coats', null, 2),
    (v_section_id, 'Doors & frames — paint', null, 3),
    (v_section_id, 'Skirtings & architraves — paint', null, 4),
    (v_section_id, 'Feature wall — decorative finish / limewash', null, 5),
    (v_section_id, 'External — touch-up / repaint', null, 6),
    (v_section_id, 'Primer & prep — all surfaces', null, 7);

  -- ---- Section 15: Floor Coverings ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Floor Coverings', 15)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Engineered timber — supply & install', null, 1),
    (v_section_id, 'Carpet — supply & install', null, 2),
    (v_section_id, 'Vinyl / LVT — supply & install', null, 3),
    (v_section_id, 'Concrete polishing / grinding', null, 4),
    (v_section_id, 'Underlay', null, 5),
    (v_section_id, 'Floor levelling / screed', null, 6),
    (v_section_id, 'Transitions & threshold strips', null, 7);

  -- ---- Section 16: Glazing, Shower Screens & Mirrors ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Glazing, Shower Screens & Mirrors', 16)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Shower screen — bathroom — supply & install', null, 1),
    (v_section_id, 'Shower screen — ensuite — supply & install', null, 2),
    (v_section_id, 'Mirrors — supply & install', null, 3),
    (v_section_id, 'Frameless glass splashback', null, 4),
    (v_section_id, 'New windows — supply & install', null, 5),
    (v_section_id, 'Skylights — supply & install', null, 6);

  -- ---- Section 17: Appliances ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Appliances', 17)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Oven — supply & install', null, 1),
    (v_section_id, 'Cooktop — supply & install', null, 2),
    (v_section_id, 'Rangehood — supply & install', null, 3),
    (v_section_id, 'Dishwasher — supply & install', null, 4),
    (v_section_id, 'Refrigerator — supply', null, 5),
    (v_section_id, 'Washing machine — supply', null, 6),
    (v_section_id, 'Dryer — supply', null, 7),
    (v_section_id, 'Microwave — supply & install', null, 8);

  -- ---- Section 18: Window Furnishings ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Window Furnishings', 18)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Blinds / roller blinds — supply & install', null, 1),
    (v_section_id, 'Curtains — supply & install', null, 2),
    (v_section_id, 'Curtain tracks / rods — supply & install', null, 3),
    (v_section_id, 'Privacy film — bathroom / ensuite', null, 4),
    (v_section_id, 'Rugs — supply (allowance)', null, 5);

  -- ---- Section 19: External & Landscaping ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'External & Landscaping', 19)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Driveway / crossover works', null, 1),
    (v_section_id, 'Paving — supply & lay', null, 2),
    (v_section_id, 'Fencing — supply & install', null, 3),
    (v_section_id, 'Gate — supply & install', null, 4),
    (v_section_id, 'Garden / landscaping (allowance)', null, 5),
    (v_section_id, 'External lighting', null, 6);

  -- ---- Section 20: Handover & Completion ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Handover & Completion', 20)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Final clean — professional', null, 1),
    (v_section_id, 'Touch-ups — paint & plaster', null, 2),
    (v_section_id, 'Defects inspection & rectification', null, 3),
    (v_section_id, 'Warranties & compliance documents compilation', null, 4),
    (v_section_id, 'Keys, manuals, handover pack', null, 5),
    (v_section_id, 'Occupation certificate (if applicable)', null, 6);

  -- ---- Section 21: Contingency ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Contingency', 21)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Contingency allowance — unforeseen works', null, 1),
    (v_section_id, 'Provisional sum — unknown existing conditions', null, 2),
    (v_section_id, 'Approved variations (refer Variations Register)', null, 3);

  -- ---- Section 22: Miscellaneous ----
  insert into estimate_template_sections (template_id, name, sort)
  values (v_template_id, 'Miscellaneous', 22)
  returning id into v_section_id;

  insert into estimate_template_lines (section_id, description, unit, sort)
  values
    (v_section_id, 'Furniture / FF&E (allowance)', null, 1),
    (v_section_id, 'Decorative accessories (allowance)', null, 2),
    (v_section_id, 'Delivery charges', null, 3),
    (v_section_id, 'Crane / lift hire', null, 4),
    (v_section_id, 'Storage costs (client materials)', null, 5),
    (v_section_id, 'Other — specify in notes', null, 6);

end $$;
