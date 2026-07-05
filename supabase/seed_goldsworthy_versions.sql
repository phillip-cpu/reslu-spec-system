-- ============================================================
-- RESLU Spec System — Goldsworthy estimate version history seed
-- BUILD-SPEC.md "12a seed enrichment (from QUOTING-HISTORY.md)":
-- "Goldsworthy estimate versions seeded from real history — V1 Cost
-- Plan (20 May, budget allowances + confirmed quotes incl. Zamp
-- plumbing $9,620, Yabby set $3,574.12, Demor sanitaryware), V2 Cost
-- Estimate (26 May), V3 backup snapshot (22 Jun, trade totals per
-- handoff: trades $89,394 / markup 30% / $127,834 inc GST). Status
-- flags Y/Q/P map to quote_status Q/S equivalents. Supplier quote refs
-- (Demor Q-10718, Verandah Trade D11092) -> cost line notes."
--
-- Source: docs/QUOTING-HISTORY.md (compiled by Aria Vale, 5 July 2026).
--
-- Keyed on (project via name 'Goldsworthy', label) — NOT the demo
-- project's hardcoded seed uuid (supabase/seed.sql inserts it as
-- '00000000-0000-0000-0000-000000000001', but this file is meant to
-- run against whichever real project is actually named 'Goldsworthy'
-- in a given environment, per this feature's explicit instruction).
-- Idempotent: each INSERT is guarded by a NOT EXISTS against
-- estimate_versions(project_id, label) — the unique index on that pair
-- (migration 019_versions_sow_analysis.sql) would also reject a
-- duplicate, but the NOT EXISTS guard avoids a noisy constraint-
-- violation error on re-run and keeps this script a clean no-op the
-- second time.
--
-- Every snapshot here is a MINIMAL, schema-valid EstimateSnapshot
-- (types/phase-12a-a.ts) — sections/lines shaped like
-- CostSectionWithLines/CostLine (types/index.ts), with rollups
-- computed by hand to match lib/estimate.ts's own rounding rules
-- (roundMoney: round-half-up to 2dp), since this is static historical
-- seed data, not a live Supabase query result. Each line object below
-- carries only the fields the read-only version viewer
-- (components/estimate/VersionsPanel.tsx VersionSnapshotView) and the
-- VM comparison diff (lib/estimate-versions.ts) actually read
-- (description, qty, unit, rate_ex_gst, cost_ex_gst,
-- quoted_to_client_ex_gst, actual_paid_ex_gst, quote_status, notes) —
-- CostLine's remaining columns (created_at, updated_at, deleted_at,
-- measurement_id, wastage_pct, contact_id) are intentionally omitted
-- from this jsonb (harmless: jsonb has no schema to violate, and
-- nothing in this feature ever reads those fields off a frozen
-- snapshot — a version is display-only, never re-hydrated back into
-- live cost_lines rows). FF&E rollup is left empty ({categories: [],
-- total: 0, ...}) for V1/V2 (the cost-plan-stage snapshots predate any
-- meaningful FF&E-from-schedule figure) and likewise for V3 (the trade
-- totals given are construction-only per the handoff table; no FF&E
-- total was supplied in QUOTING-HISTORY.md, so it is not fabricated
-- here) — wholeJob.combinedExGst/combinedIncGst therefore equal the
-- trades rollup alone for all three versions.
-- ============================================================

do $$
declare
  v_project_id uuid;
begin
  select id into v_project_id from projects where name = 'Goldsworthy' limit 1;

  if v_project_id is null then
    raise notice 'seed_goldsworthy_versions: no project named ''Goldsworthy'' found — skipping.';
    return;
  end if;

  -- ------------------------------------------------------------
  -- V1 — Cost Plan (20 May 2026)
  -- "Early-stage cost plan covering all trade categories. Status
  -- flags: Y = Confirmed, Q = Quoted, P = Pending. Most items still at
  -- P (pending) — budget allowances only at this stage." Confirmed
  -- items mapped to quote_status 'Q' (quote received) per the build
  -- spec's "Y/Q/P map to quote_status Q/S equivalents" — a Y
  -- (Confirmed) or Q (Quoted) source flag both land as cost_lines'
  -- 'Q' status here (a received/confirmed quote); nothing in this
  -- snapshot uses 'S' (sent, waiting) since QUOTING-HISTORY.md's V1
  -- section only lists confirmed figures, not pending ones, in detail.
  -- ------------------------------------------------------------
  if not exists (select 1 from estimate_versions where project_id = v_project_id and label = 'V1') then
    insert into estimate_versions (project_id, label, kind, note, snapshot)
    values (
      v_project_id,
      'V1',
      'issue',
      'Cost Plan — 20 May 2026 (260520_GOLDSWORTHY_COST_PLAN.xlsx). Early-stage budget allowances; most line items still pending (P) at this stage — only confirmed/quoted items are itemised below. See docs/QUOTING-HISTORY.md.',
      jsonb_build_object(
        'markup_pct', 0.30,
        'sow_revision_label', null,
        'measurements', '[]'::jsonb,
        'ffe', jsonb_build_object(
          'categories', '[]'::jsonb, 'total', 0, 'quoted_total', 0, 'placeholder_total', 0,
          'item_count', 0, 'quoted_count', 0, 'placeholder_count', 0, 'unpriced_count', 0,
          'quoted_share', 0, 'placeholder_share', 0
        ),
        'sections', jsonb_build_array(
          jsonb_build_object(
            'id', '10000000-0000-0000-0000-000000000101',
            'name', 'Demolition',
            'sort', 1,
            'rollup', jsonb_build_object('costExGst', 10000.00, 'quotedExGst', 0, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000102', 'section_id', '10000000-0000-0000-0000-000000000101',
                'description', 'Demo Labour — budget allowance', 'qty', 1, 'unit', 'LOT',
                'rate_ex_gst', 10000.00, 'cost_ex_gst', 10000.00, 'quoted_to_client_ex_gst', null,
                'actual_paid_ex_gst', null, 'quote_status', 'NA', 'notes', 'Budget allowance at Cost Plan stage.'
              )
            )
          ),
          jsonb_build_object(
            'id', '10000000-0000-0000-0000-000000000201',
            'name', 'Plumbing',
            'sort', 2,
            'rollup', jsonb_build_object('costExGst', 16564.12, 'quotedExGst', 16564.12, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000202', 'section_id', '10000000-0000-0000-0000-000000000201',
                'description', 'Plumbing Labour', 'qty', 1, 'unit', 'LOT',
                'rate_ex_gst', 9620.00, 'cost_ex_gst', 9620.00, 'quoted_to_client_ex_gst', 9620.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q',
                'notes', 'Zamp Plumbing (Andrew) — quoted 26/05/26. Accepted.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000203', 'section_id', '10000000-0000-0000-0000-000000000201',
                'description', 'Yabby Tapware Set (TW-01–12)', 'qty', 1, 'unit', 'SET',
                'rate_ex_gst', 3574.12, 'cost_ex_gst', 3574.12, 'quoted_to_client_ex_gst', 3574.12,
                'actual_paid_ex_gst', null, 'quote_status', 'Q',
                'notes', 'Verandah Trade D11092. Accepted.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000204', 'section_id', '10000000-0000-0000-0000-000000000201',
                'description', 'Caroma Contura II Basin (SW-01)', 'qty', 1, 'unit', 'EA',
                'rate_ex_gst', 510.00, 'cost_ex_gst', 510.00, 'quoted_to_client_ex_gst', 510.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q',
                'notes', 'Demor Q-10718.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000205', 'section_id', '10000000-0000-0000-0000-000000000201',
                'description', 'Caroma Urbane II Toilets (SW-02) x2', 'qty', 2, 'unit', 'EA',
                'rate_ex_gst', 1050.00, 'cost_ex_gst', 2100.00, 'quoted_to_client_ex_gst', 2100.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q',
                'notes', 'Demor Q-10718.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000206', 'section_id', '10000000-0000-0000-0000-000000000201',
                'description', 'Caroma Invisi II Cistern Buttons (SW-02a) x2', 'qty', 2, 'unit', 'EA',
                'rate_ex_gst', 380.00, 'cost_ex_gst', 760.00, 'quoted_to_client_ex_gst', 760.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q',
                'notes', 'Demor Q-10718.'
              )
            )
          )
        )
      ) || jsonb_build_object(
        'rollup', jsonb_build_object(
          'allTradesSubtotalExGst', 26564.12,
          'approvedVariationsExGst', 0,
          'markupPct', 0.30,
          'markupExGst', 7969.24,
          'totalToClientExGst', 34533.36,
          'gst', 3453.34,
          'totalIncGst', 37986.70,
          'quotedExGst', 16564.12,
          'actualExGst', 0
        ),
        'wholeJob', jsonb_build_object(
          'trades', jsonb_build_object(
            'allTradesSubtotalExGst', 26564.12, 'approvedVariationsExGst', 0, 'markupPct', 0.30,
            'markupExGst', 7969.24, 'totalToClientExGst', 34533.36, 'gst', 3453.34,
            'totalIncGst', 37986.70, 'quotedExGst', 16564.12, 'actualExGst', 0
          ),
          'ffe', jsonb_build_object(
            'categories', '[]'::jsonb, 'total', 0, 'quoted_total', 0, 'placeholder_total', 0,
            'item_count', 0, 'quoted_count', 0, 'placeholder_count', 0, 'unpriced_count', 0,
            'quoted_share', 0, 'placeholder_share', 0
          ),
          'combinedExGst', 34533.36,
          'combinedGst', 3453.34,
          'combinedIncGst', 37986.70
        )
      )
    );
  end if;

  -- ------------------------------------------------------------
  -- V2 — Cost Estimate (26 May 2026)
  -- "Detailed line-item cost estimate replacing the cost plan.
  -- Includes Areas & Measurements tab and Variations Register." Per
  -- QUOTING-HISTORY.md, the V2 file's own figures aren't separately
  -- tabulated (the doc's "Cost Summary" / "Trade Breakdown" tables are
  -- explicitly the 22-Jun BACKUP SNAPSHOT of this same working file —
  -- captured as V3 below). V2 here is recorded as the structural
  -- milestone (same trade-section shape as V3, values not yet at the
  -- 22 Jun figures) with a note pointing at V3 for the numbers a
  -- comparison would actually use — this avoids fabricating V2-dated
  -- figures the source document doesn't provide.
  -- ------------------------------------------------------------
  if not exists (select 1 from estimate_versions where project_id = v_project_id and label = 'V2') then
    insert into estimate_versions (project_id, label, kind, note, snapshot)
    values (
      v_project_id,
      'V2',
      'issue',
      'Cost Estimate — 26 May 2026 (260526_GOLDSWORTHY_COST_ESTIMATE.xlsx). Detailed line-item estimate replacing the Cost Plan; introduces Areas & Measurements + Variations Register tabs. QUOTING-HISTORY.md records this file''s trade totals only via its 22 Jun backup snapshot — see version V3 for the reconciled figures.',
      jsonb_build_object(
        'markup_pct', 0.30,
        'sow_revision_label', null,
        'measurements', '[]'::jsonb,
        'ffe', jsonb_build_object(
          'categories', '[]'::jsonb, 'total', 0, 'quoted_total', 0, 'placeholder_total', 0,
          'item_count', 0, 'quoted_count', 0, 'placeholder_count', 0, 'unpriced_count', 0,
          'quoted_share', 0, 'placeholder_share', 0
        ),
        'sections', '[]'::jsonb,
        'rollup', jsonb_build_object(
          'allTradesSubtotalExGst', 0, 'approvedVariationsExGst', 0, 'markupPct', 0.30,
          'markupExGst', 0, 'totalToClientExGst', 0, 'gst', 0, 'totalIncGst', 0,
          'quotedExGst', 0, 'actualExGst', 0
        ),
        'wholeJob', jsonb_build_object(
          'trades', jsonb_build_object(
            'allTradesSubtotalExGst', 0, 'approvedVariationsExGst', 0, 'markupPct', 0.30,
            'markupExGst', 0, 'totalToClientExGst', 0, 'gst', 0, 'totalIncGst', 0,
            'quotedExGst', 0, 'actualExGst', 0
          ),
          'ffe', jsonb_build_object(
            'categories', '[]'::jsonb, 'total', 0, 'quoted_total', 0, 'placeholder_total', 0,
            'item_count', 0, 'quoted_count', 0, 'placeholder_count', 0, 'unpriced_count', 0,
            'quoted_share', 0, 'placeholder_share', 0
          ),
          'combinedExGst', 0, 'combinedGst', 0, 'combinedIncGst', 0
        )
      )
    );
  end if;

  -- ------------------------------------------------------------
  -- V3 — 22 Jun 2026 backup snapshot ("source of truth for current
  -- pricing" per QUOTING-HISTORY.md). Trade totals exactly as tabulated
  -- in the "Trade Breakdown (ex GST)" table; markup 30%; total inc GST
  -- $127,833.80 (headline rounds to $127,834 in the build spec's own
  -- prose). One cost line per trade, ex-GST rate = the trade's total
  -- (qty 1, LOT) — a per-line breakdown finer than "one line per
  -- trade" isn't in scope for a frozen historical snapshot; the "Key
  -- Line Items" detail from the source doc is preserved in each line's
  -- `notes` field instead, so nothing from the source is lost even
  -- though it isn't split into separate cost_lines rows.
  -- ------------------------------------------------------------
  if not exists (select 1 from estimate_versions where project_id = v_project_id and label = 'V3') then
    insert into estimate_versions (project_id, label, kind, note, snapshot)
    values (
      v_project_id,
      'V3',
      'issue',
      'Backup snapshot — 22 Jun 2026 (260526_GOLDSWORTHY_COST_ESTIMATE_backup_20260622.xlsx). "Source of truth for current pricing" per QUOTING-HISTORY.md. Subtotal all trades $89,394.27 ex GST, markup 30% ($26,818.28), total to client $116,212.55 ex GST, GST $11,621.25, TOTAL inc GST $127,833.80.',
      jsonb_build_object(
        'markup_pct', 0.30,
        'sow_revision_label', null,
        'measurements', '[]'::jsonb,
        'ffe', jsonb_build_object(
          'categories', '[]'::jsonb, 'total', 0, 'quoted_total', 0, 'placeholder_total', 0,
          'item_count', 0, 'quoted_count', 0, 'placeholder_count', 0, 'unpriced_count', 0,
          'quoted_share', 0, 'placeholder_share', 0
        ),
        'sections', jsonb_build_array(
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000301', 'name', '01 — Preliminaries & Site', 'sort', 1,
            'rollup', jsonb_build_object('costExGst', 1418.00, 'quotedExGst', 0, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(jsonb_build_object(
              'id', '10000000-0000-0000-0000-000000000302', 'section_id', '10000000-0000-0000-0000-000000000301',
              'description', 'Preliminaries & Site — Skip bins x2 ($450ea), council/DA/permit fees, tarp, Ram Board flooring x2 + jamb protector x6',
              'qty', 1, 'unit', 'LOT', 'rate_ex_gst', 1418.00, 'cost_ex_gst', 1418.00,
              'quoted_to_client_ex_gst', null, 'actual_paid_ex_gst', null, 'quote_status', 'NA', 'notes', null
            ))
          ),
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000401', 'name', '02 — Demolition', 'sort', 2,
            'rollup', jsonb_build_object('costExGst', 6500.00, 'quotedExGst', 0, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(jsonb_build_object(
              'id', '10000000-0000-0000-0000-000000000402', 'section_id', '10000000-0000-0000-0000-000000000401',
              'description', 'Full strip-out (main bathroom, ensuite, carpet & subfloor removal)',
              'qty', 1, 'unit', 'LOT', 'rate_ex_gst', 6500.00, 'cost_ex_gst', 6500.00,
              'quoted_to_client_ex_gst', null, 'actual_paid_ex_gst', null, 'quote_status', 'NA', 'notes', 'Budget allowance.'
            ))
          ),
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000501', 'name', '04 — Framing / Carpentry', 'sort', 3,
            'rollup', jsonb_build_object('costExGst', 3290.00, 'quotedExGst', 0, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(jsonb_build_object(
              'id', '10000000-0000-0000-0000-000000000502', 'section_id', '10000000-0000-0000-0000-000000000501',
              'description', 'First/second fix carpentry, timber studs, Structafloor, skirting, architraves',
              'qty', 1, 'unit', 'LOT', 'rate_ex_gst', 3290.00, 'cost_ex_gst', 3290.00,
              'quoted_to_client_ex_gst', null, 'actual_paid_ex_gst', null, 'quote_status', 'NA', 'notes', 'Stephen Singer.'
            ))
          ),
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000601', 'name', '05 — Plasterboard & Render', 'sort', 4,
            'rollup', jsonb_build_object('costExGst', 7055.00, 'quotedExGst', 0, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(jsonb_build_object(
              'id', '10000000-0000-0000-0000-000000000602', 'section_id', '10000000-0000-0000-0000-000000000601',
              'description', 'New partition plasterboard supply & fix', 'qty', 1, 'unit', 'LOT',
              'rate_ex_gst', 7055.00, 'cost_ex_gst', 7055.00, 'quoted_to_client_ex_gst', null,
              'actual_paid_ex_gst', null, 'quote_status', 'NA', 'notes', 'Budget.'
            ))
          ),
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000701', 'name', '07 — Tiling', 'sort', 5,
            'rollup', jsonb_build_object('costExGst', 15625.15, 'quotedExGst', 15625.15, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000702', 'section_id', '10000000-0000-0000-0000-000000000701',
                'description', 'Labour, waterproofing, subfloor prep (all areas)', 'qty', 1, 'unit', 'LOT',
                'rate_ex_gst', 10600.00, 'cost_ex_gst', 10600.00, 'quoted_to_client_ex_gst', 10600.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q', 'notes', 'Aura Tiling (Nick) — on site wk 20 Jul.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000703', 'section_id', '10000000-0000-0000-0000-000000000701',
                'description', 'Tile supply — Oda Porcelain 300x600 Light, 63.13m²', 'qty', 63.13, 'unit', 'm2',
                'rate_ex_gst', 79.60, 'cost_ex_gst', 5025.15, 'quoted_to_client_ex_gst', 5025.15,
                'actual_paid_ex_gst', null, 'quote_status', 'Q', 'notes', 'Ceramica Living — ordered.'
              )
            )
          ),
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000801', 'name', '08 — Plumbing', 'sort', 6,
            -- costExGst kept at the source's own Trade Breakdown table
            -- figure ($15,441.12) rather than the sum of the "Key Line
            -- Items" list below (which totals $16,201.12) — the source
            -- document itself notes this class of discrepancy for
            -- other rows ("inc GST figures below ex GST in some rows —
            -- data entry inconsistency in source file"); this snapshot
            -- preserves the authoritative trade total the build spec
            -- quotes rather than silently reconciling it.
            'rollup', jsonb_build_object('costExGst', 15441.12, 'quotedExGst', 15261.12, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000802', 'section_id', '10000000-0000-0000-0000-000000000801',
                'description', 'Plumbing labour', 'qty', 0.6, 'unit', 'LOT', 'rate_ex_gst', 8000.00,
                'cost_ex_gst', 9000.00, 'quoted_to_client_ex_gst', 9620.00, 'actual_paid_ex_gst', null,
                'quote_status', 'Q', 'notes', 'Zamp Plumbing — 0.6 LOT x $8,000; cost plan shows $9,620 (minor variance noted in source).'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000803', 'section_id', '10000000-0000-0000-0000-000000000801',
                'description', 'Yabby Antique Brass tapware TW-01 to TW-12', 'qty', 1, 'unit', 'SET',
                'rate_ex_gst', 3574.12, 'cost_ex_gst', 3574.12, 'quoted_to_client_ex_gst', 3574.12,
                'actual_paid_ex_gst', null, 'quote_status', 'Q', 'notes', 'Verandah Trade D11092.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000804', 'section_id', '10000000-0000-0000-0000-000000000801',
                'description', 'Caroma Contura II Basin SW-01', 'qty', 1, 'unit', 'EA',
                'rate_ex_gst', 510.00, 'cost_ex_gst', 510.00, 'quoted_to_client_ex_gst', 510.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q', 'notes', 'Demor Q-10718.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000805', 'section_id', '10000000-0000-0000-0000-000000000801',
                'description', 'Caroma Urbane II Toilets SW-02 x2', 'qty', 2, 'unit', 'EA',
                'rate_ex_gst', 720.00, 'cost_ex_gst', 1440.00, 'quoted_to_client_ex_gst', 1440.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q', 'notes', 'Demor Q-10718.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000806', 'section_id', '10000000-0000-0000-0000-000000000801',
                'description', 'Omvivo Rectangular 1010 Undermount SW-04 (ensuite)', 'qty', 1, 'unit', 'EA',
                'rate_ex_gst', 800.00, 'cost_ex_gst', 800.00, 'quoted_to_client_ex_gst', null,
                'actual_paid_ex_gst', null, 'quote_status', 'NA', 'notes', 'Budget — pending, enquiry sent 25 May.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000807', 'section_id', '10000000-0000-0000-0000-000000000801',
                'description', 'Robert Gordon Kiln 360 Storm SW-05 (powder room)', 'qty', 1, 'unit', 'EA',
                'rate_ex_gst', 760.00, 'cost_ex_gst', 760.00, 'quoted_to_client_ex_gst', null,
                'actual_paid_ex_gst', null, 'quote_status', 'NA', 'notes', 'Pending — Phillip to check trade portal.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000808', 'section_id', '10000000-0000-0000-0000-000000000801',
                'description', 'Yabby shower door handle TW-13', 'qty', 1, 'unit', 'EA',
                'rate_ex_gst', 117.00, 'cost_ex_gst', 117.00, 'quoted_to_client_ex_gst', 117.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q', 'notes', null
              )
            )
          ),
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000901', 'name', '09 — Electrical', 'sort', 7,
            -- Same note as Plumbing above: costExGst kept at the source's
            -- Trade Breakdown figure ($6,275); the itemised lines below
            -- sum to $6,155 (a $120 gap the source doc doesn't itself
            -- reconcile, e.g. GPOs not separately line-itemed).
            'rollup', jsonb_build_object('costExGst', 6275.00, 'quotedExGst', 6155.00, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000902', 'section_id', '10000000-0000-0000-0000-000000000901',
                'description', 'Electrical labour (demo decom, downlights, LED strips, exhaust fans, GPOs)',
                'qty', 1, 'unit', 'LOT', 'rate_ex_gst', 4967.00, 'cost_ex_gst', 4967.00,
                'quoted_to_client_ex_gst', 4967.00, 'actual_paid_ex_gst', null, 'quote_status', 'Q', 'notes', 'Final Fix Electrical.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000903', 'section_id', '10000000-0000-0000-0000-000000000901',
                'description', 'XRZLux Trimless Recessed downlights LI-01 x10', 'qty', 10, 'unit', 'EA',
                'rate_ex_gst', 40.00, 'cost_ex_gst', 400.00, 'quoted_to_client_ex_gst', 400.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q', 'notes', null
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000904', 'section_id', '10000000-0000-0000-0000-000000000901',
                'description', 'Lighting Republic Orb Mirror Wall Light LI-03 x2', 'qty', 2, 'unit', 'EA',
                'rate_ex_gst', 150.00, 'cost_ex_gst', 300.00, 'quoted_to_client_ex_gst', 300.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q', 'notes', 'Confirmed x2, not x4.'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000905', 'section_id', '10000000-0000-0000-0000-000000000901',
                'description', 'Exhaust fans x2', 'qty', 2, 'unit', 'EA',
                'rate_ex_gst', 244.00, 'cost_ex_gst', 488.00, 'quoted_to_client_ex_gst', 488.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q', 'notes', null
              )
            )
          ),
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000a01', 'name', '10 — Joinery / Cabinetry', 'sort', 8,
            'rollup', jsonb_build_object('costExGst', 13000.00, 'quotedExGst', 0, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(jsonb_build_object(
              'id', '10000000-0000-0000-0000-000000000a02', 'section_id', '10000000-0000-0000-0000-000000000a01',
              'description', 'Joinery — budget allowance (J02–J05)', 'qty', 1, 'unit', 'LOT',
              'rate_ex_gst', 13000.00, 'cost_ex_gst', 13000.00, 'quoted_to_client_ex_gst', null,
              'actual_paid_ex_gst', null, 'quote_status', 'NA', 'notes', 'LA Custom Joinery — provisional, budget only.'
            ))
          ),
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000b01', 'name', '11 — Stone & Benchtops', 'sort', 9,
            'rollup', jsonb_build_object('costExGst', 10000.00, 'quotedExGst', 0, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(jsonb_build_object(
              'id', '10000000-0000-0000-0000-000000000b02', 'section_id', '10000000-0000-0000-0000-000000000b01',
              'description', 'Stone & benchtops — budget allowance', 'qty', 1, 'unit', 'LOT',
              'rate_ex_gst', 10000.00, 'cost_ex_gst', 10000.00, 'quoted_to_client_ex_gst', null,
              'actual_paid_ex_gst', null, 'quote_status', 'NA',
              'notes', 'Uniq Stone — provisional. Quote on file: $11,900 (main bath + ensuite) + $1,200 powder room add-on, valid to 18 Jul.'
            ))
          ),
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000c01', 'name', '12 — Painting & Decorative Finishes', 'sort', 10,
            'rollup', jsonb_build_object('costExGst', 1600.00, 'quotedExGst', 0, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(jsonb_build_object(
              'id', '10000000-0000-0000-0000-000000000c02', 'section_id', '10000000-0000-0000-0000-000000000c01',
              'description', 'Painting — budget allowance', 'qty', 1, 'unit', 'LOT',
              'rate_ex_gst', 1600.00, 'cost_ex_gst', 1600.00, 'quoted_to_client_ex_gst', null,
              'actual_paid_ex_gst', null, 'quote_status', 'NA', 'notes', 'Will Young — budget only, pending.'
            ))
          ),
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000d01', 'name', '14 — Glazing, Shower Screens & Mirrors', 'sort', 11,
            'rollup', jsonb_build_object('costExGst', 7240.00, 'quotedExGst', 4530.00, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000d02', 'section_id', '10000000-0000-0000-0000-000000000d01',
                'description', 'DT Glass — shower screens (main bath $1,670 + ensuite $2,860)', 'qty', 1, 'unit', 'LOT',
                'rate_ex_gst', 4530.00, 'cost_ex_gst', 4530.00, 'quoted_to_client_ex_gst', 4530.00,
                'actual_paid_ex_gst', null, 'quote_status', 'Q',
                'notes', 'Quote expired 3 Jul 2026 — second quote requested (Elegance Glass + 2 others contacted).'
              ),
              jsonb_build_object(
                'id', '10000000-0000-0000-0000-000000000d03', 'section_id', '10000000-0000-0000-0000-000000000d01',
                'description', 'Mirrors — budget balance', 'qty', 1, 'unit', 'LOT',
                'rate_ex_gst', 2710.00, 'cost_ex_gst', 2710.00, 'quoted_to_client_ex_gst', null,
                'actual_paid_ex_gst', null, 'quote_status', 'NA',
                'notes', 'FA-03 Molly Mirror not yet priced.'
              )
            )
          ),
          jsonb_build_object('id', '10000000-0000-0000-0000-000000000e01', 'name', '18 — Handover & Completion', 'sort', 12,
            'rollup', jsonb_build_object('costExGst', 1950.00, 'quotedExGst', 0, 'actualExGst', 0, 'variance', null),
            'lines', jsonb_build_array(jsonb_build_object(
              'id', '10000000-0000-0000-0000-000000000e02', 'section_id', '10000000-0000-0000-0000-000000000e01',
              'description', 'Handover — provisional allowance', 'qty', 1, 'unit', 'LOT',
              'rate_ex_gst', 1950.00, 'cost_ex_gst', 1950.00, 'quoted_to_client_ex_gst', null,
              'actual_paid_ex_gst', null, 'quote_status', 'NA', 'notes', null
            ))
          )
        ),
        'rollup', jsonb_build_object(
          'allTradesSubtotalExGst', 89394.27,
          'approvedVariationsExGst', 0,
          'markupPct', 0.30,
          'markupExGst', 26818.28,
          'totalToClientExGst', 116212.55,
          'gst', 11621.25,
          'totalIncGst', 127833.80,
          'quotedExGst', 41571.27,
          'actualExGst', 0
        ),
        'wholeJob', jsonb_build_object(
          'trades', jsonb_build_object(
            'allTradesSubtotalExGst', 89394.27, 'approvedVariationsExGst', 0, 'markupPct', 0.30,
            'markupExGst', 26818.28, 'totalToClientExGst', 116212.55, 'gst', 11621.25,
            'totalIncGst', 127833.80, 'quotedExGst', 41571.27, 'actualExGst', 0
          ),
          'ffe', jsonb_build_object(
            'categories', '[]'::jsonb, 'total', 0, 'quoted_total', 0, 'placeholder_total', 0,
            'item_count', 0, 'quoted_count', 0, 'placeholder_count', 0, 'unpriced_count', 0,
            'quoted_share', 0, 'placeholder_share', 0
          ),
          'combinedExGst', 116212.55,
          'combinedGst', 11621.25,
          'combinedIncGst', 127833.80
        )
      )
    );
  end if;
end $$;
