import { NextRequest, NextResponse, after } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { LEAD_STAGES, type Lead, type PatchLeadInput } from "@/types";
import { reportError } from "@/lib/report-error";
import {
  cancelPendingSends,
  formatVisitDate,
  formatVisitTime,
  leadLastName,
  sendOrQueue,
  suburbFrom,
} from "@/lib/visit-emails";

export const runtime = "nodejs";

// Every field editable via a plain PATCH except `stage` — moving stage
// has its own dedicated route (POST /api/leads/[id]/stage) so the
// documented call path always goes through one place, though the DB
// trigger (014_leads.sql) means a stray `stage` key here would still
// correctly log a lead_stage_events row if ever sent. We intentionally
// still ALLOW `stage` here (see EDITABLE_FIELDS) rather than reject it,
// since Aria/UI edge cases (e.g. bulk-correcting an imported lead's
// stage) shouldn't be forced through the stage-move semantics (no
// "from -> to" transition validation needed for a correction).
const EDITABLE_FIELDS = new Set([
  "surname_project",
  "first_name",
  "source",
  "stage",
  "email",
  "phone",
  "location",
  "received_at",
  "follow_up_date",
  "site_visit_date",
  "site_visit_location",
  "construction_value",
  "design_value",
  "design_start",
  "design_end",
  "construction_start",
  "construction_end",
  "notes",
]);

const NUMERIC_FIELDS = new Set(["construction_value", "design_value"]);

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const info = await getUserRole(supabase);
  if (!info) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (info.role !== "admin") {
    return { error: NextResponse.json({ error: "Only admins can access leads" }, { status: 403 }) };
  }
  return { info };
}

/**
 * GET /api/leads/[id]
 * Admin-only. Response: { lead }.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const gate = await requireAdmin(supabase);
  if (gate.error) return gate.error;

  const { data: lead, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (error || !lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  return NextResponse.json({ lead: lead as Lead });
}

/**
 * PATCH /api/leads/[id]
 * Admin-only. body: PatchLeadInput (partial, whitelist-only). Empty
 * strings become null, same convention as PATCH /api/contacts/[id].
 * `surname_project` must stay non-empty if included.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const gate = await requireAdmin(supabase);
  if (gate.error) return gate.error;

  let body: PatchLeadInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.stage && !LEAD_STAGES.includes(body.stage)) {
    return NextResponse.json({ error: `Invalid stage: ${body.stage}` }, { status: 400 });
  }
  if (body.source && !["META", "DIRECT", "WEBSITE"].includes(body.source)) {
    return NextResponse.json({ error: `Invalid source: ${body.source}` }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    if (NUMERIC_FIELDS.has(key)) {
      if (raw === null || raw === undefined || raw === "") {
        update[key] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return NextResponse.json({ error: `${key} must be a number` }, { status: 400 });
      }
      update[key] = n;
    } else if (typeof raw === "string") {
      update[key] = raw.trim() === "" ? null : raw.trim();
    } else {
      update[key] = raw;
    }
  }

  if ("surname_project" in update && !update.surname_project) {
    return NextResponse.json({ error: "surname_project cannot be empty" }, { status: 400 });
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Site-visit lifecycle emails: LeadDetailPanel's single-save pattern
  // sends `site_visit_date` on EVERY save (the whole-panel draft, not
  // just the field the user actually touched), so `"site_visit_date"
  // in update` alone can't tell a real reschedule apart from an
  // unrelated field edit. Read the PRE-update value here (only when
  // site_visit_date is actually part of this PATCH, to avoid an extra
  // query on every unrelated save) so the trigger below can compare
  // before vs. after and fire ONLY on an actual change.
  let previousSiteVisitDate: string | null = null;
  if ("site_visit_date" in update) {
    const { data: before } = await supabase
      .from("leads")
      .select("site_visit_date")
      .eq("id", id)
      .maybeSingle();
    previousSiteVisitDate = before?.site_visit_date ?? null;
  }

  const { data: lead, error } = await supabase
    .from("leads")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  // Site-visit lifecycle emails (docs/RESLU-Spec-Visit-Emails-Brief.md):
  // fire ONLY when site_visit_date actually CHANGED value (see the
  // previousSiteVisitDate read above — this is what makes "re-send only
  // if date/time changed" hold even though the UI always resends the
  // same field on every save). Fire-and-forget via next/server's
  // after() (same pattern as the Monday sync kickoff in
  // app/api/items/[id]/route.ts) so a slow/failed email send never
  // blocks or fails the lead save; uses its own service-role client
  // rather than the request-scoped cookie-bound one, since work queued
  // via after() can outlive the request/response cycle (same reasoning
  // as that file's own doc comment on this exact pattern).
  //
  // A cleared site_visit_date (null after this PATCH) cancels any
  // still-pending queued sends for this lead (brief: "If a visit is
  // cancelled before the reminder fires, don't send it"). A set/
  // changed site_visit_date with an email on file first cancels any
  // STILL-PENDING queued send left over from the PRIOR date/time (a
  // confirmation queued outside the send window for the old date must
  // never go out once the visit has been rescheduled to a new one),
  // then sends/queues the fresh confirmation — sendOrQueue's own guard
  // (see lib/visit-emails.ts) additionally makes this a silent no-op if
  // a confirmation was already SENT for this exact date/time.
  if ("site_visit_date" in update) {
    const typedLead = lead as Lead;
    if (typedLead.site_visit_date !== previousSiteVisitDate) {
      after(async () => {
        const service = createServiceRoleClient();
        try {
          if (!typedLead.site_visit_date) {
            await cancelPendingSends(service, "lead", typedLead.id);
            return;
          }
          await cancelPendingSends(service, "lead", typedLead.id);
          if (!typedLead.email) return;
          const visitDatetime = typedLead.site_visit_date;
          await sendOrQueue(service, {
            recordType: "lead",
            recordId: typedLead.id,
            template: "visit-confirmation",
            to: [typedLead.email],
            subject: `Your site visit — ${formatVisitDate(visitDatetime)}`,
            mergeData: {
              first_name: typedLead.first_name,
              last_name: leadLastName(typedLead.surname_project),
              visit_date: formatVisitDate(visitDatetime),
              visit_time: formatVisitTime(visitDatetime),
              suburb: suburbFrom(typedLead.site_visit_location || typedLead.location),
            },
            visitDatetime,
          });
        } catch (err) {
          await reportError("visit-emails", err);
        }
      });
    }
  }

  return NextResponse.json({ lead: lead as Lead });
}

/**
 * DELETE /api/leads/[id]
 * Admin-only. Soft-delete (deleted_at) — same convention as contacts/
 * items/projects: a lead may already be linked to a project
 * (leads.project_id / projects.lead_id), so a hard delete would orphan
 * that reference; soft delete keeps it resolvable while hiding the
 * lead from every list view immediately.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const gate = await requireAdmin(supabase);
  if (gate.error) return gate.error;

  const { error } = await supabase
    .from("leads")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
