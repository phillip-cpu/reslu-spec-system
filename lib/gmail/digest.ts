import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTeamEmail, isGmailConfigured } from "./send";

/**
 * Team digest on client-portal actions (BUILD-SPEC.md §9 / Review §1.8:
 * "Email digest to team on client portal actions").
 *
 * Design (Week 4 task): rather than sending one email per portal click
 * (the Week 3B code's `notifyTeam`, which called Gmail synchronously
 * inline on every approve/flag), actions are queued in
 * `portal_digest_queue` (migration 006) and a separate authenticated
 * route flushes them in a batch, grouped per project, to admin
 * profiles. This is simpler and more reliable than a cron job: the
 * queue is durable (a row lands even if Gmail is down or unconfigured
 * at the time of the action), and flushing is triggered by any admin
 * hitting POST /api/digest/flush — e.g. wired to a manual "Send
 * digest" button, or an external scheduler (Vercel Cron / uptime
 * ping) hitting the same authenticated route on a timer. No
 * always-on server process is required either way.
 *
 * recordPortalAction() is called from the portal action route
 * (app/api/portal/[token]/[action]/[itemId]/route.ts) — see that
 * file for the single import+call line that wires it in. It is a
 * pure insert: it never sends email itself and never throws in a way
 * that could fail the client's portal action (best-effort, swallows
 * its own errors).
 *
 * flushDigest() is called from app/api/digest/flush/route.ts, which
 * enforces auth (admin-only isn't required to trigger a flush — any
 * signed-in team member may — but the route itself requires a valid
 * session; see that file).
 */

export interface RecordPortalActionInput {
  projectId: string;
  itemId: string;
  action: "approve" | "flag";
  note: string | null;
}

/**
 * Inserts one row into portal_digest_queue. Uses the service-role
 * client passed in by the caller (the portal route already has one —
 * portal routes are unauthenticated by session, so they use
 * createServiceRoleClient() throughout). Never throws: a digest queue
 * failure must never surface to the client submitting an approval.
 */
export async function recordPortalAction(
  supabase: SupabaseClient,
  input: RecordPortalActionInput
): Promise<void> {
  try {
    await supabase.from("portal_digest_queue").insert({
      project_id: input.projectId,
      item_id: input.itemId,
      action: input.action,
      note: input.note,
    });
  } catch {
    // Queueing the digest is never allowed to fail the portal action.
  }
}

interface QueueRow {
  id: string;
  project_id: string;
  item_id: string;
  action: "approve" | "flag";
  note: string | null;
  created_at: string;
}

export interface FlushDigestResult {
  skipped?: string;
  projectsSent: number;
  rowsSent: number;
  errors: string[];
}

/**
 * Sends all pending (sent_at IS NULL) digest rows, grouped per project,
 * to every admin profile's email, then marks those rows sent_at. If
 * Gmail isn't configured, returns { skipped: 'not configured' } and
 * leaves the queue untouched (nothing is marked sent, so a later
 * flush — once Gmail is wired up — will pick everything up).
 *
 * Email format follows the brief's example tone exactly: plain,
 * branded, no emojis —
 *   "Goldsworthy — client activity: 2 approved, 1 flagged (SW-04:
 *   'wrong colour')"
 * with a link to the project register.
 */
export async function flushDigest(
  supabase: SupabaseClient,
  appUrl: string
): Promise<FlushDigestResult> {
  // Check config upfront rather than discovering it via a failed send
  // partway through the per-project loop — cheaper, and the queue is
  // left completely untouched either way.
  if (!isGmailConfigured()) {
    return { skipped: "Gmail credentials not configured", projectsSent: 0, rowsSent: 0, errors: [] };
  }

  const { data: pending, error } = await supabase
    .from("portal_digest_queue")
    .select("id,project_id,item_id,action,note,created_at")
    .is("sent_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    return { projectsSent: 0, rowsSent: 0, errors: [error.message] };
  }
  const rows = (pending ?? []) as QueueRow[];
  if (rows.length === 0) {
    return { projectsSent: 0, rowsSent: 0, errors: [] };
  }

  const { data: admins } = await supabase
    .from("profiles")
    .select("email")
    .eq("role", "admin");
  const adminEmails = (admins ?? [])
    .map((p: { email: string }) => p.email)
    .filter(Boolean);

  const byProject = new Map<string, QueueRow[]>();
  for (const row of rows) {
    const list = byProject.get(row.project_id) ?? [];
    list.push(row);
    byProject.set(row.project_id, list);
  }

  const errors: string[] = [];
  let projectsSent = 0;
  let rowsSent = 0;

  for (const [projectId, projectRows] of byProject) {
    const { data: project } = await supabase
      .from("projects")
      .select("name")
      .eq("id", projectId)
      .single();
    const projectName = project?.name ?? "Project";

    const itemIds = [...new Set(projectRows.map((r) => r.item_id))];
    const { data: items } = await supabase
      .from("items")
      .select("id,item_code,name")
      .in("id", itemIds);
    const itemById = new Map(
      (items ?? []).map((i: { id: string; item_code: string; name: string }) => [i.id, i])
    );

    const approvedCount = projectRows.filter((r) => r.action === "approve").length;
    const flaggedRows = projectRows.filter((r) => r.action === "flag");

    const flagSummary = flaggedRows
      .map((r) => {
        const item = itemById.get(r.item_id);
        const code = item?.item_code ?? "?";
        return r.note ? `${code}: '${r.note}'` : code;
      })
      .join("; ");

    const parts = [
      approvedCount > 0 ? `${approvedCount} approved` : null,
      flaggedRows.length > 0
        ? `${flaggedRows.length} flagged${flagSummary ? ` (${flagSummary})` : ""}`
        : null,
    ].filter(Boolean);

    const subject = `${projectName} — client activity: ${parts.join(", ")}`;
    const registerLink = `${appUrl.replace(/\/+$/, "")}/projects/${projectId}`;
    const body = `${subject}\n\nView the register: ${registerLink}`;

    if (adminEmails.length === 0) {
      errors.push(`${projectName}: no admin recipients`);
      continue;
    }

    try {
      const result = await sendTeamEmail({ to: adminEmails, subject, body });
      if (result.skipped) {
        return { skipped: result.reason ?? "not configured", projectsSent, rowsSent, errors };
      }
      const ids = projectRows.map((r) => r.id);
      await supabase
        .from("portal_digest_queue")
        .update({ sent_at: new Date().toISOString() })
        .in("id", ids);
      projectsSent += 1;
      rowsSent += projectRows.length;
    } catch (err) {
      errors.push(
        `${projectName}: ${err instanceof Error ? err.message : "send failed"}`
      );
    }
  }

  return { projectsSent, rowsSent, errors };
}
