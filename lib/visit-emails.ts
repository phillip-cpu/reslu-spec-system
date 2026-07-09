// ============================================================
// RESLU Spec System — Site-visit lifecycle emails
// docs/RESLU-Spec-Visit-Emails-Brief.md + BUILD-SPEC.md §"Site-visit
// lifecycle emails": client-facing "your site visit is booked" /
// "your site visit is tomorrow" emails, for BOTH lead site visits
// (leads.site_visit_date) and project client_events (starts_at).
//
// Server-only by construction (reads process.env.RESEND_API_KEY, reads
// template files off disk, imports the Supabase client type) — never
// import this from a "use client" component, same unenforced-by-
// tooling convention as lib/gmail/send.ts (this codebase has no
// "server-only" package dependency; BUILD-SPEC.md prefers zero new
// deps, so this is a documented convention, not a build-time guard).
//
// This module is transport + merge + guard/window logic ONLY. The
// actual DB reads that build a send's `to`/mergeData (looking up a
// lead's email, a project's client_email, etc.) live at each trigger's
// call site (app/api/leads/[id]/route.ts, app/api/projects/[id]/
// client-events/route.ts, app/api/visit-emails/run/route.ts) — this
// module never queries `leads` or `client_events` itself, only
// `email_sends`.
// ============================================================

import { readFile } from "fs/promises";
import path from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportError } from "@/lib/report-error";
import type {
  VisitEmailDetail,
  VisitEmailRecordType,
  VisitEmailTemplateName,
} from "@/types/visit-emails";

const ADELAIDE_TZ = "Australia/Adelaide";

// ------------------------------------------------------------
// Templates — read from disk at runtime (emails/*.html, see that
// folder's own README.md for the install step), cached in-module so a
// warm serverless instance doesn't re-read the file on every send.
// ------------------------------------------------------------

const TEMPLATE_FILES: Record<VisitEmailTemplateName, string> = {
  "visit-confirmation": "visit-confirmation.html",
  "visit-reminder": "visit-reminder.html",
};

const templateCache = new Map<VisitEmailTemplateName, string>();

/**
 * Reads emails/<name>.html off disk (relative to the repo root,
 * `process.cwd()` at runtime — Next.js API routes run with cwd at the
 * project root both locally and on Vercel). Cached after first read.
 * Throws if the file is missing — callers (sendOrQueue below) catch
 * this and log a 'skipped' email_sends row rather than crashing the
 * trigger's primary action (see this file's header + emails/README.md
 * "INSTALL STEP": these ship as placeholders until CC copies the real
 * files from the website repo).
 */
export async function loadTemplate(name: VisitEmailTemplateName): Promise<string> {
  const cached = templateCache.get(name);
  if (cached !== undefined) return cached;
  const filePath = path.join(process.cwd(), "emails", TEMPLATE_FILES[name]);
  const html = await readFile(filePath, "utf8");
  templateCache.set(name, html);
  return html;
}

// ------------------------------------------------------------
// Merge
// ------------------------------------------------------------

const DEFAULT_PHILLIP_PHONE = "+61 439 870 594";

export interface VisitEmailMergeData {
  first_name?: string | null;
  last_name?: string | null;
  /** e.g. "Tuesday 15 July" — see formatVisitDate() below. */
  visit_date?: string | null;
  /** e.g. "10:00am" — see formatVisitTime() below. */
  visit_time?: string | null;
  suburb?: string | null;
  phillip_phone?: string | null;
}

/**
 * Simple global `{{placeholder}}` replace — blank-safe (a missing/null
 * field renders as an empty string, never "undefined" or "null" text,
 * and never throws on a template that references a key this call site
 * didn't supply). Placeholders not present in `data` at all are left
 * untouched in the output rather than blanked, so a future template
 * placeholder this module doesn't yet know about fails visibly (still
 * literally `{{whatever}}` in the sent email) instead of silently
 * vanishing.
 */
export function merge(html: string, data: VisitEmailMergeData): string {
  const values: Partial<Record<string, string>> = {
    first_name: data.first_name ?? "",
    last_name: data.last_name ?? "",
    visit_date: data.visit_date ?? "",
    visit_time: data.visit_time ?? "",
    suburb: data.suburb ?? "",
    phillip_phone: data.phillip_phone ?? DEFAULT_PHILLIP_PHONE,
  };
  return html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key: string) => {
    const v = values[key];
    return v === undefined ? whole : v;
  });
}

// ------------------------------------------------------------
// Suburb heuristic — HONEST CAVEAT: leads.location / leads.
// site_visit_location / client_events.location are all free text, not
// a structured address. There is no geocoder here, no street-database
// lookup — this is best-effort string surgery, and will occasionally
// return '' or an over/under-trimmed guess for an unusually formatted
// address. Callers must treat an empty suburb as "omit gracefully in
// the merged copy" (the template's {{suburb}} placeholder simply
// renders blank), never as a bug to chase.
// ------------------------------------------------------------

const STATE_TOKENS = new Set(["SA", "NSW", "VIC", "QLD", "WA", "TAS", "NT", "ACT"]);

function isStateOrPostcodeToken(token: string): boolean {
  const t = token.trim().toUpperCase().replace(/,+$/, "");
  if (!t) return false;
  if (STATE_TOKENS.has(t)) return true;
  if (/^\d{4}$/.test(t)) return true;
  return false;
}

/**
 * Best-effort suburb extraction from a free-text address/location
 * string. Two strategies, in order:
 *   1. Comma-separated input (e.g. "12 Smith St, Norwood, SA 5067"):
 *      walk segments from the end, skipping any segment that is
 *      PURELY state/postcode tokens (a segment can carry both on one
 *      line, e.g. "Norwood SA 5067" — strip the trailing state/
 *      postcode words and keep what's left of that segment).
 *   2. No commas (e.g. "12 Smith St Norwood SA 5067"): strip any
 *      trailing state/postcode tokens off the whole string, then take
 *      the last one or two remaining words as the suburb.
 * Returns '' when neither strategy yields anything usable (e.g. the
 * input is empty, or is itself nothing but a state/postcode).
 */
export function suburbFrom(location: string | null | undefined): string {
  if (!location) return "";
  const raw = location.trim();
  if (!raw) return "";

  if (raw.includes(",")) {
    const segments = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const words = segments[i].split(/\s+/).filter(Boolean);
      const meaningfulWords = words.filter((w) => !isStateOrPostcodeToken(w));
      if (meaningfulWords.length > 0) {
        return meaningfulWords.join(" ");
      }
    }
    return "";
  }

  const words = raw.split(/\s+/).filter(Boolean);
  let end = words.length;
  while (end > 0 && isStateOrPostcodeToken(words[end - 1])) end--;
  if (end === 0) return "";
  const start = Math.max(0, end - 2);
  return words.slice(start, end).join(" ");
}

// ------------------------------------------------------------
// Adelaide date/time — DST-safe throughout via Intl.DateTimeFormat,
// same technique this codebase already uses (app/api/digest/flush's
// DIGEST_HOURS gate, lib/daily-brief-generate.ts's adelaideToday()) —
// never a fixed UTC-offset constant, since Adelaide observes daylight
// saving (ACST +9:30 roughly Apr-Oct, ACDT +10:30 roughly Oct-Apr).
// ------------------------------------------------------------

/** Adelaide-local hour (0-23) for `now`. */
export function adelaideHour(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: ADELAIDE_TZ,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now)
  );
}

function adelaideMinute(now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-AU", { timeZone: ADELAIDE_TZ, minute: "2-digit" }).format(now)
  );
}

/** Adelaide-local calendar date as yyyy-mm-dd (sortable, re-parseable). */
export function adelaideDateString(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ADELAIDE_TZ }).format(now);
}

/** yyyy-mm-dd string, `days` days after `dateStr` — plain UTC calendar
 * math on the Y/M/D components (safe: calendar-day arithmetic has no
 * DST wrinkle, only instant<->local CONVERSION does, which is why this
 * helper never touches an actual Date-with-time). */
export function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * True when `now` falls inside the 7:00am-7:00pm Adelaide sending
 * window (brief: "Never send outside 7am-7pm Adelaide time"). Half-open
 * [7, 19) — 7:00:00pm itself is just outside, matching how every other
 * hour-gate in this codebase treats its boundary (e.g. digest flush's
 * exact-hour DIGEST_HOURS match).
 */
export function isWithinSendWindow(now: Date = new Date()): boolean {
  const hour = adelaideHour(now);
  return hour >= 7 && hour < 19;
}

/**
 * The UTC instant of hour:00:00 Adelaide-local on the given yyyy-mm-dd
 * calendar date. Iterative-correction technique: start from a fixed
 * ACST (+9:30) guess, then re-check which Adelaide-local date/hour that
 * guess actually lands on and nudge — converges in at most 2-3 steps
 * since ACST/ACDT differ by exactly one hour and the calendar-date
 * guess is never off by more than a day. Avoids parsing Intl's
 * `GMT+9:30` offset string, which is a valid alternative but more
 * fragile across ICU versions/locales.
 */
function adelaideHourInstantUtc(dateStr: string, hour: number): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  let candidate = new Date(Date.UTC(y, m - 1, d, hour, 0, 0) - 9.5 * 60 * 60 * 1000);
  for (let i = 0; i < 4; i++) {
    const landedDate = adelaideDateString(candidate);
    const landedHour = adelaideHour(candidate);
    const landedMinute = adelaideMinute(candidate);
    if (landedDate === dateStr && landedHour === hour && landedMinute === 0) break;
    const dayDeltaMs =
      landedDate < dateStr ? 24 * 60 * 60 * 1000 : landedDate > dateStr ? -24 * 60 * 60 * 1000 : 0;
    const minuteDeltaMs = ((hour - landedHour) * 60 - landedMinute) * 60 * 1000;
    candidate = new Date(candidate.getTime() + dayDeltaMs + minuteDeltaMs);
  }
  return candidate;
}

/** The next 7:00am Adelaide-local instant strictly after `now`, as a
 * UTC Date — used to schedule a send queued outside the window. */
export function nextAdelaide7am(now: Date = new Date()): Date {
  const today = adelaideDateString(now);
  const dayOffset = adelaideHour(now) >= 7 ? 1 : 0;
  const targetDate = dayOffset === 0 ? today : addDaysToDateString(today, 1);
  return adelaideHourInstantUtc(targetDate, 7);
}

/** [start, end) UTC instants spanning one Adelaide-local calendar date
 * — used to query timestamptz columns (site_visit_date, starts_at) for
 * "everything happening on this Adelaide day". */
export function adelaideDayRangeUtc(dateStr: string): { start: Date; end: Date } {
  const start = adelaideHourInstantUtc(dateStr, 0);
  const end = adelaideHourInstantUtc(addDaysToDateString(dateStr, 1), 0);
  return { start, end };
}

/** "Tuesday 15 July" — no comma (unlike Intl's default en-AU long-date
 * rendering, which inserts one between weekday and day) — matches the
 * brief's own {{visit_date}} example exactly. */
export function formatVisitDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: ADELAIDE_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).formatToParts(new Date(iso));
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${weekday} ${day} ${month}`.trim();
}

/** "10:00am" — built from formatToParts (24h) rather than trusting
 * Intl's own 12h rendering, whose am/pm spacing/casing varies by ICU
 * version ("10:00 AM" vs "10:00 am" vs "10:00am") — this guarantees the
 * exact lowercase-no-space form the brief's {{visit_time}} example uses. */
export function formatVisitTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: ADELAIDE_TZ,
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const hour24 = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const period = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minute}${period}`;
}

// ------------------------------------------------------------
// Resend transport — plain fetch, no SDK (BUILD-SPEC.md decision).
// ------------------------------------------------------------

const RESEND_FROM = "Phillip — RESLU <visits@reslu.com.au>";
const RESEND_REPLY_TO = "phillip@reslu.com.au";

export interface ResendSendResult {
  skipped: boolean;
  reason?: string;
}

export function isResendConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/**
 * Sends one HTML email via Resend's REST API. No-op ({ skipped: true,
 * reason: 'no RESEND_API_KEY' }) when the key isn't configured — mirrors
 * lib/gmail/send.ts's isGmailConfigured() no-op contract, so callers
 * (sendOrQueue below) stay dormant until an on-machine engineer sets
 * RESEND_API_KEY, exactly like every other email integration in this
 * codebase. Real send failures (bad key, Resend API error) DO throw —
 * callers must not mark a row 'sent' on a failed call.
 */
export async function sendViaResend({
  to,
  subject,
  html,
}: {
  to: string[];
  subject: string;
  html: string;
}): Promise<ResendSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true, reason: "no RESEND_API_KEY" };
  if (to.length === 0) return { skipped: true, reason: "No recipients" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to,
      reply_to: RESEND_REPLY_TO,
      subject,
      html,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return { skipped: false };
}

// ------------------------------------------------------------
// Lead surname heuristic (duplicated, deliberately, from the private
// extractSurname() in app/api/leads/[id]/create-project/route.ts — that
// function isn't exported and that route is outside this round's
// reason to touch; same simple "split on the first em-dash/hyphen"
// best-effort logic, not a full name parser, matching that file's own
// documented caveat).
// ------------------------------------------------------------
export function leadLastName(surnameProject: string): string {
  const match = /\s+[—-]\s+/.exec(surnameProject);
  if (!match) return surnameProject.trim();
  return surnameProject.slice(0, match.index).trim();
}

// ------------------------------------------------------------
// email_sends orchestration — guard, window, log.
// ------------------------------------------------------------

export interface SendOrQueueInput {
  recordType: VisitEmailRecordType;
  recordId: string;
  template: VisitEmailTemplateName;
  to: string[];
  subject: string;
  mergeData: VisitEmailMergeData;
  /** ISO timestamp of the visit this send is for — both merged into the
   * template's own placeholders (via visit_date/visit_time, already
   * pre-formatted onto mergeData by the caller) AND stored raw as the
   * re-send guard's comparison key. */
  visitDatetime: string;
  now?: Date;
}

export type SendOrQueueAction = "sent" | "queued" | "skipped" | "duplicate";

export interface SendOrQueueResult {
  action: SendOrQueueAction;
  reason?: string;
}

/**
 * The single entry point every trigger (lead PATCH, client_events POST,
 * the reminder cron sweep) calls to fire a visit email. Handles, in
 * order:
 *
 *   1. GUARD — skip as 'duplicate' if a 'sent' row already exists for
 *      this exact (record_type, record_id, template) whose logged
 *      detail.visit_datetime equals the CURRENT visit datetime (brief:
 *      "Send once ... re-send only if date/time changed, with the same
 *      template"). A 'sent' row logged against a DIFFERENT datetime
 *      (the visit was rescheduled since) does not block a fresh send —
 *      this is what makes editing a visit's date/time correctly
 *      trigger exactly one new confirmation.
 *   2. TEMPLATE LOAD — a missing/unreadable template file never crashes
 *      the caller's primary action (saving a lead, creating a client
 *      event); it logs a 'skipped' row and returns cleanly (see
 *      emails/README.md's INSTALL STEP — the shipped files are
 *      placeholders until copied from the website repo).
 *   3. WINDOW — inside 7am-7pm Adelaide: send immediately via Resend,
 *      log 'sent' (or 'skipped' if RESEND_API_KEY isn't set, or
 *      'pending'+retry-scheduled if the Resend call itself throws).
 *      Outside the window: log 'pending' with scheduled_for = next 7am
 *      Adelaide, picked up later by flushPendingSends().
 */
export async function sendOrQueue(
  supabase: SupabaseClient,
  input: SendOrQueueInput
): Promise<SendOrQueueResult> {
  const { recordType, recordId, template, to, subject, mergeData, visitDatetime } = input;
  const now = input.now ?? new Date();

  if (to.length === 0) {
    return { action: "skipped", reason: "No recipient email on file" };
  }

  const { data: existingSent } = await supabase
    .from("email_sends")
    .select("id,detail")
    .eq("record_type", recordType)
    .eq("record_id", recordId)
    .eq("template", template)
    .eq("status", "sent")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const existingDetail = (existingSent?.detail ?? null) as VisitEmailDetail | null;
  if (existingSent && existingDetail?.visit_datetime === visitDatetime) {
    return { action: "duplicate", reason: "Already sent for this visit date/time" };
  }

  const detail: VisitEmailDetail = { ...mergeData, subject, visit_datetime: visitDatetime };

  let html: string;
  try {
    html = merge(await loadTemplate(template), mergeData);
  } catch (err) {
    await reportError("visit-emails", err);
    await supabase.from("email_sends").insert({
      record_type: recordType,
      record_id: recordId,
      template,
      to_email: to.join(", "),
      status: "skipped",
      detail: { ...detail, reason: "Template file missing or unreadable" },
    });
    return { action: "skipped", reason: "Template load failed" };
  }

  if (!isWithinSendWindow(now)) {
    await supabase.from("email_sends").insert({
      record_type: recordType,
      record_id: recordId,
      template,
      to_email: to.join(", "),
      status: "pending",
      scheduled_for: nextAdelaide7am(now).toISOString(),
      detail,
    });
    return { action: "queued", reason: "Outside 7am-7pm Adelaide window" };
  }

  try {
    const result = await sendViaResend({ to, subject, html });
    if (result.skipped) {
      await supabase.from("email_sends").insert({
        record_type: recordType,
        record_id: recordId,
        template,
        to_email: to.join(", "),
        status: "skipped",
        detail: { ...detail, reason: result.reason },
      });
      return { action: "skipped", reason: result.reason };
    }
    await supabase.from("email_sends").insert({
      record_type: recordType,
      record_id: recordId,
      template,
      to_email: to.join(", "),
      status: "sent",
      sent_at: now.toISOString(),
      detail,
    });
    return { action: "sent" };
  } catch (err) {
    await reportError("visit-emails", err);
    // A real send failure (not a config no-op) — queue for the next
    // flush pass rather than losing it, same "never crash the caller's
    // primary action, never silently drop a real send" contract as the
    // rest of this module.
    await supabase.from("email_sends").insert({
      record_type: recordType,
      record_id: recordId,
      template,
      to_email: to.join(", "),
      status: "pending",
      scheduled_for: now.toISOString(),
      detail: { ...detail, reason: "Send failed, queued for retry" },
    });
    return { action: "queued", reason: "Send failed, queued for retry" };
  }
}

export interface FlushPendingResult {
  sent: number;
  skipped: number;
  failed: number;
  stillPending: number;
}

/**
 * Flushes every due ('pending', scheduled_for <= now) email_sends row.
 * A no-op returning all-zeros outside the 7am-7pm Adelaide window (a
 * pending row's scheduled_for is already aligned to the next 7am
 * Adelaide by sendOrQueue, so this should rarely even be called outside
 * the window, but the check is defensive — a retry-queued row's
 * scheduled_for is `now` at failure time, which could itself be right
 * at the window's edge).
 *
 * Regenerates the HTML from the row's own `detail` snapshot + the
 * CURRENT template file on every flush (not a stored html blob) — so a
 * template fixed/replaced after a row was queued is picked up
 * automatically, and detail stays a small, inspectable merge snapshot
 * rather than a large duplicated HTML string.
 */
export async function flushPendingSends(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<FlushPendingResult> {
  const result: FlushPendingResult = { sent: 0, skipped: 0, failed: 0, stillPending: 0 };

  if (!isWithinSendWindow(now)) {
    return result;
  }

  const { data: rows, error } = await supabase
    .from("email_sends")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_for", now.toISOString());

  if (error) {
    throw new Error(error.message);
  }

  for (const row of rows ?? []) {
    const detail = (row.detail ?? {}) as VisitEmailDetail;
    const template = row.template as VisitEmailTemplateName;
    const to = String(row.to_email)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const html = merge(await loadTemplate(template), detail);
      const sendResult = await sendViaResend({
        to,
        subject: detail.subject ?? "RESLU — your site visit",
        html,
      });
      if (sendResult.skipped) {
        await supabase.from("email_sends").update({ status: "skipped" }).eq("id", row.id);
        result.skipped++;
        continue;
      }
      await supabase
        .from("email_sends")
        .update({ status: "sent", sent_at: now.toISOString() })
        .eq("id", row.id);
      result.sent++;
    } catch (err) {
      await reportError("visit-emails", err);
      result.failed++;
      result.stillPending++;
      // Leave status = 'pending' — retried on the next in-window run.
    }
  }

  return result;
}

/**
 * Marks every still-'pending' email_sends row for a record as
 * 'skipped' — called when a site visit / client event is cancelled
 * before its queued email went out (brief: "If a visit is cancelled
 * before the reminder fires, don't send it"). Rows already 'sent' are
 * left untouched — the email already reached the client; there is
 * nothing to undo.
 */
export async function cancelPendingSends(
  supabase: SupabaseClient,
  recordType: VisitEmailRecordType,
  recordId: string
): Promise<void> {
  await supabase
    .from("email_sends")
    .update({ status: "skipped" })
    .eq("record_type", recordType)
    .eq("record_id", recordId)
    .eq("status", "pending");
}
