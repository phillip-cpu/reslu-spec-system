import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendOrQueue } from "@/lib/visit-emails";
import { buildTaskRowsHtml } from "@/lib/trade-booking";
import { documentPackMentionLine } from "@/lib/trade-doc-pack";
import type {
  CreateTradeBookingRequestInput,
  CreateTradeBookingRequestResponse,
  CreateTradeBookingRequestSkippedTask,
} from "@/types/round-grouped-trade-booking";
import type { DocumentPackChoices } from "@/types/trade-doc-pack";

export const runtime = "nodejs";

/**
 * POST /api/projects/[id]/trade-requests
 *
 * Grouped trade booking round (r20) — BUILD-SPEC.md item 2's "Send"
 * action: creates ONE trade_booking_requests row, links/creates a
 * trade_visits row per selected task (line_status 'proposed'), then
 * sends ONE email covering every line (BUILD-SPEC.md item 3), via the
 * EXISTING visit-emails machinery (lib/visit-emails.ts's sendOrQueue —
 * email_sends log, 7am-7pm Adelaide window), same reuse discipline as
 * every other trigger in this codebase.
 *
 * There is no separate "save as draft, send later" step in this round
 * — this ONE route call both assembles and sends the request (the
 * panel's "Send" button is this route's only caller). `status` is
 * written straight to 'sent' with `sent_at = now()`; 'draft' exists in
 * the CHECK constraint for schema completeness / a future staged-save
 * UI, but nothing in this round ever creates a row that stays 'draft'.
 *
 * body: CreateTradeBookingRequestInput — { contact_id, task_ids,
 * document_pack? }. Each task_id is validated independently and
 * SKIPPED (not a whole-request failure) when it doesn't belong to this
 * project, doesn't carry this same contact_id, has no booking_date/
 * booking_end_date set, or can't resolve a phase_id via its
 * board_groups row (a trade_visits row cannot exist without a
 * phase_id — see migration 016) — same per-row error-collection
 * discipline as POST /api/phases/[id]/shift-items. Skipped tasks are
 * reported back in `skipped`, never silently dropped.
 *
 * A task already linked to an existing trade_visits row (visit_id set
 * — e.g. booked individually via the r15 flow) is RE-LINKED into this
 * request (booking_request_id + line_status set on the existing row)
 * rather than creating a second, orphaned visit — mirrors POST
 * /api/board-tasks/[id]/book-visit's own existing_visit_id branch.
 * Every other selected task gets a brand-new trade_visits row.
 *
 * document_pack (BUILD-SPEC.md item 2: "One document pack for the
 * request ... frozen choices at send time") is written IDENTICALLY
 * onto every line's trade_visits.document_pack column — the existing
 * migration-032 column, existing freeze-at-booking-time semantics,
 * just applied to N rows in one request instead of one.
 *
 * Response: CreateTradeBookingRequestResponse.
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
    .select("id,name,address")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: CreateTradeBookingRequestInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.contact_id) {
    return NextResponse.json({ error: "contact_id is required" }, { status: 400 });
  }
  const taskIds = [...new Set(body.task_ids ?? [])];
  if (taskIds.length === 0) {
    return NextResponse.json({ error: "task_ids must include at least one task" }, { status: 400 });
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id,company,email")
    .eq("id", body.contact_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const { data: taskRows } = await supabase
    .from("board_tasks")
    .select("id,title,project_id,contact_id,booking_date,booking_end_date,phase_group_id,visit_id")
    .in("id", taskIds)
    .is("deleted_at", null);
  const taskById = new Map((taskRows ?? []).map((t) => [t.id, t]));

  const groupIds = [
    ...new Set((taskRows ?? []).map((t) => t.phase_group_id).filter((v): v is string => !!v)),
  ];
  const { data: groupRows } = groupIds.length
    ? await supabase.from("board_groups").select("id,phase_id").in("id", groupIds)
    : { data: [] as { id: string; phase_id: string | null }[] };
  const phaseIdByGroup = new Map((groupRows ?? []).map((g) => [g.id, g.phase_id]));

  // Review fix: a task's EXISTING visit (visit_id set) may already be
  // linked to a DIFFERENT, still-open ('sent') trade_booking_requests
  // row — e.g. it's line 2 of a request sent yesterday that's still
  // awaiting a response. Re-linking it here (the branch below used to
  // do this unconditionally) would silently steal it, orphaning that
  // OTHER request's line — its token page loses a line it already
  // emailed the trade about, and that request can get stuck if it was
  // the only still-'proposed' line (allLinesResolved never fires).
  // Re-linking a visit whose current request is already 'responded'/
  // 'closed' is fine (that story is over) — only a still-'sent' request
  // is protected.
  const existingVisitIds = [
    ...new Set((taskRows ?? []).map((t) => t.visit_id).filter((v): v is string => !!v)),
  ];
  const { data: existingVisitRows } = existingVisitIds.length
    ? await supabase.from("trade_visits").select("id,booking_request_id").in("id", existingVisitIds)
    : { data: [] as { id: string; booking_request_id: string | null }[] };
  const priorRequestIdByVisitId = new Map(
    (existingVisitRows ?? []).filter((v) => v.booking_request_id).map((v) => [v.id, v.booking_request_id as string])
  );
  const priorRequestIds = [...new Set(priorRequestIdByVisitId.values())];
  const { data: priorRequestRows } = priorRequestIds.length
    ? await supabase.from("trade_booking_requests").select("id,status").in("id", priorRequestIds)
    : { data: [] as { id: string; status: string }[] };
  const openPriorRequestIds = new Set(
    (priorRequestRows ?? []).filter((r) => r.status === "sent").map((r) => r.id)
  );
  function visitAlreadyInOpenRequest(visitId: string): boolean {
    const priorRequestId = priorRequestIdByVisitId.get(visitId);
    return !!priorRequestId && openPriorRequestIds.has(priorRequestId);
  }

  const skipped: CreateTradeBookingRequestSkippedTask[] = [];
  const eligible: { task: NonNullable<ReturnType<typeof taskById.get>>; phase_id: string }[] = [];

  for (const taskId of taskIds) {
    const task = taskById.get(taskId);
    if (!task || task.project_id !== projectId) {
      skipped.push({ task_id: taskId, reason: "not_found" });
      continue;
    }
    if (task.contact_id !== body.contact_id) {
      skipped.push({ task_id: taskId, reason: "wrong_contact" });
      continue;
    }
    if (!task.booking_date || !task.booking_end_date) {
      skipped.push({ task_id: taskId, reason: "no_booking_dates" });
      continue;
    }
    const phaseId = task.phase_group_id ? phaseIdByGroup.get(task.phase_group_id) ?? null : null;
    if (!phaseId) {
      skipped.push({ task_id: taskId, reason: "no_phase" });
      continue;
    }
    if (task.visit_id && visitAlreadyInOpenRequest(task.visit_id)) {
      skipped.push({ task_id: taskId, reason: "already_in_open_request" });
      continue;
    }
    eligible.push({ task, phase_id: phaseId });
  }

  if (eligible.length === 0) {
    return NextResponse.json(
      { error: "No eligible tasks selected — every task needs booking dates and a phase.", skipped },
      { status: 400 }
    );
  }

  const documentPack: DocumentPackChoices | undefined = body.document_pack;

  const { data: bookingRequest, error: requestError } = await supabase
    .from("trade_booking_requests")
    .insert({
      project_id: projectId,
      contact_id: body.contact_id,
      status: "sent",
      sent_at: new Date().toISOString(),
      created_by: user.id,
    })
    .select()
    .single();
  if (requestError || !bookingRequest) {
    return NextResponse.json({ error: requestError?.message ?? "Could not create request" }, { status: 500 });
  }

  const visitIds: string[] = [];
  const emailLines: { task_title: string; start_date: string; end_date: string }[] = [];

  for (const { task, phase_id } of eligible) {
    if (task.visit_id) {
      const { data: updated, error: updateError } = await supabase
        .from("trade_visits")
        .update({
          booking_request_id: bookingRequest.id,
          line_status: "proposed",
          // Booking status visibility round (r20.1) — reset status back
          // to 'unconfirmed' on re-link, mirroring the brand-new-visit
          // branch below. Without this, re-proposing a task whose
          // EXISTING visit was already 'confirmed' (e.g. re-grouping a
          // previously individually-booked task into a new request)
          // would leave status='confirmed' sitting alongside this fresh
          // line_status='proposed' — lib/booking-status.ts's
          // deriveBookingStatus() checks status==='confirmed' before
          // falling through to 'requested', so it would misread this new,
          // still-awaiting-a-reply line as already 'booked'. The new
          // proposed dates supersede whatever this visit's status used to
          // be; it must wait for a fresh response like any other line.
          status: "unconfirmed",
          start_date: task.booking_date,
          end_date: task.booking_end_date,
          ...(documentPack ? { document_pack: documentPack } : {}),
        })
        .eq("id", task.visit_id)
        .select("id")
        .maybeSingle();
      if (!updateError && updated) {
        visitIds.push(updated.id);
        emailLines.push({ task_title: task.title, start_date: task.booking_date!, end_date: task.booking_end_date! });
      }
      continue;
    }

    const { data: newVisit, error: visitError } = await supabase
      .from("trade_visits")
      .insert({
        project_id: projectId,
        phase_id,
        contact_id: body.contact_id,
        start_date: task.booking_date,
        end_date: task.booking_end_date,
        status: "unconfirmed",
        booking_request_id: bookingRequest.id,
        line_status: "proposed",
        document_pack: documentPack || null,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (visitError || !newVisit) {
      skipped.push({ task_id: task.id, reason: "not_found" });
      continue;
    }
    await supabase.from("board_tasks").update({ visit_id: newVisit.id }).eq("id", task.id);
    visitIds.push(newVisit.id);
    emailLines.push({ task_title: task.title, start_date: task.booking_date!, end_date: task.booking_end_date! });
  }

  if (visitIds.length === 0) {
    return NextResponse.json({ error: "Could not create any booking lines.", skipped }, { status: 500 });
  }

  // ---- The email — item 3: ONE email, existing visit-emails
  // machinery (sendOrQueue/email_sends/Adelaide window). ----
  let email_sent = false;
  let email_skip_reason: string | undefined;
  if (!contact.email) {
    email_skip_reason = "No recipient email on file";
  } else {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
    const requestLink = `${appUrl}/trade-request/${bookingRequest.token}`;
    const hasPack = documentPack
      ? documentPack.include_plans || documentPack.include_sow || "schedule_categories" in documentPack
      : false;
    const result = await sendOrQueue(supabase, {
      recordType: "trade_booking_request",
      recordId: bookingRequest.id,
      template: "trade-booking-request",
      to: [contact.email],
      subject: `RESLU · site visit dates — ${project.name}`,
      mergeData: {
        company: contact.company,
        project_name: project.name,
        project_address: project.address ?? "",
        task_rows: buildTaskRowsHtml(emailLines),
        request_link: requestLink,
        attachments_note: hasPack ? documentPackMentionLine() : "",
      },
      // No single "visit datetime" for a grouped request — the
      // request's own token is unique per send, so this is only ever
      // this call's own dedupe key (see sendOrQueue's own doc comment);
      // real double-send protection for THIS route is the request's
      // own row (created fresh above, never re-used on a re-POST) —
      // re-sending the SAME request is POST /api/trade-requests/[id]/resend,
      // a separate, explicitly-guarded route (item 6).
      visitDatetime: bookingRequest.created_at,
    });
    email_sent = result.action === "sent";
    if (!email_sent) email_skip_reason = result.reason;
  }

  const response: CreateTradeBookingRequestResponse = {
    request: bookingRequest,
    visit_ids: visitIds,
    skipped,
    email_sent,
    email_skip_reason,
  };
  return NextResponse.json(response, { status: 201 });
}
