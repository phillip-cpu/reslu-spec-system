import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { generateIcs } from "@/lib/ics";
import type { Lead } from "@/types";

export const runtime = "nodejs";

/**
 * GET /api/leads/[id]/calendar.ics?attendees=email1,email2
 * Auth: **admin** — same gate as the rest of the leads module
 * (app/api/leads/[id]/route.ts's requireAdmin; leads are "admin-only,
 * financial-adjacent" per that route's own doc comment).
 *
 * BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 2: "Add to
 * calendar" on the lead detail panel next to the site visit date.
 * Downloads a single-VEVENT .ics for the lead's site visit —
 * `site_visit_date` (a timestamptz — see lib/ics.ts's timezone note
 * for why this is safe to hand straight to generateIcs without any
 * ACST/ACDT conversion). There is no separate site-visit *end* time
 * column on `leads` (only `site_visit_date` + `site_visit_location`
 * exist — see types/index.ts's Lead interface), so the event defaults
 * to a 1-hour block via generateIcs()'s own end-time fallback, same as
 * a client event with no `ends_at` would.
 *
 * Title: "[first name + surname] — Site Visit" per the brief. Leads
 * store name as `first_name` + `surname_project` (the latter is really
 * "surname / project label", not strictly a surname — see
 * LeadDetailPanel's "Name / project" field label) — both are
 * concatenated as-is since that's the closest available approximation
 * of "first + surname" this schema has.
 *
 * `?attendees=` is an optional comma-separated list of emails (the
 * invitee picker in LeadDetailPanel passes team members selected there,
 * e.g. Tenille) baked into the ICS ATTENDEE lines. Never required —
 * omitting it still produces a valid single-organizer event.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access leads" }, { status: 403 });
  }

  const { data: lead, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (error || !lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }
  const typedLead = lead as Lead;

  if (!typedLead.site_visit_date) {
    return NextResponse.json(
      { error: "This lead has no site visit date set yet" },
      { status: 400 }
    );
  }

  const attendeesParam = request.nextUrl.searchParams.get("attendees");
  const attendees = (attendeesParam ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((email) => ({ email }));

  const name = [typedLead.first_name, typedLead.surname_project].filter(Boolean).join(" ");
  const title = `${name || typedLead.surname_project} — Site Visit`;

  const ics = generateIcs({
    uid: `lead-site-visit-${typedLead.id}@reslu.com.au`,
    title,
    start: typedLead.site_visit_date,
    location: typedLead.site_visit_location ?? typedLead.location ?? undefined,
    description: typedLead.notes ?? undefined,
    attendees,
  });

  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8; method=PUBLISH",
      "Content-Disposition": `attachment; filename="site-visit-${typedLead.id}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
