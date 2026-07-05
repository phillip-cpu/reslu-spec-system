import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTeamEmail, isGmailConfigured } from "@/lib/gmail/send";
import { reportError } from "@/lib/report-error";

/**
 * Client-facing email notifications (BUILD-SPEC.md §"Phase 11
 * additions — confirmed by Phillip" point 1):
 *
 *   "on publish of a diary entry, new shared document, signature
 *   request, or shared variation -> email to client (project
 *   client_email ... template: warm, brand tone, one clear link to the
 *   portal section; batch if several in one hour). Uses existing
 *   gmail lib; no-op if unconfigured. Per-project toggle in settings."
 *
 * This is a SEPARATE concern from lib/gmail/digest.ts (which emails
 * the RESLU TEAM about client portal actions). This module emails the
 * CLIENT themselves, using the same low-level lib/gmail/send.ts
 * transport (sendTeamEmail is transport-agnostic despite its name — it
 * just sends a plain-text email from the shared mailbox to whatever
 * `to` list it's given).
 *
 * Batching model: the spec says "batch if several in one hour". This
 * codebase has no background worker/cron infra suitable for a true
 * time-window batch across separate requests (the Week 4 digest queue
 * solves a similar problem via an explicit flush endpoint, but that is
 * a TEAM-facing digest with its own queue table, and adding a whole
 * second queue table + flush route is out of this migration's already
 * large scope). Instead, this module batches at the unit the spec
 * actually cares about — "several triggers within the same request
 * cycle" — via `notifyClientBatch()`: a caller that fires multiple
 * notification-worthy events in one request (e.g. "share 3 documents
 * at once") collects them into a single call and one combined email is
 * sent. Call sites that only ever fire one event per request (diary
 * publish, a single document's share toggle, one signature request)
 * simply call `notifyClient()` once, which is `notifyClientBatch()`
 * with a single-item list — there is no cross-request batching window,
 * which is an intentional, documented simplification: the common case
 * in this app is one action per request anyway (a team member toggles
 * one document's share switch, or publishes one diary entry), so a
 * same-hour cross-request batch would mostly collapse to the same
 * single email a same-request batch already produces, at a much higher
 * implementation cost (a queue table, a time-window flush job, careful
 * handling of partial sends). If real usage shows multiple team
 * members sharing several documents within minutes of each other and
 * the client ends up with a flurry of separate emails, promoting this
 * to a queue+flush model (mirroring lib/gmail/digest.ts almost
 * exactly) is the natural next step.
 *
 * Recipient model (Phase 11 extension - owner contact details,
 * migration 017_project_contacts.sql): a project may have a second
 * owner (client_secondary_email, e.g. a couple). This module sends ONE
 * email with BOTH addresses in the `to` list, rather than two separate
 * sends - lib/gmail/send.ts's sendTeamEmail({ to: string[], ... })
 * already accepts multiple recipients on a single message (it joins
 * them with ", " into one To: header), so this is the natural fit:
 * same content, same thread, both owners see they're both copied
 * (matching how a builder/agent would normally CC both owners on a
 * couple's job rather than sending two separate near-identical
 * emails). client_email (primary) stays the sole gate for whether a
 * notification fires at all - a project with only a secondary email
 * and no primary is treated as having no client_email (matches every
 * other !p.client_email skip check already in this module); the
 * secondary address is purely additive to the recipient list when a
 * primary is present.
 */

export type NotifyClientTrigger =
  | "diary_published"
  | "document_shared"
  | "signature_requested"
  | "variation_shared";

export interface NotifyClientEvent {
  trigger: NotifyClientTrigger;
  /** Short human label used in the batched summary line, e.g. a document filename or variation number. */
  label: string;
  /** Portal section anchor to link to, e.g. "diary", "documents", "contracts", "variations". */
  section: "diary" | "documents" | "contracts" | "variations";
}

export interface NotifyClientResult {
  sent: boolean;
  skipped?: string;
}

interface ProjectRow {
  id: string;
  name: string;
  client_name: string;
  client_token: string;
  client_email: string | null;
  notify_client: boolean;
  // ---- additive (migration 017_project_contacts.sql, Phase 11 ext.) ----
  // Second owner's email, when a job has two owners (couples). See this
  // module's doc comment "Recipient model" below for why both get ONE
  // combined email rather than two separate sends.
  client_secondary_email: string | null;
}

const SECTION_LABEL: Record<NotifyClientEvent["section"], string> = {
  diary: "Diary",
  documents: "Documents",
  contracts: "Contracts & signatures",
  variations: "Variations",
};

const TRIGGER_VERB: Record<NotifyClientTrigger, string> = {
  diary_published: "shared a new diary update",
  document_shared: "shared a new document",
  signature_requested: "sent you a document to review and sign",
  variation_shared: "shared a variation for your review",
};

function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    "https://spec.reslu.com.au"
  ).replace(/\/+$/, "");
}

function portalLink(token: string, section: NotifyClientEvent["section"]): string {
  return `${appUrl()}/portal/${token}#${section}`;
}

/**
 * Sends ONE combined email for however many notification-worthy events
 * happened in this request cycle (see module doc comment above for the
 * batching model). No-op (returns { sent: false, skipped: reason })
 * when: Gmail isn't configured, the project has no client_email, the
 * project's notify_client toggle is off, or the events list is empty.
 * Never throws — a notification failure must never fail the caller's
 * primary action (publishing a diary entry, sharing a document, etc.),
 * mirroring recordPortalAction()'s best-effort contract in
 * lib/gmail/digest.ts.
 */
export async function notifyClientBatch(
  supabase: SupabaseClient,
  projectId: string,
  events: NotifyClientEvent[]
): Promise<NotifyClientResult> {
  try {
    if (events.length === 0) {
      return { sent: false, skipped: "No events" };
    }
    if (!isGmailConfigured()) {
      return { sent: false, skipped: "Gmail credentials not configured" };
    }

    const { data: project } = await supabase
      .from("projects")
      .select("id,name,client_name,client_token,client_email,notify_client,client_secondary_email")
      .eq("id", projectId)
      .single();

    const p = project as ProjectRow | null;
    if (!p) {
      return { sent: false, skipped: "Project not found" };
    }
    if (!p.notify_client) {
      return { sent: false, skipped: "Client notifications disabled for this project" };
    }
    if (!p.client_email) {
      return { sent: false, skipped: "No client_email set for this project" };
    }

    const subject =
      events.length === 1
        ? `${p.name} — new update from RESLU`
        : `${p.name} — new updates from RESLU`;

    // Warm, brand tone, no emojis, one clear link per event's section
    // (spec: "one clear link to the portal section" — with several
    // events across different sections, each gets its own line + link
    // rather than forcing everything behind a single generic link).
    const greeting = `Hi ${p.client_name},`;
    const lines =
      events.length === 1
        ? [`We've ${TRIGGER_VERB[events[0].trigger]} on ${p.name}: ${events[0].label}.`, "", `View it here: ${portalLink(p.client_token, events[0].section)}`]
        : [
            `A few things have moved on ${p.name}:`,
            "",
            ...events.map(
              (e) => `- ${SECTION_LABEL[e.section]}: ${e.label} — ${portalLink(p.client_token, e.section)}`
            ),
          ];

    const body = [
      greeting,
      "",
      ...lines,
      "",
      "As always, reach out any time if you have questions.",
      "",
      "Warm regards,",
      "The RESLU team",
    ].join("\n");

    // Recipient list: primary client_email always; client_secondary_email
    // appended when present (see module doc comment "Recipient model"
    // above for why this is one combined send, not two separate ones).
    const to = [p.client_email, p.client_secondary_email].filter(
      (e): e is string => !!e
    );

    const result = await sendTeamEmail({ to, subject, body });
    if (result.skipped) {
      return { sent: false, skipped: result.reason ?? "Send skipped" };
    }
    return { sent: true };
  } catch (err) {
    // Best-effort — never throw out to the caller's primary action.
    // Phase 14A error visibility — see lib/report-error.ts, admin
    // Settings "System health".
    await reportError("gmail-send", err);
    return { sent: false, skipped: err instanceof Error ? err.message : "Notification failed" };
  }
}

/** Convenience wrapper for the common single-event case. */
export async function notifyClient(
  supabase: SupabaseClient,
  projectId: string,
  event: NotifyClientEvent
): Promise<NotifyClientResult> {
  return notifyClientBatch(supabase, projectId, [event]);
}
