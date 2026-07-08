// ============================================================
// RESLU Spec System — Order-by engine LOCAL types (Phillip, 8 July
// 2026). BUILD-SPEC.md "Order-by engine — product deadlines from trade
// bookings".
//
// Deliberately NOT added to types/index.ts (protected this round — see
// the round's own file-boundary list) or any prior round's own
// types/*.ts file — follows the exact same per-round-own-file
// convention every phase-N.ts / round-*.ts file in this directory
// already uses (see types/phase-fix-a.ts's header comment for the
// fullest statement of the rationale, and types/board-cockpit.ts's own
// header for the most recent worked example). Every type below is
// scoped to this round's own files: lib/order-by.ts,
// components/items/ProcurementView.tsx, components/items/
// ProjectWorkspace.tsx, app/api/projects/[id]/order-by/route.ts,
// app/api/projects/[id]/attention/route.ts, app/api/my-work/route.ts,
// mcp/src/index.mjs.
//
// Cross-imports from types/index.ts / types/round-export-batch.ts /
// lib/order-by.ts are READ-ONLY reuse of existing, already-defined
// shapes — nothing in any of those files is modified.
// ============================================================

import type { ContactSummary } from "@/types";
import type { ExportPresetRow } from "@/types/round-export-batch";
import type { OrderByStatus } from "@/lib/order-by";

// ------------------------------------------------------------
// GET /api/projects/[id]/order-by — the data ProcurementView needs to
// render the ORDER BY column, fetched lazily the same way Round B's
// measurement-link data is (see ProjectWorkspace.tsx's existing
// useEffect for the established "admin-only, only once the Procurement
// view is opened" lazy-load convention this route's client reuses).
// ------------------------------------------------------------

/** One item's derived order-by result, annotated with lightweight display data (contact/preset names) so ProcurementView never needs a second round-trip to label a chip. */
export interface OrderByRow {
  item_id: string;
  status: OrderByStatus;
  order_by: string | null;
  works_date: string | null;
  /** The preset (trade mapping) whose contact_categories/name-heuristic matched — null when status is 'no_booking'. Only `name` is needed for display ("Order by — Carpenter"). */
  matched_preset_name: string | null;
  /** The contact behind the winning works-date source, for a "booked: {company}" tooltip — null when status is 'no_booking'. */
  matched_contact: ContactSummary | null;
}

/** GET /api/projects/[id]/order-by response. Admin-only (procurement-sensitive — same gating as the rest of the P&P view, see route's own doc comment). `missing_lead_time_item_ids` is the project-scoped slice of lib/order-by.ts's missingLeadTimes() — a strict superset signal independent of `rows` (see that function's own doc comment): every item id in this set is missing a lead time, whether or not it also appears in `rows` with status 'no_lead_time'. */
export interface OrderByResponse {
  rows: OrderByRow[];
  missing_lead_time_item_ids: string[];
}

// ------------------------------------------------------------
// Project needs-attention feed additions — 'ordering_due' +
// 'missing_lead_times'. Additive: see app/api/projects/[id]/attention/route.ts's
// own doc comment for how these two groups sit alongside this
// codebase's EXISTING per-domain attention endpoints (GET
// /api/visits/attention, GET /api/board-tasks/attention, GET
// /api/contacts/attention, GET /api/leads/attention, GET
// /api/materials/attention) without restructuring any of them — this
// is a NEW project-scoped route, not a rewrite of an existing one.
// ------------------------------------------------------------

/** One item in the 'ordering_due' attention group — due_soon or overdue only (per BUILD-SPEC item 3), sorted overdue-first. */
export interface OrderingDueAttentionItem {
  item_id: string;
  item_code: string;
  item_name: string;
  status: Extract<OrderByStatus, "due_soon" | "overdue">;
  order_by: string;
  works_date: string;
  matched_preset_name: string | null;
}

/** GET /api/projects/[id]/attention response — this round's two additive groups. A future round may add further groups to this same response shape; existing per-domain attention endpoints are untouched. */
export interface ProjectAttentionResponse {
  ordering_due: OrderingDueAttentionItem[];
  missing_lead_times: {
    count: number;
    /** Deep link to the P&P view filtered/focused on missing-lead-time rows — see ProcurementView.tsx's focus-id convention. */
    href: string;
  };
}

// ------------------------------------------------------------
// Settings copy — "Trade mappings" framing (BUILD-SPEC item 1: "Settings
// copy updated to present presets as 'Trade mappings'"). No new type
// needed beyond re-exporting ExportPresetRow for callers that want a
// single import — kept here for discoverability from this round's own
// file, not because the shape itself changed.
// ------------------------------------------------------------
export type { ExportPresetRow };
