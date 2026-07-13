import { NextRequest, NextResponse, after } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { buildDashboardSummary } from "@/lib/leads";
import { LEAD_STAGES, type CreateLeadInput, type Lead, type LeadStage } from "@/types";
import { reportError } from "@/lib/report-error";
import {
  DEFAULT_PHILLIP_PHONE,
  formatVisitDate,
  formatVisitTime,
  leadLastName,
  sendOrQueue,
  suburbFrom,
} from "@/lib/visit-emails";
import { buildLeadVisitCalendarAssets, ensureBriefToken, briefUrlFor } from "@/lib/lead-brief";

export const runtime = "nodejs";

/**
 * GET /api/leads
 * Admin-only, whole-route hard gate — BUILD-SPEC.md "Leads module
 * (admin-only, financial-adjacent)". Same shape as
 * app/api/invoices/[id]/route.ts: the role check runs before any
 * query, so a non-admin gets a plain 403 and zero lead data is ever
 * queried or returned for them.
 *
 * Query params:
 *   ?stage=          exact stage match (one of LEAD_STAGES)
 *   ?q=               search across surname_project/first_name/location/email/phone
 *   ?since=           ISO timestamp — only leads created_at >= since
 *                      (BUILD-SPEC.md "Aria API layer": "GET
 *                      /api/leads?since — exactly what the ...
 *                      monitor scripts poll")
 *   ?summary=1        also returns a `summary` block (dashboard
 *                      totals — BUILD-SPEC.md "Pipeline dashboard")
 *   ?limit / ?offset  Phase 14A pagination (BUILD-SPEC.md Phase 14
 *                      "pagination/windowing"). Previously unbounded.
 *                      HONEST CAVEAT: NOT byte-for-byte identical for
 *                      every dataset size — a pipeline that ever
 *                      exceeds DEFAULT_LIMIT (500) leads would see this
 *                      route silently return only the first 500 to any
 *                      existing caller that doesn't pass ?limit
 *                      (LeadsWorkspace.tsx, needs-attention poller,
 *                      Aria's MCP list_leads). This studio's real
 *                      pipeline size today is nowhere near 500 — but if
 *                      that changes, those callers need to adopt
 *                      ?limit/?offset (or DEFAULT_LIMIT needs raising)
 *                      before it silently truncates. `total` is
 *                      returned so a consumer can notice "total >
 *                      leads.length". Deliberately NOT applied to the
 *                      ?summary=1 whole-pipeline queries below — the
 *                      dashboard summary must always reflect every
 *                      lead regardless of the list view's current page.
 */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access leads" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const stage = searchParams.get("stage")?.trim();
  const q = searchParams.get("q")?.trim();
  const since = searchParams.get("since")?.trim();
  const wantSummary = searchParams.get("summary") === "1";

  const limitParam = Number(searchParams.get("limit"));
  const offsetParam = Number(searchParams.get("offset"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), MAX_LIMIT)
      : DEFAULT_LIMIT;
  const offset =
    Number.isFinite(offsetParam) && offsetParam > 0 ? Math.floor(offsetParam) : 0;

  if (stage && !LEAD_STAGES.includes(stage as LeadStage)) {
    return NextResponse.json({ error: `Invalid stage: ${stage}` }, { status: 400 });
  }

  let query = supabase
    .from("leads")
    .select("*", { count: "exact" })
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (stage) {
    query = query.eq("stage", stage);
  }
  if (since) {
    const parsed = new Date(since);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "Invalid since timestamp" }, { status: 400 });
    }
    query = query.gte("created_at", parsed.toISOString());
  }
  if (q) {
    const escaped = q.replace(/[%_]/g, (m) => `\\${m}`);
    query = query.or(
      `surname_project.ilike.%${escaped}%,first_name.ilike.%${escaped}%,location.ilike.%${escaped}%,email.ilike.%${escaped}%,phone.ilike.%${escaped}%`
    );
  }

  const { data: leads, error, count } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!wantSummary) {
    return NextResponse.json({
      leads: (leads ?? []) as Lead[],
      total: count ?? leads?.length ?? 0,
      limit,
      offset,
    });
  }

  // Dashboard summary needs stage-change history for the avg-days-
  // in-stage calc — fetch events for every non-deleted lead (not just
  // the filtered set) so the summary always reflects the WHOLE
  // pipeline, independent of any ?stage/?q filter applied to `leads`
  // above (the summary is meant to be a stable dashboard strip, not
  // filtered by the list view's current search).
  const { data: allLeads, error: allLeadsError } = await supabase
    .from("leads")
    .select("*")
    .is("deleted_at", null);
  if (allLeadsError) {
    return NextResponse.json({ error: allLeadsError.message }, { status: 500 });
  }

  const { data: events, error: eventsError } = await supabase
    .from("lead_stage_events")
    .select("*");
  if (eventsError) {
    return NextResponse.json({ error: eventsError.message }, { status: 500 });
  }

  const summary = buildDashboardSummary(
    (allLeads ?? []) as Lead[],
    (events ?? []) as import("@/types").LeadStageEvent[]
  );

  return NextResponse.json({ leads: (leads ?? []) as Lead[], summary });
}

/**
 * POST /api/leads
 * Admin-only. Creates a new lead natively (not via the Monday import
 * script — see scripts/import-monday-leads.mjs for that path, which
 * upserts directly via the service-role client instead of this route).
 * Body: CreateLeadInput — only `surname_project` is required.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can create leads" }, { status: 403 });
  }

  let body: CreateLeadInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.surname_project?.trim()) {
    return NextResponse.json({ error: "surname_project is required" }, { status: 400 });
  }

  if (body.stage && !LEAD_STAGES.includes(body.stage)) {
    return NextResponse.json({ error: `Invalid stage: ${body.stage}` }, { status: 400 });
  }
  if (body.source && !["META", "DIRECT", "WEBSITE"].includes(body.source)) {
    return NextResponse.json({ error: `Invalid source: ${body.source}` }, { status: 400 });
  }

  const numericFields: (keyof CreateLeadInput)[] = ["construction_value", "design_value"];
  for (const f of numericFields) {
    const v = body[f];
    if (v !== undefined && v !== null && !Number.isFinite(Number(v))) {
      return NextResponse.json({ error: `${f} must be a number` }, { status: 400 });
    }
  }

  const insert = {
    surname_project: body.surname_project.trim(),
    first_name: body.first_name?.trim() || null,
    source: body.source ?? null,
    stage: body.stage ?? "Potential Lead",
    email: body.email?.trim() || null,
    phone: body.phone?.trim() || null,
    location: body.location?.trim() || null,
    received_at: body.received_at ?? new Date().toISOString(),
    follow_up_date: body.follow_up_date || null,
    site_visit_date: body.site_visit_date || null,
    site_visit_location: body.site_visit_location?.trim() || null,
    construction_value: body.construction_value ?? null,
    design_value: body.design_value ?? null,
    design_start: body.design_start || null,
    design_end: body.design_end || null,
    construction_start: body.construction_start || null,
    construction_end: body.construction_end || null,
    notes: body.notes?.trim() || null,
    created_by: info.userId,
  };

  const { data: lead, error } = await supabase
    .from("leads")
    .insert(insert)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Site-visit lifecycle emails: a lead can be created with
  // site_visit_date already set (an admin backdating/importing a lead
  // that already had a booked visit) — same trigger as the PATCH route
  // (see app/api/leads/[id]/route.ts's own doc comment on this exact
  // pattern), just on the create path instead of the edit path. No
  // cancellation branch needed here — a freshly-created lead has no
  // prior email_sends rows to cancel.
  const created = lead as Lead;
  if (created.site_visit_date && created.email) {
    after(async () => {
      const service = createServiceRoleClient();
      try {
        const visitDatetime = created.site_visit_date as string;
        // Lead flow round (048) — a freshly-inserted lead's
        // visit_ics_sequence is always 0 (migration 048's column
        // default; no prior invite has ever been sent for this record),
        // so no increment logic is needed here (contrast with the PATCH
        // route's reschedule branch).
        const { calendarLink, icsAttachment } = buildLeadVisitCalendarAssets(
          created.id,
          visitDatetime,
          0,
          DEFAULT_PHILLIP_PHONE
        );
        // BUILD-SPEC.md r27 item 5 — the brief questionnaire link used
        // to ride ONLY the day-before reminder (app/api/visit-emails/
        // run/route.ts), which never fires for a short-notice visit
        // booked inside that 1-2 day window — the questionnaire simply
        // never reached the lead. Same ensureBriefToken()/briefUrlFor()
        // pair the reminder sweep already uses, called here too so the
        // BOOKING-TIME confirmation carries the same link as a fallback.
        const briefToken = await ensureBriefToken(service, created.id, null);
        const briefLink = briefUrlFor(briefToken);
        await sendOrQueue(service, {
          recordType: "lead",
          recordId: created.id,
          template: "visit-confirmation",
          to: [created.email as string],
          subject: `Your site visit — ${formatVisitDate(visitDatetime)}`,
          mergeData: {
            first_name: created.first_name,
            last_name: leadLastName(created.surname_project),
            visit_date: formatVisitDate(visitDatetime),
            visit_time: formatVisitTime(visitDatetime),
            suburb: suburbFrom(created.site_visit_location || created.location),
            calendar_link: calendarLink,
            brief_link: briefLink,
          },
          visitDatetime,
          attachments: [icsAttachment],
        });
      } catch (err) {
        await reportError("visit-emails", err);
      }
    });
  }

  return NextResponse.json({ lead: lead as Lead }, { status: 201 });
}
