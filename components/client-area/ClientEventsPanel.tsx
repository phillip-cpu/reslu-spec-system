"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import type { ClientEvent, CreateClientEventInput } from "@/types/phase-12a-b";
import type { InviteeOption } from "@/types/phase-small-round";
import { googleCalendarUrl } from "@/lib/ics";
import { AddToCalendarMenu } from "@/components/shared/AddToCalendarMenu";

/**
 * Team-side client meetings manager (BUILD-SPEC.md §"Portal —
 * upcoming client meetings"): "Team manages from the project client
 * area ... list + add/edit inline, soonest first." Lives as a new tab
 * on the team-side Client area (components/client-area/ClientAreaWorkspace.tsx),
 * alongside Progress photos / Diary / Contracts / Variations /
 * Handover pack.
 *
 * client_events.notes is CLIENT-FACING (shown verbatim on the portal's
 * "Upcoming meetings" card) — unlike trade_visits.notes, which is
 * internal-only. The helper copy below reminds whoever's typing.
 */
export function ClientEventsPanel({ projectId }: { projectId: string }) {
  const [events, setEvents] = useState<ClientEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Add-to-calendar invitee picker (BUILD-SPEC.md "Phillip's ideas
  // list — 6 July 2026" item 2) — same team roster + selection scheme
  // as LeadDetailPanel's. Shared across every row in this list rather
  // than per-row state, since "who to invite" is a team-wide pick, not
  // something that should reset per meeting.
  const [invitees, setInvitees] = useState<InviteeOption[]>([]);
  const [selectedInviteeEmails, setSelectedInviteeEmails] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profiles")
      .then((r) => (r.ok ? r.json() : { profiles: [] }))
      .then((body) => {
        if (!cancelled) setInvitees(body.profiles ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleInvitee(email: string) {
    setSelectedInviteeEmails((cur) =>
      cur.includes(email) ? cur.filter((e) => e !== email) : [...cur, email]
    );
  }

  async function load() {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-events`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load meetings.");
      const data = await res.json();
      setEvents(data.events ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load meetings.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function createEvent(input: CreateClientEventInput) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add meeting.");
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add meeting.");
    }
  }

  async function patchEvent(id: string, patch: Partial<CreateClientEventInput>) {
    setError(null);
    try {
      const res = await fetch(`/api/client-events/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save meeting.");
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save meeting.");
    }
  }

  async function deleteEvent(id: string, title: string) {
    if (!confirm(`Remove "${title}"?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/client-events/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not remove meeting.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove meeting.");
    }
  }

  const now = Date.now();
  const upcoming = (events ?? []).filter((e) => new Date(e.starts_at).getTime() >= now);
  const past = (events ?? []).filter((e) => new Date(e.starts_at).getTime() < now);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <p className="text-body text-charcoal/60">
          Shown on the client portal as &quot;Upcoming meetings&quot;. Notes here are
          client-facing — write them as you would any portal copy. A reminder
          email sends the day before (if client notifications are on).
        </p>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="shrink-0 bg-nearblack px-3 py-1.5 text-caption text-white hover:bg-charcoal"
          >
            + Add meeting
          </button>
        )}
      </div>

      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      {adding && <EventForm onCancel={() => setAdding(false)} onSave={createEvent} />}

      {events === null ? (
        <p className="text-body text-charcoal/50">Loading…</p>
      ) : upcoming.length === 0 && !adding ? (
        <p className="text-body text-charcoal/50">No meetings scheduled yet.</p>
      ) : (
        <ul className="space-y-2">
          {upcoming.map((e) =>
            editingId === e.id ? (
              <li key={e.id} className="border border-[#c9c2b4] bg-nearwhite p-3">
                <EventForm
                  initial={e}
                  onCancel={() => setEditingId(null)}
                  onSave={(patch) => patchEvent(e.id, patch)}
                />
              </li>
            ) : (
              <EventRow
                key={e.id}
                event={e}
                onEdit={() => setEditingId(e.id)}
                onDelete={() => deleteEvent(e.id, e.title)}
                invitees={invitees}
                selectedInviteeEmails={selectedInviteeEmails}
                onToggleInvitee={toggleInvitee}
              />
            )
          )}
        </ul>
      )}

      {past.length > 0 && (
        <details className="border-t border-[#dcd6cc] pt-4">
          <summary className="cursor-pointer label-caps !text-charcoal/40">Past meetings · {past.length}</summary>
          <ul className="mt-3 space-y-2">
            {past.map((e) => (
              <EventRow
                key={e.id}
                event={e}
                muted
                onDelete={() => deleteEvent(e.id, e.title)}
                invitees={invitees}
                selectedInviteeEmails={selectedInviteeEmails}
                onToggleInvitee={toggleInvitee}
              />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function EventRow({
  event,
  muted,
  onEdit,
  onDelete,
  invitees,
  selectedInviteeEmails,
  onToggleInvitee,
}: {
  event: ClientEvent;
  muted?: boolean;
  onEdit?: () => void;
  onDelete: () => void;
  invitees?: InviteeOption[];
  selectedInviteeEmails?: string[];
  onToggleInvitee?: (email: string) => void;
}) {
  const start = new Date(event.starts_at);
  const dateLabel = start.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  const timeLabel = start.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  const attendeeEmails = selectedInviteeEmails ?? [];

  return (
    <li
      className={clsx(
        "flex items-start justify-between gap-3 border px-4 py-3",
        muted ? "border-[#e5e0d6] bg-transparent" : "border-[#dcd6cc] bg-offwhite"
      )}
    >
      <div className="min-w-0">
        <p className={clsx("text-subhead", muted ? "text-charcoal/50" : "text-nearblack")}>{event.title}</p>
        <p className="mt-0.5 text-caption text-charcoal/60">
          {dateLabel} · {timeLabel}
          {event.location ? ` · ${event.location}` : ""}
        </p>
        {event.notes && <p className="mt-1 text-caption text-charcoal/50">{event.notes}</p>}
        {/* Add to calendar (BUILD-SPEC.md "Phillip's ideas list — 6 July
            2026" item 2) — offered on every row, past or upcoming
            (a past meeting can still be worth adding for record-keeping). */}
        <div className="mt-2">
          <AddToCalendarMenu
            icsUrl={`/api/client-events/${event.id}/calendar.ics${
              attendeeEmails.length ? `?attendees=${encodeURIComponent(attendeeEmails.join(","))}` : ""
            }`}
            googleUrl={googleCalendarUrl({
              uid: `client-event-${event.id}@reslu.com.au`,
              title: event.title,
              start: event.starts_at,
              end: event.ends_at,
              location: event.location ?? undefined,
              description: event.notes ?? undefined,
              attendees: attendeeEmails.map((email) => ({ email })),
            })}
            invitees={invitees}
            selectedInviteeEmails={selectedInviteeEmails}
            onToggleInvitee={onToggleInvitee}
          />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {onEdit && (
          <button type="button" onClick={onEdit} className="text-caption text-charcoal/60 hover:text-nearblack">
            Edit
          </button>
        )}
        <button type="button" onClick={onDelete} className="text-caption text-charcoal/40 hover:text-red-700">
          Remove
        </button>
      </div>
    </li>
  );
}

function toLocalInputValue(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EventForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ClientEvent;
  onSave: (input: CreateClientEventInput) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [startsAt, setStartsAt] = useState(toLocalInputValue(initial?.starts_at));
  const [endsAt, setEndsAt] = useState(toLocalInputValue(initial?.ends_at ?? undefined));
  const [location, setLocation] = useState(initial?.location ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !startsAt) return;
    setSaving(true);
    try {
      onSave({
        title: title.trim(),
        starts_at: new Date(startsAt).toISOString(),
        ends_at: endsAt ? new Date(endsAt).toISOString() : null,
        location: location.trim() || null,
        notes: notes.trim() || null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border border-[#c9c2b4] bg-nearwhite p-4">
      <label className="flex flex-col gap-1">
        <span className="label-caps">Title</span>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Selections meeting — studio"
          className="border border-[#c9c2b4] bg-white px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="label-caps">Starts</span>
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="border border-[#c9c2b4] bg-white px-3 py-2 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">Ends (optional)</span>
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className="border border-[#c9c2b4] bg-white px-3 py-2 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Location</span>
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="RESLU studio"
          className="border border-[#c9c2b4] bg-white px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Notes (client-facing)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Anything the client should bring or expect"
          className="border border-[#c9c2b4] bg-white px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving || !title.trim() || !startsAt}
          className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="text-caption text-charcoal/60 hover:text-nearblack">
          Cancel
        </button>
      </div>
    </form>
  );
}
