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
