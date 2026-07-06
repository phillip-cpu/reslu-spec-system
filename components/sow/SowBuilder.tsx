"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import type { SowDocument, SowLine, SowLineKind, SowSectionWithLines } from "@/types";

interface Props {
  projectId: string;
}

/** DOM anchor id for a given SOW section — shared by the outline's
 * click-to-scroll links and each SectionBlock's own scroll target. */
function sectionAnchorId(sectionId: string): string {
  return `sow-section-${sectionId}`;
}

const KIND_LABEL: Record<SowLineKind, string> = {
  inclusion: "Inclusion",
  exclusion: "Exclusion",
  note: "Note",
};

/**
 * Owns the SOW builder's fetch/refresh cycle and revision switching —
 * mirrors EstimateWorkspace's role for the Estimate module. Structural
 * changes (create SOW, new revision, issue, add/remove section) go
 * through a full reload of the current revision; line-level edits use
 * the same single-save draft-row + optimistic-patch pattern as
 * components/estimate/EstimateView.tsx, per BUILD-SPEC.md "reuse those
 * interaction patterns exactly".
 */
export function SowBuilder({ projectId }: Props) {
  const [revisions, setRevisions] = useState<SowDocument[]>([]);
  const [activeSowId, setActiveSowId] = useState<string | null>(null);
  const [sow, setSow] = useState<SowDocument | null>(null);
  const [sections, setSections] = useState<SowSectionWithLines[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  // Fix round B — BUILD-SPEC.md §"SOW sticky outline" (improvements
  // backlog): sticky section outline sidebar, current section
  // highlighted via IntersectionObserver.
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);

  const loadRevisions = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/sow`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Could not load Scope of Works revisions.");
    const list: SowDocument[] = body.sow_documents ?? [];
    setRevisions(list);
    return list;
  }, [projectId]);

  const loadSow = useCallback(async (sowId: string) => {
    const res = await fetch(`/api/projects/${projectId}/sow/${sowId}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Could not load this Scope of Works revision.");
    setSow(body.sow as SowDocument);
    setSections(body.sections as SowSectionWithLines[]);
  }, [projectId]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await loadRevisions();
      if (list.length > 0) {
        setActiveSowId(list[0].id);
        await loadSow(list[0].id);
      } else {
        setActiveSowId(null);
        setSow(null);
        setSections([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Scope of Works.");
    } finally {
      setLoading(false);
    }
  }, [loadRevisions, loadSow]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Default the active outline entry to the first section whenever the
  // section list changes shape (new SOW loaded, revision switched, or
  // sections added/removed) — the observer effect below then takes
  // over as the user scrolls.
  useEffect(() => {
    setActiveSectionId((cur) => {
      if (cur && sections.some((s) => s.id === cur)) return cur;
      return sections[0]?.id ?? null;
    });
  }, [sections]);

  // Sticky outline highlight — BUILD-SPEC.md §"SOW sticky outline":
  // "current section highlighted via IntersectionObserver". Observes
  // every section's DOM anchor and picks whichever intersecting
  // section is currently closest to the top of the viewport (multiple
  // sections can be "intersecting" at once on a tall page — rootMargin
  // narrows the effective viewport to a band near the top so the
  // highlight tracks the section actually under the reader's eye,
  // similar to the portal's own scroll-mt-16 anchor convention).
  useEffect(() => {
    if (sections.length === 0) return;
    const elements = sections
      .map((s) => document.getElementById(sectionAnchorId(s.id)))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        // Closest to the top of the observed band wins.
        const top = visible.reduce((best, e) =>
          e.boundingClientRect.top < best.boundingClientRect.top ? e : best
        );
        const id = top.target.id.replace("sow-section-", "");
        setActiveSectionId(id);
      },
      { rootMargin: "-96px 0px -70% 0px", threshold: 0 }
    );

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [sections]);

  function scrollToSection(sectionId: string) {
    setActiveSectionId(sectionId);
    document.getElementById(sectionAnchorId(sectionId))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function switchRevision(sowId: string) {
    setActiveSowId(sowId);
    setError(null);
    try {
      await loadSow(sowId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this revision.");
    }
  }

  async function createFirstSow() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/sow`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not create the Scope of Works.");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the Scope of Works.");
    } finally {
      setCreating(false);
    }
  }

  async function issueSow() {
    if (!sow) return;
    if (!confirm(`Issue ${sow.revision_label}? It will become read-only — further edits require a new revision.`)) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/sow/${sow.id}/issue`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not issue this Scope of Works.");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not issue this Scope of Works.");
    }
  }

  async function newRevision() {
    if (!sow) return;
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/sow/${sow.id}/new-revision`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not start a new revision.");
      const list = await loadRevisions();
      const created = list.find((r) => r.id === body.sow.id) ?? body.sow;
      setActiveSowId(created.id);
      await loadSow(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a new revision.");
    }
  }

  /**
   * "Start from template" — Phase 12a-A, BUILD-SPEC.md "SOW completion":
   * appends the standard clause library (Project Overview / General
   * Notes / Site Management & Handover / Exclusions) plus one section
   * per current project room (from the `rooms` table) onto the active
   * draft revision. See app/api/projects/[id]/sow/[sowId]/from-template
   * and lib/sow-templates.ts. Additive only — never replaces existing
   * sections, so it's safe to click on a SOW that already has content.
   */
  async function applyTemplate() {
    if (!sow) return;
    setApplyingTemplate(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/sow/${sow.id}/from-template`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not apply the template.");
      setSections((cur) => [...cur, ...((body.sections ?? []) as SowSectionWithLines[])]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the template.");
    } finally {
      setApplyingTemplate(false);
    }
  }

  async function addSection(heading: string) {
    if (!sow) return;
    const res = await fetch(`/api/projects/${projectId}/sow/${sow.id}/sections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heading }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Could not add section.");
    setSections((cur) => [...cur, body.section as SowSectionWithLines]);
  }

  async function renameSection(sectionId: string, heading: string) {
    const res = await fetch(`/api/sow/sections/${sectionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heading }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Could not rename section.");
    setSections((cur) =>
      cur.map((s) => (s.id === sectionId ? { ...s, heading: body.section.heading } : s))
    );
  }

  async function deleteSection(sectionId: string, heading: string) {
    if (!confirm(`Delete section "${heading}" and all its lines? This can't be undone.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/sow/sections/${sectionId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not delete section.");
      }
      setSections((cur) => cur.filter((s) => s.id !== sectionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete section.");
    }
  }

  async function addLine(sectionId: string, text: string, kind: SowLineKind) {
    const res = await fetch(`/api/sow/sections/${sectionId}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, kind }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Could not add line.");
    const line = body.line as SowLine;
    setSections((cur) =>
      cur.map((s) => (s.id === sectionId ? { ...s, lines: [...s.lines, line] } : s))
    );
  }

  async function patchLine(line: SowLine, patch: Partial<SowLine>): Promise<SowLine> {
    const res = await fetch(`/api/sow/lines/${line.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Could not update line.");
    const updated = body.line as SowLine;
    setSections((cur) =>
      cur.map((s) =>
        s.id === line.section_id
          ? { ...s, lines: s.lines.map((l) => (l.id === line.id ? updated : l)) }
          : s
      )
    );
    return updated;
  }

  async function deleteLine(line: SowLine) {
    setError(null);
    try {
      const res = await fetch(`/api/sow/lines/${line.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not remove line.");
      }
      setSections((cur) =>
        cur.map((s) =>
          s.id === line.section_id ? { ...s, lines: s.lines.filter((l) => l.id !== line.id) } : s
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove line.");
    }
  }

  if (loading) {
    return <p className="text-body text-charcoal/50">Loading Scope of Works…</p>;
  }

  if (revisions.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
        <p className="mb-4 text-body text-charcoal/60">
          No Scope of Works yet for this project. Start the first draft
          (T1) — seeded with General/Preliminaries, one section per room
          from the spec register, Exclusions and Assumptions.
        </p>
        <button
          type="button"
          onClick={createFirstSow}
          disabled={creating}
          className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
        >
          {creating ? "Creating…" : "Start Scope of Works"}
        </button>
        {error && <p className="mt-4 text-body text-red-700">{error}</p>}
      </div>
    );
  }

  const isDraft = sow?.status === "draft";

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border border-nearblack bg-offwhite px-5 py-4">
        <div className="flex items-center gap-3">
          <label className="label-caps">Revision</label>
          <select
            value={activeSowId ?? ""}
            onChange={(e) => switchRevision(e.target.value)}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          >
            {revisions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.revision_label} — {r.status === "issued" ? "Issued" : "Draft"}
              </option>
            ))}
          </select>
          {sow && (
            <span
              className={clsx(
                "label-caps px-2 py-1",
                sow.status === "issued" ? "!text-[#3B6D11]" : "!text-[#BA7517]"
              )}
            >
              {sow.status === "issued" ? "Issued" : "Draft"}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {sow && isDraft && (
            <button
              type="button"
              onClick={applyTemplate}
              disabled={applyingTemplate}
              className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-60"
              title="Append the standard clause library + one section per project room"
            >
              {applyingTemplate ? "Applying…" : "Start from template"}
            </button>
          )}
          {sow && (
            <a
              href={`/api/projects/${projectId}/sow/${sow.id}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
            >
              Download PDF
            </a>
          )}
          {isDraft ? (
            <button
              type="button"
              onClick={issueSow}
              className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal"
            >
              Issue
            </button>
          ) : (
            <button
              type="button"
              onClick={newRevision}
              className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal"
            >
              New revision
            </button>
          )}
        </div>
      </div>

      {!isDraft && sow && (
        <p className="border border-[#dcd6cc] bg-cream px-4 py-2 text-caption text-charcoal/60">
          {sow.revision_label} was issued
          {sow.issued_at ? ` on ${new Date(sow.issued_at).toLocaleDateString("en-AU")}` : ""} and
          is now read-only. Use "New revision" above to make further changes.
        </p>
      )}

      {sections.length > 0 && (
        <div className="sm:grid sm:grid-cols-[12rem_1fr] sm:gap-8">
          <SowOutline
            sections={sections}
            activeSectionId={activeSectionId}
            onSelect={scrollToSection}
          />

          <div className="min-w-0 space-y-4">
            <div className="space-y-4">
              {sections.map((section) => (
                <div key={section.id} id={sectionAnchorId(section.id)} className="scroll-mt-24">
                  <SectionBlock
                    section={section}
                    readOnly={!isDraft}
                    onRename={(heading) => renameSection(section.id, heading)}
                    onDelete={() => deleteSection(section.id, section.heading)}
                    onAddLine={(text, kind) => addLine(section.id, text, kind)}
                    onPatchLine={patchLine}
                    onDeleteLine={deleteLine}
                  />
                </div>
              ))}
            </div>

            {isDraft && <AddSectionForm onAdd={addSection} />}
          </div>
        </div>
      )}

      {sections.length === 0 && isDraft && <AddSectionForm onAdd={addSection} />}
    </div>
  );
}

/**
 * Sticky section outline — BUILD-SPEC.md improvements-backlog "SOW
 * sticky outline" note: section names, click scrolls to section,
 * current section highlighted via IntersectionObserver (state owned by
 * the parent, this component is purely presentational), collapses to
 * a dropdown on narrow screens.
 *
 * Two renderings of the SAME data, toggled by a Tailwind breakpoint
 * (no JS media-query listener needed): a `<select>` dropdown
 * (`sm:hidden`) for narrow screens, and a `<nav>` list (`sm:block`,
 * `sticky`) for wide ones — exactly one is ever visible at a given
 * viewport width. This component IS the first column of SowBuilder's
 * "sm:grid sm:grid-cols-[12rem_1fr]" wrapper on wide screens (the
 * dropdown, on narrow screens, instead spans full-width above the
 * grid via its own `sm:hidden`/negative-margin-free block layout — the
 * outer grid only takes effect at `sm:` anyway, so both renderings
 * coexist safely in the DOM and Tailwind's responsive classes pick the
 * right one per viewport).
 */
function SowOutline({
  sections,
  activeSectionId,
  onSelect,
}: {
  sections: SowSectionWithLines[];
  activeSectionId: string | null;
  onSelect: (sectionId: string) => void;
}) {
  return (
    <>
      {/* Narrow screens — dropdown. `sm:hidden` means it never actually
          renders once the sm:grid layout kicks in, so it's exempt from
          worrying about grid column placement. */}
      <div className="mb-4 sm:hidden">
        <label className="label-caps mb-1 block !text-sand">Jump to section</label>
        <select
          value={activeSectionId ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
        >
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.heading}
            </option>
          ))}
        </select>
      </div>

      {/* Wide screens — sticky outline sidebar, the grid's first
          column (see SowBuilder's "sm:grid sm:grid-cols-[12rem_1fr]"
          wrapper). `sticky` + `self-start` pins it within that column
          as the page scrolls. */}
      <nav className="hidden sm:sticky sm:top-4 sm:block sm:self-start">
        <p className="label-caps mb-2 !text-sand">Outline</p>
        <ul className="space-y-0.5 border-l border-[#dcd6cc]">
          {sections.map((s) => {
            const active = s.id === activeSectionId;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  className={clsx(
                    "-ml-px block w-full truncate border-l-2 px-3 py-1.5 text-left text-caption transition-colors",
                    active
                      ? "border-nearblack text-nearblack"
                      : "border-transparent text-charcoal/50 hover:border-[#c9c2b4] hover:text-nearblack"
                  )}
                  title={s.heading}
                >
                  {s.heading}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

function AddSectionForm({ onAdd }: { onAdd: (heading: string) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [heading, setHeading] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!heading.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd(heading.trim());
      setHeading("");
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add section.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="border border-nearblack px-5 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
      >
        + Add section
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2 border border-[#dcd6cc] bg-offwhite p-4">
      <input
        autoFocus
        value={heading}
        onChange={(e) => setHeading(e.target.value)}
        placeholder="Section heading, e.g. Guest Bedroom"
        className="min-w-[200px] flex-1 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
      />
      <button
        type="submit"
        disabled={submitting}
        className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
      >
        Add
      </button>
      <button
        type="button"
        onClick={() => {
          setAdding(false);
          setHeading("");
        }}
        className="border border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal hover:border-nearblack"
      >
        Cancel
      </button>
      {error && <p className="w-full text-caption text-red-700">{error}</p>}
    </form>
  );
}

function SectionBlock({
  section,
  readOnly,
  onRename,
  onDelete,
  onAddLine,
  onPatchLine,
  onDeleteLine,
}: {
  section: SowSectionWithLines;
  readOnly: boolean;
  onRename: (heading: string) => Promise<void>;
  onDelete: () => void;
  onAddLine: (text: string, kind: SowLineKind) => Promise<void>;
  onPatchLine: (line: SowLine, patch: Partial<SowLine>) => Promise<SowLine>;
  onDeleteLine: (line: SowLine) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <section className="border border-[#dcd6cc]">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-cream px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="text-charcoal/50 hover:text-nearblack"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "−" : "+"}
          </button>
          {readOnly ? (
            <p className="label-caps !text-nearblack">{section.heading}</p>
          ) : (
            <SectionHeadingEditor heading={section.heading} onRename={onRename} />
          )}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-caption text-charcoal/50">
            {section.lines.length} {section.lines.length === 1 ? "line" : "lines"}
          </span>
          {!readOnly && (
            <button
              type="button"
              onClick={onDelete}
              className="text-caption text-red-700/70 hover:text-red-700"
            >
              Delete section
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="divide-y divide-[#e5e0d6]">
          {section.lines.map((line) => (
            <LineRow
              key={line.id}
              line={line}
              readOnly={readOnly}
              onPatch={(patch) => onPatchLine(line, patch)}
              onDelete={() => onDeleteLine(line)}
            />
          ))}
          {!readOnly && <DraftLineRow onAdd={onAddLine} />}
          {section.lines.length === 0 && readOnly && (
            <p className="px-4 py-3 text-caption text-charcoal/40">No lines in this section.</p>
          )}
        </div>
      )}
    </section>
  );
}

function SectionHeadingEditor({
  heading,
  onRename,
}: {
  heading: string;
  onRename: (heading: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(heading);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft.trim() && draft.trim() !== heading) onRename(draft.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(heading);
            setEditing(false);
          }
        }}
        className="border border-nearblack bg-nearwhite px-2 py-1 text-subhead text-nearblack focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(heading);
        setEditing(true);
      }}
      className="label-caps !text-nearblack hover:!text-sand"
    >
      {heading}
    </button>
  );
}

/**
 * A single SOW line — same accumulate-locally / single-save-on-blur
 * pattern as components/estimate/EstimateView.tsx's LineRow, cut down
 * to the two fields a SOW line has (text, kind). Kind toggle acts
 * immediately (a single discrete click, not accumulated typing),
 * exactly like EstimateView's item/measurement link buttons.
 */
function LineRow({
  line,
  readOnly,
  onPatch,
  onDelete,
}: {
  line: SowLine;
  readOnly: boolean;
  onPatch: (patch: Partial<SowLine>) => Promise<SowLine>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(line.text);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  async function save() {
    if (!dirty || saving || !draft.trim()) return;
    setSaving(true);
    setRowError(null);
    try {
      await onPatch({ text: draft.trim() });
      setDirty(false);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Could not save this line.");
    } finally {
      setSaving(false);
    }
  }

  async function setKind(kind: SowLineKind) {
    setRowError(null);
    try {
      await onPatch({ kind });
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Could not update this line.");
    }
  }

  if (readOnly) {
    return (
      <div className="flex items-start gap-3 px-4 py-2">
        <span
          className={clsx(
            "label-caps mt-0.5 w-20 shrink-0",
            line.kind === "exclusion" && "!text-[#A32D2D]",
            line.kind === "note" && "!text-charcoal/40"
          )}
        >
          {KIND_LABEL[line.kind]}
        </span>
        <p className={clsx("text-body text-charcoal", line.kind === "note" && "italic")}>
          {line.text}
        </p>
      </div>
    );
  }

  return (
    <div className={clsx("flex items-start gap-3 px-4 py-2", dirty && "bg-cream/60")}>
      <select
        value={line.kind}
        onChange={(e) => setKind(e.target.value as SowLineKind)}
        className={clsx(
          "label-caps mt-1 w-24 shrink-0 border-none bg-transparent focus:outline-none",
          line.kind === "exclusion" && "!text-[#A32D2D]",
          line.kind === "note" && "!text-charcoal/40"
        )}
      >
        <option value="inclusion">Inclusion</option>
        <option value="exclusion">Exclusion</option>
        <option value="note">Note</option>
      </select>
      <div className="flex-1">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(true);
          }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className={clsx(
            "w-full border-none bg-transparent px-1 py-1 text-body text-charcoal focus:bg-nearwhite focus:outline-none",
            line.kind === "note" && "italic"
          )}
        />
        {rowError && <p className="px-1 pt-1 text-caption text-red-700">⚠ {rowError}</p>}
      </div>
      {dirty && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={save}
          disabled={saving}
          title="Save this line"
          className="mt-1 shrink-0 text-caption text-sand hover:text-nearblack disabled:opacity-50"
        >
          {saving ? "…" : "✓"}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          if (confirm("Remove this line?")) onDelete();
        }}
        className="mt-1 shrink-0 text-caption text-red-700/60 hover:text-red-700"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * New-line draft row — same single-save-on-submit pattern as
 * components/estimate/EstimateView.tsx's DraftLineRow: fill text (kind
 * defaults to inclusion, changeable before or after add), Enter or the
 * Add button posts the whole line in one request, then the row clears
 * and refocuses for rapid entry.
 */
function DraftLineRow({
  onAdd,
}: {
  onAdd: (text: string, kind: SowLineKind) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<SowLineKind>("inclusion");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd(text.trim(), kind);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add line.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex items-start gap-3 bg-offwhite/60 px-4 py-2">
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as SowLineKind)}
        className="label-caps mt-1 w-24 shrink-0 border-none bg-transparent focus:outline-none"
      >
        <option value="inclusion">Inclusion</option>
        <option value="exclusion">Exclusion</option>
        <option value="note">Note</option>
      </select>
      <div className="flex-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="+ Add line…"
          className="w-full border-none bg-transparent px-1 py-1 text-body text-charcoal placeholder:text-charcoal/35 focus:bg-nearwhite focus:outline-none"
        />
        {error && <p className="px-1 pt-1 text-caption text-red-700">⚠ {error}</p>}
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={submitting || !text.trim()}
        className="mt-1 shrink-0 border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
      >
        {submitting ? "…" : "Add"}
      </button>
    </div>
  );
}
