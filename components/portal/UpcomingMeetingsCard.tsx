import type { PortalClientEvent } from "@/app/portal/types";

/**
 * "Upcoming meetings" card (BUILD-SPEC.md §"Portal — upcoming client
 * meetings"): "Portal: 'Upcoming meetings' card beside What's Next —
 * date, time, location, notes; past events drop off." Sits directly
 * below WhatsNextBlock (same offwhite band styling, same max-width
 * container) — "beside" is read here as "immediately adjacent to,
 * same visual band", since the portal's WhatsNextBlock is a single
 * full-width block above the sticky nav, not a two-column layout this
 * card could sit literally beside without changing that block's own
 * markup (out of this task's file boundary concerns — WhatsNextBlock
 * itself is untouched, only the page composing it is edited to also
 * render this card alongside it).
 *
 * Only ever receives FUTURE events — the portal page's query already
 * filters `starts_at >= now` before this component ever sees the list
 * (see app/portal/[token]/page.tsx), so this component has no
 * date-filtering logic of its own to keep in sync with that query.
 * Renders nothing when there are no upcoming meetings, matching
 * WhatsNextBlock's own "renders nothing when there's genuinely nothing
 * scheduled" convention.
 */
export function UpcomingMeetingsCard({ events }: { events: PortalClientEvent[] }) {
  if (events.length === 0) return null;

  return (
    <div className="border-b border-[#dcd6cc] bg-offwhite px-6 py-6">
      <div className="mx-auto max-w-4xl">
        <p className="label-caps mb-3 !text-sand">Upcoming meetings</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {events.map((e) => (
            <MeetingCard key={e.id} event={e} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MeetingCard({ event }: { event: PortalClientEvent }) {
  const start = new Date(event.starts_at);
  const dateLabel = start.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const startTime = start.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  const timeLabel = event.ends_at
    ? `${startTime} – ${new Date(event.ends_at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}`
    : startTime;

  return (
    <div className="border border-[#dcd6cc] bg-cream p-4">
      <p className="text-subhead text-nearblack">{event.title}</p>
      <p className="mt-1 text-body text-charcoal/80">
        {dateLabel} · {timeLabel}
      </p>
      {event.location && <p className="mt-1 text-caption text-charcoal/50">{event.location}</p>}
      {event.notes && <p className="mt-2 text-caption text-charcoal/60">{event.notes}</p>}
    </div>
  );
}
