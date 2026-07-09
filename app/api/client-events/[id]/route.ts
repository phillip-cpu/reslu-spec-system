import { NextRequest, NextResponse, after } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/report-error";
import { cancelPendingSends } from "@/lib/visit-emails";
import type { PatchClientEventInput } from "@/types/phase-12a-b";

const EDITABLE_FIELDS = new Set(["title", "starts_at", "ends_at", "location", "notes"]);

/**
 * PATCH /api/client-events/[id]
 * body: PatchClientEventInput (partial). Response: { event }.
 * Aria-relevant.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: existing } = await supabase
    .from("client_events")
    .select("id,starts_at,ends_at")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  let body: PatchClientEventInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    if (key === "title") {
      const trimmed = typeof raw === "string" ? raw.trim() : raw;
      if (!trimmed) {
        return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
      }
      update.title = trimmed;
    } else if (key === "starts_at") {
      if (!raw) {
        return NextResponse.json({ error: "starts_at cannot be empty" }, { status: 400 });
      }
      update.starts_at = raw;
    } else if (typeof raw === "string") {
      update[key] = raw.trim() || null;
    } else {
      update[key] = raw;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const nextStart = (update.starts_at as string | undefined) ?? existing.starts_at;
  const nextEnd = "ends_at" in update ? (update.ends_at as string | null) : existing.ends_at;
  if (nextEnd && new Date(nextEnd) < new Date(nextStart)) {
    return NextResponse.json({ error: "ends_at cannot be before starts_at" }, { status: 400 });
  }

  // Editing a reminded event's time re-arms the reminder — the
  // previously sent reminder was for the OLD date/time, so the gate
  // must reset to avoid silently under-notifying a rescheduled meeting.
  if ("starts_at" in update) {
    update.reminder_sent_at = null;
  }

  const { data: event, error } = await supabase
    .from("client_events")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ event });
}

/**
 * DELETE /api/client-events/[id]
 * Soft-delete (deleted_at) — parity with items/board_tasks/project_files.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("client_events")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Site-visit lifecycle emails: cancelling a client event before its
  // queued visit-reminder (or a still-pending, outside-window
  // confirmation) went out must not send it — same "If a visit is
  // cancelled before the reminder fires, don't send it" rule as the
  // leads PATCH route's site_visit_date-cleared branch (see that
  // file's own doc comment). Fire-and-forget via after(), own
  // service-role client, same pattern as every other after() call site
  // in this codebase (see app/api/items/[id]/route.ts's doc comment on
  // why a request-scoped client isn't reused here).
  after(async () => {
    const service = createServiceRoleClient();
    try {
      await cancelPendingSends(service, "client_event", id);
    } catch (err) {
      await reportError("visit-emails", err);
    }
  });

  return NextResponse.json({ ok: true });
}
