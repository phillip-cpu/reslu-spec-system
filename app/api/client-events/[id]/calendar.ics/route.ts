import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateIcs } from "@/lib/ics";
import type { ClientEvent } from "@/types/phase-12a-b";

export const runtime = "nodejs";

/**
 * GET /api/client-events/[id]/calendar.ics?attendees=email1,email2
 * Auth: session (team) — same "team_all" gate as the rest of the
 * client-events module (PATCH/DELETE in app/api/client-events/[id]/route.ts
 * have no extra admin check either; client_events is team-visible, not
 * admin-only).
 *
 * BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 2: "Add to
 * calendar ▾" on each client event row in ClientEventsPanel. Downloads
 * a single-VEVENT .ics using the event's own starts_at/ends_at
 * (timestamptz — see lib/ics.ts's timezone note; both columns are
 * already true UTC instants so no ACST/ACDT handling is needed here).
 *
 * The event's `notes` field is CLIENT-FACING by design (see
 * ClientEventsPanel.tsx and migration 020's own repeated note on this)
 * — safe to echo into DESCRIPTION here since this route is
 * team-authenticated only and never reaches the client portal.
 *
 * `?attendees=` — same optional comma-separated invitee-emails
 * mechanism as the leads calendar route (lib/ics.ts's ATTENDEE lines +
 * the Google Calendar `add=` param), picked from the same
 * GET /api/profiles-backed invitee picker in ClientEventsPanel.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: event, error } = await supabase
    .from("client_events")
    .select("*, projects(name)")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (error || !event) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  const typedEvent = event as ClientEvent & { projects: { name: string } | null };

  const attendeesParam = request.nextUrl.searchParams.get("attendees");
  const attendees = (attendeesParam ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((email) => ({ email }));

  const projectName = typedEvent.projects?.name;
  const description = [projectName ? `Project: ${projectName}` : null, typedEvent.notes]
    .filter(Boolean)
    .join("\n\n");

  const ics = generateIcs({
    uid: `client-event-${typedEvent.id}@reslu.com.au`,
    title: typedEvent.title,
    start: typedEvent.starts_at,
    end: typedEvent.ends_at,
    location: typedEvent.location ?? undefined,
    description: description || undefined,
    attendees,
  });

  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8; method=PUBLISH",
      "Content-Disposition": `attachment; filename="client-event-${typedEvent.id}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
