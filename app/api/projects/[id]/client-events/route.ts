import { NextRequest, NextResponse, after } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { notifyAriaClientEventCreated } from "@/lib/aria-webhook";
import { reportError } from "@/lib/report-error";
import { formatVisitDate, formatVisitTime, sendOrQueue, suburbFrom } from "@/lib/visit-emails";
import type { ClientEventsResponse, CreateClientEventInput } from "@/types/phase-12a-b";

/**
 * GET /api/projects/[id]/client-events
 * Team-visible (not financial), soonest-first — BUILD-SPEC.md §"Portal
 * — upcoming client meetings": "Team manages from the project client
 * area ... (and Aria via API/MCP create_client_event — she already
 * books meetings)." Returns EVERY non-deleted event (past and future —
 * the team-side list shows history; only the PORTAL page filters to
 * future-only, see app/portal/[token]/page.tsx's client-events query).
 * Aria-relevant.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { data: events, error } = await supabase
    .from("client_events")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("starts_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const body: ClientEventsResponse = { events: events ?? [] };
  return NextResponse.json(body);
}

/**
 * POST /api/projects/[id]/client-events
 * body: CreateClientEventInput — { title, starts_at (required),
 * ends_at?, location?, notes? }. Response: { event } (201).
 * Aria-relevant (MCP tool create_client_event — she already books
 * meetings per BUILD-SPEC.md).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,client_name,client_email,client_secondary_email")
    .eq("id", projectId)
    .single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: CreateClientEventInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.title?.trim() || !body.starts_at) {
    return NextResponse.json({ error: "title and starts_at are required" }, { status: 400 });
  }

  if (body.ends_at && new Date(body.ends_at) < new Date(body.starts_at)) {
    return NextResponse.json({ error: "ends_at cannot be before starts_at" }, { status: 400 });
  }

  const { data: event, error } = await supabase
    .from("client_events")
    .insert({
      project_id: projectId,
      title: body.title.trim(),
      starts_at: body.starts_at,
      ends_at: body.ends_at || null,
      location: body.location?.trim() || null,
      notes: body.notes?.trim() || null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Push to Aria's calendar-sync webhook — fire-and-forget via
  // next/server's after() (same pattern as the Monday sync kickoff in
  // app/api/items/[id]/route.ts) so this never blocks or fails the
  // response; a delivery failure (or the webhook simply not being
  // configured yet) is invisible to the team member who just saved
  // the event.
  after(async () => {
    try {
      await notifyAriaClientEventCreated({
        id: event.id,
        project_id: projectId,
        project_name: project.name,
        title: event.title,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        location: event.location,
        notes: event.notes,
      });
    } catch (err) {
      await reportError("aria-client-event-webhook", err);
    }
  });

  // Site-visit lifecycle emails (docs/RESLU-Spec-Visit-Emails-Brief.md
  // + BUILD-SPEC.md §"Site-visit lifecycle emails": "applies to lead
  // site visits AND project client_events"). starts_at is a required
  // field on this route already (validated above), so the only gate
  // here is whether the project has a client_email on file. Fire-and-
  // forget via after(), own service-role client — same pattern as the
  // Aria webhook push just above (see that block's own doc comment for
  // why a request-scoped client isn't reused inside after()). This is
  // a SEPARATE send from lib/client-event-reminders.ts's existing
  // "day before" meeting nudge (Gmail-based, generic content) — this
  // one is the brand visit-confirmation.html template via Resend, sent
  // once at booking time, guarded/logged in its own email_sends table
  // (migration 043), not client_events.reminder_sent_at.
  if (project.client_email) {
    after(async () => {
      const service = createServiceRoleClient();
      try {
        const to = [project.client_email, project.client_secondary_email].filter(
          (e): e is string => !!e
        );
        const [firstName, ...rest] = (project.client_name ?? "").split(" ");
        const visitDatetime = event.starts_at as string;
        await sendOrQueue(service, {
          recordType: "client_event",
          recordId: event.id,
          template: "visit-confirmation",
          to,
          subject: `Your site visit — ${formatVisitDate(visitDatetime)}`,
          mergeData: {
            first_name: firstName || project.client_name,
            last_name: rest.join(" "),
            visit_date: formatVisitDate(visitDatetime),
            visit_time: formatVisitTime(visitDatetime),
            suburb: suburbFrom(event.location),
          },
          visitDatetime,
        });
      } catch (err) {
        await reportError("visit-emails", err);
      }
    });
  }

  return NextResponse.json({ event }, { status: 201 });
}
