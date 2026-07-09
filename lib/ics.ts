/**
 * RFC 5545 (iCalendar) generation — "Add to calendar" (BUILD-SPEC.md
 * "Phillip's ideas list — 6 July 2026" item 2). Two entry points reuse
 * this: GET /api/leads/[id]/calendar.ics (site visit) and
 * GET /api/client-events/[id]/calendar.ics (client meeting).
 *
 * No new dependency — hand-rolled per RFC 5545 §3. Kept deliberately
 * small: one VEVENT per file, no recurrence, no timezone VTIMEZONE
 * block (see timezone note below).
 *
 * ---------------------------------------------------------------
 * TIMEZONE HANDLING (read this before touching start/end times)
 * ---------------------------------------------------------------
 * RESLU operates out of Adelaide (ACST, UTC+9:30 standard / ACDT,
 * UTC+10:30 daylight-saving). Every date the rest of this codebase
 * stores for a site visit or client event (`leads.site_visit_date`,
 * `client_events.starts_at`/`ends_at`) is a `timestamptz` — Postgres
 * always returns these as real UTC instants (ISO strings with a `Z` or
 * explicit offset), same as everywhere else in this app (see e.g.
 * LeadDetailPanel's `toDateTimeLocal` which does its own local-time
 * rendering from the same ISO value).
 *
 * Because the source value is already an unambiguous UTC instant,
 * generateIcs() below ALWAYS emits DTSTART/DTEND/DTSTAMP in the
 * `YYYYMMDDTHHMMSSZ` UTC form (RFC 5545 §3.3.5's "form #2: date with
 * UTC time"). This is deliberately the simplest correct option:
 *   - No VTIMEZONE/TZID block is needed at all — a bare `Z`-suffixed
 *     UTC timestamp is valid on its own and every mainstream calendar
 *     client (Google, Apple, Outlook) converts it to the viewer's own
 *     local zone automatically.
 *   - It sidesteps ACST/ACDT daylight-saving entirely: had we instead
 *     emitted a floating "Australia/Adelaide" local time, we would
 *     have needed a full VTIMEZONE block with both STANDARD and
 *     DAYLIGHT sub-components (Adelaide observes DST, unlike
 *     Queensland) to avoid the event silently landing an hour off
 *     during the DST transition weeks — extra complexity this small
 *     round doesn't need when "always emit true UTC" is both simpler
 *     and correct year-round.
 *   - The one thing this approach requires (and what callers below
 *     already do): pass genuine UTC-instant ISO strings in, not
 *     "local wall-clock time reinterpreted as UTC". Both call sites
 *     (leads.site_visit_date, client_events.starts_at/ends_at) satisfy
 *     this — they're timestamptz columns read straight from Supabase.
 *
 * If a future feature needs a floating all-day event (no time-of-day
 * at all, e.g. "block out this whole day") that's a different ICS
 * shape (DATE not DATE-TIME) and out of scope here.
 */

export interface IcsAttendee {
  name?: string;
  email: string;
}

export interface CalendarEventInput {
  /** Stable identifier baked into the ICS UID so re-downloading/re-importing the same event updates rather than duplicates it in the recipient's calendar. */
  uid: string;
  title: string;
  /** UTC-instant ISO string (timestamptz from Postgres) — see timezone note above. */
  start: string;
  /** UTC-instant ISO string. Optional — defaults to start + 1 hour if omitted, since a VEVENT needs either DTEND or DURATION to render sensibly in most clients. */
  end?: string | null;
  location?: string | null;
  description?: string | null;
  attendees?: IcsAttendee[];
  /** Organizer line — defaults to the shared RESLU/Aria mailbox, same sender identity as lib/gmail/send.ts's SENDER. */
  organizerEmail?: string;
  organizerName?: string;
}

const DEFAULT_ORGANIZER_EMAIL = "aria@reslu.com.au";
const DEFAULT_ORGANIZER_NAME = "RESLU";

/** RFC 5545 §3.3.5 UTC date-time form: YYYYMMDDTHHMMSSZ. */
function toIcsUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`generateIcs: invalid date "${iso}"`);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma, and
 * newline must be escaped; newlines become the literal two-char
 * sequence `\n` (not a real line break — those are reserved for
 * RFC 5545's own line-folding).
 */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * RFC 5545 §3.1 line folding: lines longer than 75 octets must be
 * folded with CRLF + a leading space. Not strictly required for every
 * client to parse correctly, but cheap to do right — some strict
 * parsers (and the RFC itself) expect it, and a long DESCRIPTION or
 * ATTENDEE list is exactly the case that trips this.
 */
function foldLine(line: string): string {
  const CRLF = "\r\n";
  if (line.length <= 75) return line;
  let result = "";
  let rest = line;
  let first = true;
  while (rest.length > 0) {
    const chunkLen = first ? 75 : 74; // continuation lines lose 1 char to the leading space
    result += (first ? "" : CRLF + " ") + rest.slice(0, chunkLen);
    rest = rest.slice(chunkLen);
    first = false;
  }
  return result;
}

function attendeeLine(a: IcsAttendee): string {
  const cn = a.name ? `;CN=${escapeIcsText(a.name)}` : "";
  return foldLine(`ATTENDEE${cn};RSVP=TRUE:mailto:${a.email}`);
}

/**
 * Builds a complete, single-VEVENT .ics file per RFC 5545. Always
 * returns CRLF line endings (RFC 5545 §3.1 requires CRLF, not bare LF)
 * — callers writing this to an HTTP response should NOT re-normalise
 * line endings.
 */
export function generateIcs(input: CalendarEventInput): string {
  const {
    uid,
    title,
    start,
    end,
    location,
    description,
    attendees = [],
    organizerEmail = DEFAULT_ORGANIZER_EMAIL,
    organizerName = DEFAULT_ORGANIZER_NAME,
  } = input;

  const dtStart = toIcsUtc(start);
  const dtEnd = toIcsUtc(
    end ?? new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString()
  );
  const dtStamp = toIcsUtc(new Date().toISOString());

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RESLU Spec System//Add to Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    foldLine(`UID:${uid}`),
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    foldLine(`SUMMARY:${escapeIcsText(title)}`),
  ];

  if (location) lines.push(foldLine(`LOCATION:${escapeIcsText(location)}`));
  if (description) lines.push(foldLine(`DESCRIPTION:${escapeIcsText(description)}`));

  lines.push(
    foldLine(
      `ORGANIZER;CN=${escapeIcsText(organizerName)}:mailto:${organizerEmail}`
    )
  );
  for (const a of attendees) lines.push(attendeeLine(a));

  lines.push("STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR");

  return lines.join("\r\n") + "\r\n";
}

/**
 * Google Calendar "render" URL (no API/OAuth needed — this is the same
 * link shape Google's own "Add to Calendar" share buttons use).
 * Google's `dates` param wants UTC basic-format timestamps joined by a
 * slash, same DTSTART/DTEND values generateIcs() computes above, so
 * both helpers agree on the same instant.
 *
 * `add` accepts a comma-separated list of attendee emails and opens
 * Google Calendar's own invite UI pre-filled with them — this does NOT
 * silently email anyone; Google still requires the user to hit Save/
 * Send from their own compose screen, same as pasting emails into the
 * guest list manually.
 */
export function googleCalendarUrl(input: CalendarEventInput): string {
  const { title, start, end, location, description, attendees = [] } = input;

  const dtStart = toIcsUtc(start);
  const dtEnd = toIcsUtc(
    end ?? new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString()
  );

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${dtStart}/${dtEnd}`,
  });
  if (description) params.set("details", description);
  if (location) params.set("location", location);
  if (attendees.length > 0) {
    params.set("add", attendees.map((a) => a.email).join(","));
  }

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ============================================================
// Lead flow round (migration 048) — the site-visit INVITE ics
// attached to visit-confirmation.html / visit-reminder.html (Resend
// attachments, see lib/resend.ts), distinct from generateIcs()/
// googleCalendarUrl() above (the existing GET /api/leads/[id]/
// calendar.ics "download my own visit" button + LeadDetailPanel's own
// "Add to calendar" menu — untouched by this round). Two differences
// from generateIcs() that justify dedicated functions rather than
// extending it:
//   - TZID Australia/Adelaide wall-clock time (with a real VTIMEZONE
//     block) instead of generateIcs()'s deliberate bare-UTC-Z choice
//     (see that function's own header comment for why THAT approach is
//     right for its callers) — docs/RESLU-lead-flow-brief.md build
//     task 5 asks for TZID Australia/Adelaide explicitly.
//   - SEQUENCE (RFC 5545 §3.8.7.4) — generateIcs() has never needed
//     one (its callers each generate a single, never-reissued "add
//     this to your calendar" file). This invite is RE-SENT on a
//     reschedule with the SAME UID and an incremented SEQUENCE so
//     Apple Mail/Outlook/Google Calendar update the existing event in
//     place instead of duplicating it — see leads.visit_ics_sequence's
//     migration 048 column comment.
//
// Buffer/base64-encoding for the actual Resend attachment payload
// deliberately does NOT live here — see lib/lead-brief.ts's own header
// comment for why (this file is imported by a "use client" component,
// components/shared/AddToCalendarMenu.tsx; generateVisitIcs()/
// leadVisitGoogleCalendarUrl() below stay plain-string, Node-global-free
// functions like everything else in this file).
// ============================================================

/**
 * Static VTIMEZONE block for Australia/Adelaide — DST-correct for the
 * rule in effect since 2008 (ACST/ACDT transition on the first Sunday
 * of April/October respectively; South Australia has not changed this
 * rule since). Hand-rolled per RFC 5545 §3.6.5, same "no new dependency"
 * convention as the rest of this file.
 */
const ADELAIDE_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Australia/Adelaide",
  "BEGIN:STANDARD",
  "DTSTART:19700405T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU",
  "TZOFFSETFROM:+1030",
  "TZOFFSETTO:+0930",
  "TZNAME:ACST",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19701004T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU",
  "TZOFFSETFROM:+0930",
  "TZOFFSETTO:+1030",
  "TZNAME:ACDT",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
].join("\r\n");

/** UTC ISO instant -> Adelaide-local `YYYYMMDDTHHMMSS` (NO trailing
 * `Z` — paired with a `;TZID=Australia/Adelaide` param on the DTSTART/
 * DTEND line itself, per RFC 5545 §3.3.5's "form #2: date with local
 * time and time zone reference"). Same Intl.DateTimeFormat technique as
 * lib/visit-emails.ts's formatVisitDate()/formatVisitTime(), just
 * reassembled into ICS's compact digit form instead of prose. */
function toAdelaideLocalIcs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`generateVisitIcs: invalid date "${iso}"`);
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Adelaide",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}T${get("hour")}${get("minute")}${get("second")}`;
}

const DEFAULT_ICS_PHONE = "+61 439 870 594";

export interface VisitIcsInput {
  /** Baked into the stable UID `lead-visit-{leadId}@reslu.com.au`. */
  leadId: string;
  /** UTC-instant ISO string — leads.site_visit_date, straight from Postgres. */
  start: string;
  /** UTC-instant ISO string. Optional — defaults to start + 1 hour. */
  end?: string | null;
  /** leads.visit_ics_sequence's CURRENT value at send time (0 for a
   * first booking; the caller increments it BEFORE calling this on a
   * reschedule — see that column's migration 048 comment). */
  sequence: number;
  phone?: string;
}

/**
 * Builds the lead-visit invite.ics attached to both visit-confirmation
 * .html and visit-reminder.html (docs/RESLU-lead-flow-brief.md build
 * task 5). METHOD:PUBLISH, TZID Australia/Adelaide (real VTIMEZONE
 * block), SUMMARY "Site Visit · RESLU", LOCATION "219 Sturt Street,
 * Adelaide SA 5000", ORGANIZER aria@reslu.com.au, stable UID
 * `lead-visit-{leadId}@reslu.com.au`, SEQUENCE per input.
 */
export function generateVisitIcs(input: VisitIcsInput): string {
  const { leadId, start, end, sequence, phone = DEFAULT_ICS_PHONE } = input;

  const dtStartLocal = toAdelaideLocalIcs(start);
  const dtEndLocal = toAdelaideLocalIcs(
    end ?? new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString()
  );
  const dtStamp = toIcsUtc(new Date().toISOString());
  const uid = `lead-visit-${leadId}@reslu.com.au`;
  const safeSequence = Number.isFinite(sequence) ? Math.max(0, Math.floor(sequence)) : 0;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RESLU Spec System//Add to Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ADELAIDE_VTIMEZONE,
    "BEGIN:VEVENT",
    foldLine(`UID:${uid}`),
    `DTSTAMP:${dtStamp}`,
    `DTSTART;TZID=Australia/Adelaide:${dtStartLocal}`,
    `DTEND;TZID=Australia/Adelaide:${dtEndLocal}`,
    `SEQUENCE:${safeSequence}`,
    foldLine(`SUMMARY:${escapeIcsText("Site Visit · RESLU")}`),
    foldLine(`LOCATION:${escapeIcsText("219 Sturt Street, Adelaide SA 5000")}`),
    foldLine(`DESCRIPTION:${escapeIcsText(`With Phillip. Need to move it? Call ${phone}.`)}`),
    foldLine(`ORGANIZER;CN=${escapeIcsText(DEFAULT_ORGANIZER_NAME)}:mailto:${DEFAULT_ORGANIZER_EMAIL}`),
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return lines.join("\r\n") + "\r\n";
}

/**
 * Hand-encodes one query VALUE to match docs/RESLU-lead-flow-brief.md's
 * literal Google Calendar template URL example EXACTLY:
 *
 *   https://calendar.google.com/calendar/render?action=TEMPLATE&text=Site+Visit+%C2%B7+RESLU&dates=<start>/<end>&ctz=Australia/Adelaide&location=219+Sturt+Street,+Adelaide+SA+5000&details=With+Phillip.+Need+to+move+it%3F+Call+%2B61+439+870+594.
 *
 * That example keeps '/' (in `dates=<start>/<end>` and
 * `ctz=Australia/Adelaide`) and ',' (in the location) UN-escaped —
 * `URLSearchParams`/`encodeURIComponent` do NOT do this (both percent-
 * encode '/' to %2F and ',' to %2C, confirmed by hand before writing
 * this), so a generic encoder can't reproduce it. This hand-rolled one
 * matches character-for-character instead: space -> '+', UTF-8
 * percent-encoding for non-ASCII (the '·' in "Site Visit · RESLU"),
 * and '+'/'?'/'&'/'='/'#'/'%' percent-encoded (each would otherwise
 * either collide with the space encoding or break query parsing);
 * every other character — including '/', ',', '.', ':' — passes
 * through raw.
 */
function gcalValueEncode(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === " ") {
      out += "+";
      continue;
    }
    if (ch === "+") {
      out += "%2B";
      continue;
    }
    if (ch === "?") {
      out += "%3F";
      continue;
    }
    if (ch === "&") {
      out += "%26";
      continue;
    }
    if (ch === "=") {
      out += "%3D";
      continue;
    }
    if (ch === "#") {
      out += "%23";
      continue;
    }
    if (ch === "%") {
      out += "%25";
      continue;
    }
    if (ch.codePointAt(0)! > 127) {
      out += encodeURIComponent(ch);
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The `{{calendar_link}}` merge value for the lead-visit emails — the
 * EXACT Google Calendar "render" URL shape docs/RESLU-lead-flow-brief.md
 * build task 5 specifies (fixed text/location/details copy, only the
 * dates vary per visit; default 1-hour duration when `end` is omitted,
 * same as generateVisitIcs()). Distinct from the generic
 * googleCalendarUrl() above (used by LeadDetailPanel's own "Add to
 * calendar" button, out of this round's reason to touch) purely
 * because of the raw-'/'-and-',' encoding quirk — see
 * gcalValueEncode()'s own doc comment.
 */
export function leadVisitGoogleCalendarUrl(
  start: string,
  end?: string | null,
  phone: string = DEFAULT_ICS_PHONE
): string {
  const dtStart = toIcsUtc(start);
  const dtEnd = toIcsUtc(end ?? new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString());
  const text = gcalValueEncode("Site Visit · RESLU");
  const location = gcalValueEncode("219 Sturt Street, Adelaide SA 5000");
  const details = gcalValueEncode(`With Phillip. Need to move it? Call ${phone}.`);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${dtStart}/${dtEnd}&ctz=Australia/Adelaide&location=${location}&details=${details}`;
}
