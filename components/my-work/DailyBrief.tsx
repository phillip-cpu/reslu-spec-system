"use client";

import { useEffect, useState } from "react";
import type { BriefResponse, DailyBriefItemWithMeta, DailyBriefSource } from "@/types/round-daily-brief";

/**
 * Daily Brief panel (migration 041, Phillip 8 July 2026) — BUILD-SPEC.md
 * §"Daily Brief": "My Work page = Daily Brief panel FIRST, then the My
 * Work groups." Sticky-note acknowledgement layer: ticking means
 * "seen/handled", it NEVER completes the underlying record — "open ->"
 * deep links are how you action the real thing.
 *
 * Admin-only in v1 (see GET /api/brief's own doc comment for the full
 * rationale) — a 403 here is treated as "nothing to render", not an
 * error banner, so a non-admin's My Work page simply shows the
 * existing groups with no Daily Brief section at all, same as how
 * MyWorkWorkspace already hides the lead_follow_up/ordering_due
 * sources from a non-admin without a visible "you can't see this" note.
 */
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDateHeader(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`;
}

function formatRefreshedAt(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const period = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${period}`;
}

const SOURCE_LABEL: Record<DailyBriefSource, string> = {
  booking: "Booking",
  ordering: "Ordering",
  lead: "Lead",
  trade: "Trade",
  email: "Email",
  invoice: "Invoice",
  manual: "Manual",
  aria: "Aria",
  // QA fix round (r27) item 14 — "proposal" was already a valid
  // daily_brief_items.source value (migration 051 widened the DB CHECK
  // constraint for POST /api/proposal/[token]/accept's own "Proposal
  // accepted — {residence}" attention row) but this map — the actual
  // label a Daily Brief row renders — never got the matching entry, so
  // an accepted-proposal item rendered with no source pill at all
  // (Record<DailyBriefSource, string> is exhaustive; this was silently
  // missing rather than a build error only because lib/daily-brief.ts's
  // own DailyBriefSource union hadn't been widened to include it either
  // — see that file's own comment on the same gap, fixed alongside
  // this one).
  proposal: "Proposal",
};

interface ProjectOption {
  id: string;
  name: string;
  alias: string | null;
}

export function DailyBrief() {
  const [data, setData] = useState<BriefResponse | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/brief")
      .then(async (res) => {
        if (res.status === 403) {
          if (!cancelled) setForbidden(true);
          return null;
        }
        if (!res.ok) throw new Error((await res.json()).error ?? "Could not load the Daily Brief.");
        return res.json();
      })
      .then((body) => {
        if (!cancelled && body) setData(body);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the Daily Brief.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function ensureProjectsLoaded() {
    if (projects !== null) return;
    setProjects([]); // guard against a second concurrent fetch while the first is in flight
    fetch("/api/projects")
      .then((r) => r.json())
      // GET /api/projects responds { projects: ProjectWithCounts[] } —
      // not a bare array (see that route's own final NextResponse.json
      // call) — this picker only needs id/name/alias off each row.
      .then((body: { projects?: { id: string; name: string; alias: string | null }[] }) => {
        setProjects((body.projects ?? []).map((p) => ({ id: p.id, name: p.name, alias: p.alias })));
      })
      .catch(() => setProjects([]));
  }

  async function toggleStatus(item: DailyBriefItemWithMeta) {
    if (!data) return;
    const prev = data;
    setData({
      ...data,
      items: data.items.filter((i) => i.id !== item.id),
      total_count: Math.max(0, data.total_count - 1),
    });
    try {
      const res = await fetch(`/api/brief/items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update this item.");
    } catch (err) {
      setData(prev);
      setError(err instanceof Error ? err.message : "Could not update this item.");
    }
  }

  async function addManualItem(title: string, linkHref: string, projectId: string) {
    if (!data) return;
    setError(null);
    try {
      const res = await fetch("/api/brief/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          link_href: linkHref.trim() || undefined,
          project_id: projectId || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add this item.");
      const { item } = await res.json();
      const project = projectId ? projects?.find((p) => p.id === projectId) ?? null : null;
      setData({
        ...data,
        items: [
          { ...item, project, carried_over_label: null, converted_label: null },
          ...data.items,
        ],
        total_count: data.total_count + 1,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this item.");
    }
  }

  async function convert(item: DailyBriefItemWithMeta, projectId: string | null) {
    if (!data) return;
    setError(null);
    try {
      const res = await fetch(`/api/brief/items/${item.id}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add this to a project.");
      await res.json();
      setData({
        ...data,
        items: data.items.filter((i) => i.id !== item.id),
        total_count: Math.max(0, data.total_count - 1),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this to a project.");
    }
  }

  if (forbidden) return null;

  // Use the fetched server timestamp only after data arrives. Rendering
  // `new Date()` during SSR let UTC and Adelaide disagree around midnight,
  // producing a hydration warning even though the underlying data was fine.
  const briefDate = data ? new Date(data.refreshed_at) : null;
  const activeItems = data?.items.filter((item) => item.status === "open") ?? [];

  return (
    <section className="border border-[#dcd6cc] bg-offwhite">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#dcd6cc] px-4 py-3">
        <div>
          <p className="text-body font-medium text-nearblack">
            Daily Brief{briefDate ? ` · ${formatDateHeader(briefDate)}` : ""}
          </p>
          {data && (
            <p className="mt-0.5 text-caption text-charcoal/45">
              {activeItems.length} to review
              {" · "}refreshed {formatRefreshedAt(data.refreshed_at)}
            </p>
          )}
        </div>
      </div>

      <div className="p-3">
        {error && <p className="mb-3 border border-red-700/40 bg-red-50 px-3 py-2 text-caption text-red-700">{error}</p>}

        {!data ? (
          <p className="px-1 py-2 text-caption text-charcoal/40">Loading…</p>
        ) : activeItems.length === 0 ? (
          <p className="px-1 py-2 text-caption text-charcoal/40">Nothing in the brief right now.</p>
        ) : (
          <ul className="space-y-1.5">
            {activeItems.map((item) => (
              <BriefRow
                key={item.id}
                item={item}
                projects={projects}
                onEnsureProjects={ensureProjectsLoaded}
                onToggle={() => toggleStatus(item)}
                onConvert={(projectId) => convert(item, projectId)}
              />
            ))}
          </ul>
        )}

        <ManualAddForm
          projects={projects}
          onFocusProjects={ensureProjectsLoaded}
          onSubmit={addManualItem}
        />
      </div>
    </section>
  );
}

function BriefRow({
  item,
  projects,
  onEnsureProjects,
  onToggle,
  onConvert,
}: {
  item: DailyBriefItemWithMeta;
  projects: ProjectOption[] | null;
  onEnsureProjects: () => void;
  onToggle: () => void;
  onConvert: (projectId: string | null) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const alreadyConverted = !!item.converted_label;

  return (
    <li className="flex flex-wrap items-start gap-2.5 border border-[#e5e0d6] bg-white px-3 py-2">
      <input
        type="checkbox"
        checked={false}
        onChange={onToggle}
        className="mt-0.5 h-3.5 w-3.5 shrink-0"
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="label-caps shrink-0 border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
            {SOURCE_LABEL[item.source]}
          </span>
          {item.project && (
            <span className="label-caps shrink-0 border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
              {item.project.name}
            </span>
          )}
          {item.carried_over_label && (
            <span className="label-caps shrink-0 !text-sand">{item.carried_over_label}</span>
          )}
        </div>
        <p className="mt-1 text-body text-nearblack">{item.title}</p>
        {item.converted_label && (
          <p className="mt-0.5 text-caption text-charcoal/45">{item.converted_label}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {item.link_href && (
          <a href={item.link_href} className="text-caption text-charcoal/60 hover:text-nearblack hover:underline">
            open →
          </a>
        )}
        {!alreadyConverted && (
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                onEnsureProjects();
                setPickerOpen((o) => !o);
              }}
              className="border border-[#c9c2b4] px-1.5 py-1 text-caption text-charcoal hover:border-nearblack"
            >
              Add to project →
            </button>
            {pickerOpen && (
              <ProjectPickerPopover
                projects={projects}
                onClose={() => setPickerOpen(false)}
                onPick={(projectId) => {
                  setPickerOpen(false);
                  onConvert(projectId);
                }}
              />
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function ProjectPickerPopover({
  projects,
  onClose,
  onPick,
}: {
  projects: ProjectOption[] | null;
  onClose: () => void;
  onPick: (projectId: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = (projects ?? []).filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="absolute right-0 top-full z-30 mt-1 w-64 border border-[#dcd6cc] bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-[#e5e0d6] px-2 py-1.5">
        <span className="label-caps !text-charcoal/45">Add to project</span>
        <button type="button" onClick={onClose} className="text-caption text-charcoal/40 hover:text-nearblack">
          ✕
        </button>
      </div>
      <div className="p-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects…"
          className="mb-1.5 w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-caption focus:border-nearblack focus:outline-none"
        />
        <button
          type="button"
          onClick={() => onPick(null)}
          className="mb-1 w-full border border-[#c9c2b4] px-2 py-1 text-left text-caption text-charcoal hover:border-nearblack"
        >
          No project — Office task (Phillip)
        </button>
        <div className="max-h-48 overflow-y-auto">
          {projects === null || projects.length === 0 ? (
            <p className="px-1 py-1 text-caption text-charcoal/40">{projects === null ? "Loading…" : "No projects found."}</p>
          ) : (
            filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPick(p.id)}
                className="block w-full truncate px-1.5 py-1 text-left text-caption text-nearblack hover:bg-nearwhite"
              >
                {p.name}
                {p.alias && <span className="text-charcoal/40"> · {p.alias}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ManualAddForm({
  projects,
  onFocusProjects,
  onSubmit,
}: {
  projects: ProjectOption[] | null;
  onFocusProjects: () => void;
  onSubmit: (title: string, linkHref: string, projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [projectId, setProjectId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    await onSubmit(title.trim(), link, projectId);
    setTitle("");
    setLink("");
    setProjectId("");
    setSubmitting(false);
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          onFocusProjects();
        }}
        className="mt-2 w-full border border-dashed border-[#c9c2b4] px-2 py-1.5 text-left text-caption text-charcoal/50 hover:border-nearblack hover:text-nearblack"
      >
        + Add a brief item
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-1.5 border border-[#e5e0d6] bg-white p-2">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title…"
        className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-caption focus:border-nearblack focus:outline-none"
      />
      <div className="flex flex-wrap gap-1.5">
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Link (optional) — e.g. /projects/…"
          className="min-w-0 flex-1 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-caption focus:border-nearblack focus:outline-none"
        />
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-caption text-charcoal focus:border-nearblack focus:outline-none"
        >
          <option value="">No project</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-2 py-1 text-caption text-charcoal/50 hover:text-nearblack"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!title.trim() || submitting}
          className="bg-nearblack px-3 py-1 text-caption text-white hover:bg-charcoal disabled:opacity-60"
        >
          Add
        </button>
      </div>
    </form>
  );
}
