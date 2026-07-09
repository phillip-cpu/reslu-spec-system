// ============================================================
// RESLU Spec System — Lead flow round (migration 048) support helpers.
// docs/RESLU-lead-flow-brief.md: the tokenised /brief/[token] link, and
// the {{calendar_link}} + invite.ics pair attached to both visit-
// confirmation.html and visit-reminder.html.
//
// Kept out of lib/ics.ts: this module uses node:crypto (randomBytes)
// and Buffer (base64-encoding the ics for a Resend attachment) —
// lib/ics.ts is imported by a "use client" component
// (components/shared/AddToCalendarMenu.tsx) and deliberately stays
// free of any Node-only global so that import never risks pulling one
// into the client bundle. This module is server-only (imported only
// from app/api/leads/**, app/api/visit-emails/run/route.ts), same
// "server-only by construction, unenforced-by-tooling convention" this
// codebase already documents on lib/visit-emails.ts's own header.
//
// Kept out of lib/visit-emails.ts too: that module is transport +
// merge + guard/window logic ONLY, by its own header comment — "never
// queries leads or client_events itself." ensureBriefToken() below
// does exactly that (a lazy token mint + write), so it belongs at the
// trigger call sites' own DB-touching layer, not inside the shared
// send module.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { generateVisitIcs, leadVisitGoogleCalendarUrl } from "@/lib/ics";
import type { ResendAttachment } from "@/lib/resend";
import { reportError } from "@/lib/report-error";

/**
 * Builds the public /brief/[token] URL for a given token — same
 * appUrl-trim-plus-token shape as lib/portal-link.ts's portalUrlFor()/
 * app/api/trade-reminders/route.ts's trade link (NEXT_PUBLIC_APP_URL,
 * falling back to VERCEL_URL, falling back to the production domain).
 */
export function briefUrlFor(token: string): string {
  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    "https://spec.reslu.com.au"
  ).replace(/\/+$/, "");
  return `${appUrl}/brief/${token}`;
}

/**
 * Returns the lead's existing `brief_token`, or mints + stores a fresh
 * one (64-char hex, `crypto.randomBytes(32)` — same shape as
 * lib/projects.ts's client_token regeneration / trade_visits'
 * confirm_token) if it has none yet.
 *
 * docs/RESLU-lead-flow-brief.md build task 1: "one token per lead" —
 * generated LAZILY (per this round's own BUILD instructions: "Token:
 * generated lazily when the reminder email builds {{brief_link}}"),
 * not at lead creation, so a lead that never reaches the reminder step
 * (e.g. marked Lost first) never has an unused, unguessable token
 * sitting on its record for no reason.
 */
export async function ensureBriefToken(
  supabase: SupabaseClient,
  leadId: string,
  currentToken: string | null
): Promise<string> {
  if (currentToken) return currentToken;
  const token = randomBytes(32).toString("hex");
  const { error } = await supabase.from("leads").update({ brief_token: token }).eq("id", leadId);
  if (error) {
    // Don't hand back a token that isn't actually persisted — the
    // caller would bake it into {{brief_link}} and send a link that
    // 404s forever, with no record anywhere that this happened.
    await reportError("visit-emails", error);
    throw new Error(`Could not persist brief_token for lead ${leadId}: ${error.message}`);
  }
  return token;
}

export interface LeadVisitCalendarAssets {
  calendarLink: string;
  icsAttachment: ResendAttachment;
}

/**
 * Builds BOTH the `{{calendar_link}}` merge value and the `invite.ics`
 * Resend attachment for one lead-visit send (confirmation or
 * reminder) — the three call sites that fire a lead-visit email
 * (app/api/leads/[id]/route.ts's PATCH, app/api/leads/route.ts's POST,
 * app/api/visit-emails/run/route.ts's reminder sweep) all need exactly
 * this pair, so it is centralised here rather than hand-copied three
 * times. `sequence` must already be the value the caller wants baked
 * into THIS send (see leads.visit_ics_sequence's migration 048 comment
 * for when/where it gets incremented — that happens at the call site,
 * BEFORE calling this).
 */
export function buildLeadVisitCalendarAssets(
  leadId: string,
  visitDatetime: string,
  sequence: number,
  phone?: string
): LeadVisitCalendarAssets {
  const calendarLink = leadVisitGoogleCalendarUrl(visitDatetime, null, phone);
  const ics = generateVisitIcs({ leadId, start: visitDatetime, sequence, phone });
  return {
    calendarLink,
    icsAttachment: {
      filename: "invite.ics",
      content: Buffer.from(ics, "utf8").toString("base64"),
    },
  };
}
