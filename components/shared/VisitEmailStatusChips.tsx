"use client";

import { useEffect, useState } from "react";
import type { EmailSendRow, VisitEmailRecordType, VisitEmailTemplateName } from "@/types/visit-emails";

/**
 * Small additive "last-sent" status line — BUILD-SPEC.md §"Site-visit
 * lifecycle emails" point 6: "lead detail panel + client event rows
 * show last-sent chips ('Confirmation sent 8 Jul · Reminder pending')."
 *
 * Fetches GET /api/visit-emails for the given record and renders the
 * most recent confirmation/reminder status as one compact caption
 * line. Renders nothing while loading, and nothing once loaded with
 * zero logged sends — no visual noise on a lead/event that has never
 * had a visit email fire (most leads/events, most of the time).
 */
export function VisitEmailStatusChips({
  recordType,
  recordId,
}: {
  recordType: VisitEmailRecordType;
  recordId: string;
}) {
  const [sends, setSends] = useState<EmailSendRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/visit-emails?record_type=${recordType}&record_id=${recordId}`)
      .then((r) => (r.ok ? r.json() : { sends: [] }))
      .then((body) => {
        if (!cancelled) setSends(body.sends ?? []);
      })
      .catch(() => {
        if (!cancelled) setSends([]);
      });
    return () => {
      cancelled = true;
    };
  }, [recordType, recordId]);

  if (!sends || sends.length === 0) return null;

  const confirmation = latestFor(sends, "visit-confirmation");
  const reminder = latestFor(sends, "visit-reminder");

  const parts = [
    confirmation ? chipLabel("Confirmation", confirmation) : null,
    reminder ? chipLabel("Reminder", reminder) : null,
  ].filter((p): p is string => !!p);

  if (parts.length === 0) return null;

  return <p className="text-caption text-charcoal/40">{parts.join(" · ")}</p>;
}

/** `sends` arrives newest-first (GET /api/visit-emails orders by
 * created_at desc), so the first match per template is the latest
 * attempt for that template. */
function latestFor(sends: EmailSendRow[], template: VisitEmailTemplateName): EmailSendRow | null {
  return sends.find((s) => s.template === template) ?? null;
}

function chipLabel(label: string, row: EmailSendRow): string {
  if (row.status === "sent" && row.sent_at) {
    return `${label} sent ${shortDate(row.sent_at)}`;
  }
  if (row.status === "pending") {
    return `${label} pending`;
  }
  return `${label} skipped`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", {
    timeZone: "Australia/Adelaide",
    day: "numeric",
    month: "short",
  });
}
