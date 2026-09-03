"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { SowDocument, SowLineKind } from "@/types";
import type {
  CopySowLinesResponse,
  SowLineWithTrade,
  SowSectionWithTradedLines,
  SuggestTradeTagsResponse,
} from "@/types/sow-trade-tags";
import type { ExportPresetRow } from "@/types/round-export-batch";
import type { SowQualityReport } from "@/types/sow-quality";
import type {
  ProjectTradeAssignment,
  ProjectTradeContact,
} from "@/types/project-trade-assignments";
import { ContactPicker } from "@/components/shared/ContactPicker";
import {
  FALLBACK_EXPORT_PRESETS,
  contactMatchesPreset,
} from "@/lib/export-presets";
import { distinctTaggedTrades, groupSowLinesByTrade } from "@/lib/sow-trade-tags";
import { reorderSowLines } from "@/lib/sow-reorder";

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
  const [sections, setSections] = useState<SowSectionWithTradedLines[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  const [reorderingRoomSectionId, setReorderingRoomSectionId] = useState<string | null>(null);
  const [reorderingLineSectionId, setReorderingLineSectionId] = useState<string | null>(null);
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(() => new Set());
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [copyTargetSectionIds, setCopyTargetSectionIds] = useState<Set<string>>(() => new Set());
  const [copyingLines, setCopyingLines] = useState(false);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  // "Trade-scoped SOW extracts" round — trade preset names (the trade
  // select's option list + the "Suggest trade tags" action's own
  // resolution list) and this action's own busy/result state.
  const [presets, setPresets] = useState<ExportPresetRow[]>([]);
  const [tradeContacts, setTradeContacts] = useState<ProjectTradeContact[]>([]);
  const [tradeAssignments, setTradeAssignments] = useState<ProjectTradeAssignment[]>([]);
  const [additionalTradeRoles, setAdditionalTradeRoles] = useState<string[]>([]);
  const [assignmentSavingRole, setAssignmentSavingRole] = useState<string | null>(null);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [suggestingTags, setSuggestingTags] = useState(false);
  const [suggestMessage, setSuggestMessage] = useState<string | null>(null);
  const [quality, setQuality] = useState<SowQualityReport | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
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
    setSections(body.sections as SowSectionWithTradedLines[]);
    setSelectedLineIds(new Set());
    setCopyTargetSectionIds(new Set());
    setCopyDialogOpen(false);
  }, [projectId]);

  const loadQuality = useCallback(async (sowId: string) => {
    setQualityLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/sow/${sowId}/quality`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not run the pre-issue review.");
      const report = body.quality as SowQualityReport;
      setQuality(report);
      return report;
    } finally {
      setQualityLoading(false);
    }
  }, [projectId]);

  // Trade vocabulary, Address Book choices and the project-level trade
  // roster are loaded together. A failure in one optional source does not
  // blank the others, so the SOW itself remains usable during a transient
  // contacts/settings failure.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/settings/export-presets").then((r) =>
        r.ok ? r.json() : { presets: FALLBACK_EXPORT_PRESETS }
      ),
      fetch("/api/contacts?limit=2000").then((r) =>
        r.ok ? r.json() : { contacts: [] }
      ),
      fetch(`/api/projects/${projectId}/trade-assignments`).then((r) =>
        r.ok ? r.json() : { assignments: [] }
      ),
    ])
      .then(([presetsBody, contactsBody, assignmentsBody]) => {
        if (cancelled) return;
        setPresets(presetsBody.presets ?? FALLBACK_EXPORT_PRESETS);
        setTradeContacts(contactsBody.contacts ?? []);
        setTradeAssignments(assignmentsBody.assignments ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function setTradeAssignment(tradeRole: string, contactId: string | null) {
    setAssignmentSavingRole(tradeRole);
    setAssignmentError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/trade-assignments`, {
        method: contactId ? "PUT" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trade_role: tradeRole, contact_id: contactId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not update the project trade team.");

      setTradeAssignments((current) => {
        const withoutRole = current.filter(
          (assignment) => assignment.role_key !== tradeRole.trim().toLowerCase()
        );
        return contactId && body.assignment
          ? [...withoutRole, body.assignment as ProjectTradeAssignment].sort((a, b) =>
              a.trade_role.localeCompare(b.trade_role)
            )
          : withoutRole;
      });
    } catch (err) {
      setAssignmentError(
        err instanceof Error ? err.message : "Could not update the project trade team."
      );
    } finally {
      setAssignmentSavingRole(null);
    }
  }

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
        setQuality(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Scope of Works.");
    } finally {
      setLoading(false);
    }
  }, [loadRevisions, loadSow]);

  useEffect(() => {
    // Initial client-side data hydration is intentionally owned here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
  }, [loadAll]);

  // Line edits save on blur. Reassess shortly after the persisted
  // section state changes so the review stays current without firing
  // on every keystroke.
  useEffect(() => {
    if (!sow) return;
    const timer = window.setTimeout(() => {
      loadQuality(sow.id).catch(() => {});
    }, 450);
    return () => window.clearTimeout(timer);
  }, [loadQuality, sections, sow]);

  // Default the active outline entry to the first section whenever the
  // section list changes shape (new SOW loaded, revision switched, or
  // sections added/removed) — the observer effect below then takes
  // over as the user scrolls.
  useEffect(() => {
    // Keep the outline selection valid when revision structure changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    setError(null);
    try {
      const currentQuality = await loadQuality(sow.id);
      if (!currentQuality.ready_to_issue) {
        setError(
          `Resolve ${currentQuality.blockers.length} pre-issue blocker${currentQuality.blockers.length === 1 ? "" : "s"} before issuing this Scope of Works.`
        );
        document.getElementById("sow-quality-review")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const warningText = currentQuality.warnings.length > 0
        ? `\n\n${currentQuality.warnings.length} review warning${currentQuality.warnings.length === 1 ? " remains" : "s remain"}. Confirm you have checked them before continuing.`
        : "";
      if (!confirm(`Issue ${sow.revision_label}? It will become read-only — further edits require a new revision.${warningText}`)) {
        return;
      }
      const res = await fetch(`/api/projects/${projectId}/sow/${sow.id}/issue`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.quality) setQuality(body.quality as SowQualityReport);
        throw new Error(body.error ?? "Could not issue this Scope of Works.");
      }
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
   * draft revision. See app/api/projects/[id]/sow/[sowId]/from-template.
   * Missing-content only — never replaces existing sections or authored
   * room lines, so completed rooms remain untouched.
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
      // Existing empty room sections are populated in place. Reloading
      // avoids representing the same persisted section twice locally.
      await loadSow(sow.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the template.");
    } finally {
      setApplyingTemplate(false);
    }
  }

  /**
   * "Trade-scoped SOW extracts" round — the builder's one-click
   * "Suggest trade tags" action (BUILD-SPEC.md: "fills only untagged
   * lines, reports count"). POST .../suggest-trade-tags does the
   * actual matching/writing server-side (lib/sow-trade-tags.ts's
   * suggestTradeTag(), same heuristic "Start from template" already
   * applies at line-creation time) — this handler just merges the
   * returned updated lines into local state (same "merge by id"
   * pattern patchLine already uses for a single line, extended across
   * every section here since a run can touch lines in several
   * sections at once) and surfaces the count.
   */
  async function suggestTradeTags() {
    if (!sow) return;
    setSuggestingTags(true);
    setError(null);
    setSuggestMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/sow/${sow.id}/suggest-trade-tags`, {
        method: "POST",
      });
      const body: SuggestTradeTagsResponse = await res.json().catch(() => ({ lines: [], tagged_count: 0 }));
      if (!res.ok) throw new Error((body as unknown as { error?: string }).error ?? "Could not suggest trade tags.");
      const updated = body.lines ?? [];
      if (updated.length > 0) {
        const byId = new Map(updated.map((l) => [l.id, l]));
        setSections((cur) =>
          cur.map((s) => ({ ...s, lines: s.lines.map((l) => byId.get(l.id) ?? l) }))
        );
      }
      setSuggestMessage(
        updated.length > 0
          ? `Tagged ${updated.length} line${updated.length === 1 ? "" : "s"}.`
          : "No new tags suggested — nothing untagged matched a current trade preset."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not suggest trade tags.");
    } finally {
      setSuggestingTags(false);
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
    setSections((cur) => [...cur, body.section as SowSectionWithTradedLines]);
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

  async function moveRoomSection(sectionId: string, direction: -1 | 1) {
    const roomSections = sections.filter((section) => section.source_room_id !== null);
    const roomIndex = roomSections.findIndex((section) => section.id === sectionId);
    const targetRoom = roomSections[roomIndex + direction];
    const sourceRoom = roomSections[roomIndex];
    if (!sourceRoom || !targetRoom || reorderingRoomSectionId) return;

    setReorderingRoomSectionId(sectionId);
    setError(null);
    try {
      const updates = [
        { section: sourceRoom, sort: targetRoom.sort },
        { section: targetRoom, sort: sourceRoom.sort },
      ];
      const responses = await Promise.all(
        updates.map(({ section, sort }) =>
          fetch(`/api/sow/sections/${section.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sort }),
          })
        )
      );
      const failed = responses.find((response) => !response.ok);
      if (failed) {
        const body = await failed.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not reorder rooms.");
      }

      setSections((current) => {
        const next = [...current];
        const sourceIndex = next.findIndex((section) => section.id === sourceRoom.id);
        const targetIndex = next.findIndex((section) => section.id === targetRoom.id);
        if (sourceIndex < 0 || targetIndex < 0) return current;
        next[sourceIndex] = { ...targetRoom, sort: sourceRoom.sort };
        next[targetIndex] = { ...sourceRoom, sort: targetRoom.sort };
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reorder rooms.");
      // One PATCH may have succeeded before the other failed. Reload
      // the revision so the UI always reflects the persisted order.
      if (sow) await loadSow(sow.id).catch(() => {});
    } finally {
      setReorderingRoomSectionId(null);
    }
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

  async function addLine(
    sectionId: string,
    text: string,
    kind: SowLineKind,
    trade: string | null
  ) {
    const res = await fetch(`/api/sow/sections/${sectionId}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, kind, trade }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Could not add line.");
    const line = body.line as SowLineWithTrade;
    setSections((cur) =>
      cur.map((s) => (s.id === sectionId ? { ...s, lines: [...s.lines, line] } : s))
    );
  }

  function toggleLineSelection(lineId: string, checked: boolean) {
    setSelectedLineIds((current) => {
      const next = new Set(current);
      if (checked) next.add(lineId);
      else next.delete(lineId);
      return next;
    });
    setCopyMessage(null);
  }

  function toggleCopyTarget(sectionId: string, checked: boolean) {
    setCopyTargetSectionIds((current) => {
      const next = new Set(current);
      if (checked) next.add(sectionId);
      else next.delete(sectionId);
      return next;
    });
  }

  async function copySelectedLines() {
    if (!sow || selectedLineIds.size === 0 || copyTargetSectionIds.size === 0 || copyingLines) return;
    const sourceCount = selectedLineIds.size;
    const targetCount = copyTargetSectionIds.size;
    setCopyingLines(true);
    setError(null);
    setCopyMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/sow/${sow.id}/copy-lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          line_ids: [...selectedLineIds],
          target_section_ids: [...copyTargetSectionIds],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as CopySowLinesResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not copy the selected lines.");

      const copiedBySection = new Map<string, SowLineWithTrade[]>();
      for (const line of body.lines ?? []) {
        copiedBySection.set(line.section_id, [...(copiedBySection.get(line.section_id) ?? []), line]);
      }
      setSections((current) =>
        current.map((section) => {
          const additions = copiedBySection.get(section.id);
          return additions
            ? { ...section, lines: [...section.lines, ...additions].sort((a, b) => a.sort - b.sort) }
            : section;
        })
      );
      setSelectedLineIds(new Set());
      setCopyTargetSectionIds(new Set());
      setCopyDialogOpen(false);
      setCopyMessage(
        `Copied ${sourceCount} line${sourceCount === 1 ? "" : "s"} to ${targetCount} room${targetCount === 1 ? "" : "s"}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not copy the selected lines.");
    } finally {
      setCopyingLines(false);
    }
  }

  async function patchLine(line: SowLineWithTrade, patch: Partial<SowLineWithTrade>): Promise<SowLineWithTrade> {
    const res = await fetch(`/api/sow/lines/${line.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Could not update line.");
    const updated = body.line as SowLineWithTrade;
    setSections((cur) =>
      cur.map((s) =>
        s.id === line.section_id
          ? { ...s, lines: s.lines.map((l) => (l.id === line.id ? updated : l)) }
          : s
      )
    );
    return updated;
  }

  async function deleteLine(line: SowLineWithTrade) {
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
      setSelectedLineIds((current) => {
        const next = new Set(current);
        next.delete(line.id);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove line.");
    }
  }

  /**
   * Reorders lines within one visible trade group. The UI updates
   * immediately; failures reload the revision so partial PATCH
   * success can never leave the screen out of sync with storage.
   */
  async function reorderLines(sectionId: string, lineId: string, destinationIndex: number) {
    if (!sow || reorderingLineSectionId) return;
    const section = sections.find((candidate) => candidate.id === sectionId);
    if (!section) return;

    const displayedLines = groupSowLinesByTrade(section.lines).flatMap((group) => group.lines);
    const reordered = reorderSowLines(displayedLines, lineId, destinationIndex);
    if (reordered === displayedLines) return;

    const originalSort = new Map(section.lines.map((line) => [line.id, line.sort]));
    const changed = reordered.filter((line) => originalSort.get(line.id) !== line.sort);
    setSections((current) =>
      current.map((candidate) =>
        candidate.id === sectionId ? { ...candidate, lines: reordered } : candidate
      )
    );
    setReorderingLineSectionId(sectionId);
    setError(null);

    try {
      await Promise.all(
        changed.map(async (line) => {
          const res = await fetch(`/api/sow/lines/${line.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sort: line.sort }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error ?? "Could not save the new line order.");
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the new line order.");
      await loadSow(sow.id).catch(() => {});
    } finally {
      setReorderingLineSectionId(null);
    }
  }

  // "Trade-scoped SOW extracts" round — which trade chips to offer
  // alongside "Full" in the download group below: presets with >=1
  // tagged line anywhere in the CURRENT revision (BUILD-SPEC.md's own
  // wording). Computed as hooks (before the early returns below) so
  // this component's hook order never changes across renders.
  const taggedTrades = useMemo(() => distinctTaggedTrades(sections), [sections]);
  const extractPresets = useMemo(
    () => presets.filter((p) => taggedTrades.includes(p.name)),
    [presets, taggedTrades]
  );
  const roomSections = useMemo(
    () => sections.filter((section) => section.source_room_id !== null),
    [sections]
  );
  const selectedLines = useMemo(
    () => sections.flatMap((section) => section.lines).filter((line) => selectedLineIds.has(line.id)),
    [sections, selectedLineIds]
  );
  const selectedSourceSectionIds = useMemo(
    () => new Set(selectedLines.map((line) => line.section_id)),
    [selectedLines]
  );
  const copyDestinationRooms = useMemo(
    () => roomSections.filter((section) => !selectedSourceSectionIds.has(section.id)),
    [roomSections, selectedSourceSectionIds]
  );
  const assignmentByRoleKey = useMemo(
    () => new Map(tradeAssignments.map((assignment) => [assignment.role_key, assignment])),
    [tradeAssignments]
  );
  const visibleTradeRoles = useMemo(
    () =>
      [...new Set([
        ...taggedTrades,
        ...tradeAssignments.map((assignment) => assignment.trade_role),
        ...additionalTradeRoles,
      ])].sort((a, b) => a.localeCompare(b)),
    [taggedTrades, tradeAssignments, additionalTradeRoles]
  );

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <p className="text-body text-charcoal/60">Preparing the Scope of Works…</p>
        <div className="h-16 animate-pulse border border-[#dcd6cc] bg-cream" />
        <div className="h-14 animate-pulse border border-[#dcd6cc] bg-offwhite" />
        <div className="h-14 animate-pulse border border-[#dcd6cc] bg-offwhite" />
      </div>
    );
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
  const reorderableRoomSections = roomSections;

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">
          {error}
        </p>
      )}
      {suggestMessage && (
        <p className="border border-[#dcd6cc] bg-cream px-4 py-2 text-caption text-charcoal/70">
          {suggestMessage}
        </p>
      )}
      {copyMessage && (
        <p className="border border-[#dcd6cc] bg-cream px-4 py-2 text-caption text-charcoal/70">
          {copyMessage}
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
              title="Fill only missing standard sections and empty rooms from current plans and FF&E"
            >
              {applyingTemplate ? "Applying…" : "Start from template"}
            </button>
          )}
          {sow && isDraft && (
            <button
              type="button"
              onClick={suggestTradeTags}
              disabled={suggestingTags}
              className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-60"
              title="Auto-tag untagged room-section lines by clause label (e.g. 'WALL TILING —' -> Tiler)"
            >
              {suggestingTags ? "Tagging…" : "Suggest trade tags"}
            </button>
          )}
          {sow && (
            <div className="flex items-center gap-1.5">
              <a
                href={`/api/projects/${projectId}/sow/${sow.id}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
                title={extractPresets.length > 0 ? "Download the full Scope of Works" : "Download PDF"}
              >
                {extractPresets.length > 0 ? "Full" : "Download PDF"}
              </a>
              {/* "Trade-scoped SOW extracts" round — one chip per preset
                  with >=1 tagged line in this revision, each a condensed
                  extract PDF (General Notes + Exclusions in full, every
                  other section filtered to that trade's tagged lines —
                  see lib/sow-trade-tags.ts's filterSectionsForTrade()). */}
              {extractPresets.map((preset) => (
                <a
                  key={preset.name}
                  href={`/api/projects/${projectId}/sow/${sow.id}/pdf?trade=${encodeURIComponent(preset.name)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="border border-sand bg-sand/15 px-3 py-2 text-caption text-charcoal transition-colors hover:bg-sand hover:text-white"
                  title={`Download the ${preset.name} scope extract`}
                >
                  {preset.name}
                </a>
              ))}
            </div>
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

      {sow && (
        <SowQualityReview
          report={quality}
          loading={qualityLoading}
          isDraft={isDraft}
          onRefresh={() => void loadQuality(sow.id).catch((err) => {
            setError(err instanceof Error ? err.message : "Could not run the pre-issue review.");
          })}
          onSelectSection={scrollToSection}
        />
      )}

      {!isDraft && sow && (
        <p className="border border-[#dcd6cc] bg-cream px-4 py-2 text-caption text-charcoal/60">
          {sow.revision_label} was issued
          {sow.issued_at ? ` on ${new Date(sow.issued_at).toLocaleDateString("en-AU")}` : ""} and
          is now read-only. Use &quot;New revision&quot; above to make further changes.
        </p>
      )}

      <ProjectTradeTeamPanel
        tradeRoles={visibleTradeRoles}
        scopeTradeRoles={taggedTrades}
        presets={presets}
        contacts={tradeContacts}
        assignmentsByRoleKey={assignmentByRoleKey}
        savingRole={assignmentSavingRole}
        error={assignmentError}
        onAssign={(tradeRole, contactId) => void setTradeAssignment(tradeRole, contactId)}
        onAddRole={(tradeRole) =>
          setAdditionalTradeRoles((current) =>
            current.includes(tradeRole) ? current : [...current, tradeRole]
          )
        }
      />

      {isDraft && selectedLines.length > 0 && (
        <div className="sticky top-16 z-20 flex flex-wrap items-center justify-between gap-3 border border-nearblack bg-nearblack px-4 py-3 text-white shadow-lg">
          <p className="text-body font-semibold">
            {selectedLines.length} line{selectedLines.length === 1 ? "" : "s"} selected
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setCopyTargetSectionIds(new Set());
                setCopyDialogOpen(true);
              }}
              disabled={copyDestinationRooms.length === 0}
              className="bg-white px-4 py-2 text-subhead text-nearblack hover:bg-cream disabled:cursor-not-allowed disabled:opacity-40"
            >
              Copy to rooms
            </button>
            <button
              type="button"
              onClick={() => setSelectedLineIds(new Set())}
              className="border border-white/50 px-4 py-2 text-subhead text-white hover:border-white"
            >
              Clear
            </button>
          </div>
        </div>
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
              {sections.map((section, sectionIndex) => {
                const roomIndex = reorderableRoomSections.findIndex(
                  (candidate) => candidate.id === section.id
                );
                return (
                  <div key={section.id} id={sectionAnchorId(section.id)} className="scroll-mt-24">
                    <SectionBlock
                      section={section}
                      defaultExpanded={
                        sectionIndex === 0 ||
                        (section.source_room_id !== null && section.id === roomSections[0]?.id)
                      }
                      readOnly={!isDraft}
                      presetNames={presets.map((p) => p.name)}
                      assignmentsByRoleKey={assignmentByRoleKey}
                      onRename={(heading) => renameSection(section.id, heading)}
                      onDelete={() => deleteSection(section.id, section.heading)}
                      canMoveUp={roomIndex > 0}
                      canMoveDown={
                        roomIndex >= 0 && roomIndex < reorderableRoomSections.length - 1
                      }
                      roomReordering={reorderingRoomSectionId !== null}
                      onMoveUp={() => moveRoomSection(section.id, -1)}
                      onMoveDown={() => moveRoomSection(section.id, 1)}
                      onAddLine={(text, kind, trade) =>
                        addLine(section.id, text, kind, trade)
                      }
                      onPatchLine={patchLine}
                      onDeleteLine={deleteLine}
                      onReorderLine={(lineId, destinationIndex) =>
                        reorderLines(section.id, lineId, destinationIndex)
                      }
                      lineReordering={reorderingLineSectionId === section.id}
                      selectedLineIds={selectedLineIds}
                      onToggleLineSelection={toggleLineSelection}
                    />
                  </div>
                );
              })}
            </div>

            {isDraft && <AddSectionForm onAdd={addSection} />}
          </div>
        </div>
      )}

      {sections.length === 0 && isDraft && <AddSectionForm onAdd={addSection} />}

      {copyDialogOpen && (
        <CopyLinesToRoomsDialog
          selectedLineCount={selectedLines.length}
          rooms={copyDestinationRooms}
          selectedRoomIds={copyTargetSectionIds}
          copying={copyingLines}
          onToggleRoom={toggleCopyTarget}
          onSelectAll={() => setCopyTargetSectionIds(new Set(copyDestinationRooms.map((room) => room.id)))}
          onClearRooms={() => setCopyTargetSectionIds(new Set())}
          onClose={() => {
            if (!copyingLines) setCopyDialogOpen(false);
          }}
          onCopy={() => void copySelectedLines()}
        />
      )}
    </div>
  );
}

function SowQualityReview({
  report,
  loading,
  isDraft,
  onRefresh,
  onSelectSection,
}: {
  report: SowQualityReport | null;
  loading: boolean;
  isDraft: boolean;
  onRefresh: () => void;
  onSelectSection: (sectionId: string) => void;
}) {
  const findings = report ? [...report.blockers, ...report.warnings] : [];
  return (
    <section
      id="sow-quality-review"
      className="scroll-mt-24 border border-[#c9c2b4] bg-nearwhite px-5 py-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-caps !text-sand">{isDraft ? "Pre-issue review" : "Document review"}</p>
          <p className="mt-1 text-body text-charcoal/70">
            {!report
              ? "Checking the room scope against FF&E and all current plan analyses…"
              : report.ready_to_issue
                ? `No issue blockers. ${report.warnings.length} review warning${report.warnings.length === 1 ? " remains" : "s remain"}.`
                : `${report.blockers.length} issue blocker${report.blockers.length === 1 ? "" : "s"} and ${report.warnings.length} review warning${report.warnings.length === 1 ? "" : "s"}.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {report && (
            <span
              className={clsx(
                "label-caps px-2 py-1",
                report.ready_to_issue ? "bg-[#edf5e8] !text-[#3B6D11]" : "bg-[#fff1e5] !text-[#9a4f0b]"
              )}
            >
              {report.ready_to_issue ? "Ready for final review" : "Not ready to issue"}
            </span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack disabled:opacity-50"
          >
            {loading ? "Checking…" : "Recheck"}
          </button>
        </div>
      </div>

      {report && (
        <>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-[#e1ddd5] pt-3 text-caption text-charcoal/60">
            <span>{report.summary.lines} lines</span>
            <span>{report.summary.active_rooms} rooms</span>
            <span>
              {report.summary.referenced_ffe_items} of {report.summary.assigned_ffe_items} assigned FF&amp;E items referenced
            </span>
            <span>{report.summary.analysed_plan_files} plan files analysed</span>
          </div>

          {findings.length > 0 && (
            <details className="mt-3" open={!report.ready_to_issue}>
              <summary className="cursor-pointer text-subhead text-nearblack">
                Review {findings.length} finding{findings.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-3 space-y-2">
                {findings.map((finding, index) => (
                  <li
                    key={`${finding.code}-${finding.section_id ?? finding.plan_filename ?? index}-${index}`}
                    className={clsx(
                      "border-l-2 px-3 py-2",
                      finding.severity === "blocker"
                        ? "border-[#9a4f0b] bg-[#fff8f1]"
                        : "border-sand bg-offwhite"
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-body font-semibold text-nearblack">
                          {finding.severity === "blocker" ? "Blocker — " : "Check — "}{finding.title}
                        </p>
                        <p className="mt-0.5 text-caption text-charcoal/65">
                          {finding.detail.length > 360 ? `${finding.detail.slice(0, 357)}…` : finding.detail}
                        </p>
                        {finding.item_codes && finding.item_codes.length > 0 && (
                          <p className="mt-1 break-words text-caption text-charcoal/50">
                            {finding.item_codes.slice(0, 16).join(", ")}
                            {finding.item_codes.length > 16 ? ` +${finding.item_codes.length - 16} more` : ""}
                          </p>
                        )}
                      </div>
                      {finding.section_id && (
                        <button
                          type="button"
                          onClick={() => onSelectSection(finding.section_id!)}
                          className="shrink-0 border border-[#c9c2b4] px-2 py-1 text-caption text-charcoal hover:border-nearblack"
                        >
                          Go to room
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function ProjectTradeTeamPanel({
  tradeRoles,
  scopeTradeRoles,
  presets,
  contacts,
  assignmentsByRoleKey,
  savingRole,
  error,
  onAssign,
  onAddRole,
}: {
  tradeRoles: string[];
  scopeTradeRoles: string[];
  presets: ExportPresetRow[];
  contacts: ProjectTradeContact[];
  assignmentsByRoleKey: ReadonlyMap<string, ProjectTradeAssignment>;
  savingRole: string | null;
  error: string | null;
  onAssign: (tradeRole: string, contactId: string | null) => void;
  onAddRole: (tradeRole: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [newRole, setNewRole] = useState("");
  const scopeRoleKeys = new Set(scopeTradeRoles.map((role) => role.trim().toLowerCase()));
  const visibleRoleKeys = new Set(tradeRoles.map((role) => role.trim().toLowerCase()));
  const availableRoles = presets.filter(
    (preset) => !visibleRoleKeys.has(preset.name.trim().toLowerCase())
  );
  const assignedCount = tradeRoles.filter(
    (role) => assignmentsByRoleKey.get(role.trim().toLowerCase())?.contact
  ).length;

  function sortedContactsForRole(tradeRole: string): ProjectTradeContact[] {
    const preset = presets.find(
      (candidate) => candidate.name.trim().toLowerCase() === tradeRole.trim().toLowerCase()
    );
    return [...contacts].sort((a, b) => {
      const aMatches = preset ? contactMatchesPreset(preset, a.category) : false;
      const bMatches = preset ? contactMatchesPreset(preset, b.category) : false;
      if (aMatches !== bMatches) return aMatches ? -1 : 1;
      return a.company.localeCompare(b.company);
    });
  }

  return (
    <section className="border border-[#dcd6cc] bg-nearwhite">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-cream/60"
        aria-expanded={expanded}
      >
        <span>
          <span className="label-caps block !text-nearblack">Project trade team</span>
          <span className="text-caption text-charcoal/55">
            Choose once here; Scope and unbooked Work tasks reuse the same contractor.
          </span>
        </span>
        <span className="flex items-center gap-3 text-caption text-charcoal/55">
          {assignedCount} of {tradeRoles.length} assigned
          <span aria-hidden>{expanded ? "−" : "+"}</span>
        </span>
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-[#dcd6cc] px-4 py-4">
          {error && (
            <p className="border border-red-700/30 bg-red-50 px-3 py-2 text-caption text-red-700">
              {error}
            </p>
          )}

          {tradeRoles.length === 0 ? (
            <p className="text-body text-charcoal/55">
              No trade roles are tagged in this scope yet. Add one below, or use
              &quot;Suggest trade tags&quot; first.
            </p>
          ) : (
            <div className="grid gap-2 lg:grid-cols-2">
              {tradeRoles.map((tradeRole) => {
                const assignment = assignmentsByRoleKey.get(tradeRole.trim().toLowerCase());
                const saving = savingRole === tradeRole;
                return (
                  <div
                    key={tradeRole}
                    className="flex flex-wrap items-center justify-between gap-3 border border-[#e5e0d6] bg-offwhite px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-body font-medium text-nearblack">{tradeRole}</p>
                      <p className="text-caption text-charcoal/45">
                        {scopeRoleKeys.has(tradeRole.trim().toLowerCase())
                          ? "Used in this scope"
                          : "Project team"}
                        {assignment?.contact ? " · feeds unbooked Work tasks" : " · contractor missing"}
                      </p>
                    </div>
                    <fieldset disabled={saving} className="min-w-0">
                      <ContactPicker
                        contacts={sortedContactsForRole(tradeRole)}
                        selectedId={assignment?.contact_id ?? null}
                        placeholder={saving ? "Saving…" : "Assign contractor"}
                        onSelect={(contactId) => onAssign(tradeRole, contactId)}
                      />
                    </fieldset>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-[#e5e0d6] pt-3">
            {availableRoles.length > 0 && (
              <select
                value={newRole}
                onChange={(event) => {
                  const role = event.target.value;
                  setNewRole("");
                  if (role) onAddRole(role);
                }}
                className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-caption text-charcoal focus:border-nearblack focus:outline-none"
                aria-label="Add another project trade role"
              >
                <option value="">+ Add another trade</option>
                {availableRoles.map((preset) => (
                  <option key={preset.name} value={preset.name}>
                    {preset.name}
                  </option>
                ))}
              </select>
            )}
            <a href="/contacts" className="text-caption text-charcoal/55 underline hover:text-nearblack">
              Open Address Book
            </a>
          </div>
        </div>
      )}
    </section>
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
  sections: SowSectionWithTradedLines[];
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

function CopyLinesToRoomsDialog({
  selectedLineCount,
  rooms,
  selectedRoomIds,
  copying,
  onToggleRoom,
  onSelectAll,
  onClearRooms,
  onClose,
  onCopy,
}: {
  selectedLineCount: number;
  rooms: SowSectionWithTradedLines[];
  selectedRoomIds: ReadonlySet<string>;
  copying: boolean;
  onToggleRoom: (sectionId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClearRooms: () => void;
  onClose: () => void;
  onCopy: () => void;
}) {
  const copyCount = selectedLineCount * selectedRoomIds.size;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-nearblack/55 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-sow-lines-title"
        className="w-full max-w-xl border border-nearblack bg-offwhite shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#dcd6cc] bg-cream px-5 py-4">
          <div>
            <h2 id="copy-sow-lines-title" className="text-subhead font-semibold text-nearblack">
              Copy selected lines to rooms
            </h2>
            <p className="mt-1 text-caption text-charcoal/65">
              Choose one or more destination rooms. Line wording, type, and trade will be preserved.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={copying}
            aria-label="Close copy dialog"
            className="text-xl leading-none text-charcoal/50 hover:text-nearblack disabled:opacity-30"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="label-caps !text-nearblack">Destination rooms</p>
            <div className="flex items-center gap-3 text-caption">
              <button type="button" onClick={onSelectAll} className="text-sand hover:text-nearblack">
                Select all
              </button>
              <button type="button" onClick={onClearRooms} className="text-charcoal/55 hover:text-nearblack">
                Clear
              </button>
            </div>
          </div>
          <div className="max-h-[45vh] overflow-y-auto border border-[#dcd6cc] bg-white">
            {rooms.map((room) => (
              <label
                key={room.id}
                className="flex cursor-pointer items-center gap-3 border-b border-[#e5e0d6] px-4 py-3 last:border-b-0 hover:bg-cream/50"
              >
                <input
                  type="checkbox"
                  checked={selectedRoomIds.has(room.id)}
                  onChange={(event) => onToggleRoom(room.id, event.target.checked)}
                  className="h-4 w-4 accent-nearblack"
                />
                <span className="text-body text-nearblack">{room.heading}</span>
              </label>
            ))}
          </div>
          <p className="mt-3 text-caption text-charcoal/60">
            {selectedLineCount} selected line{selectedLineCount === 1 ? "" : "s"} × {selectedRoomIds.size} room{selectedRoomIds.size === 1 ? "" : "s"}
            {copyCount > 0 ? ` = ${copyCount} new line${copyCount === 1 ? "" : "s"}` : ""}
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-[#dcd6cc] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={copying}
            className="border border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal hover:border-nearblack disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCopy}
            disabled={copying || selectedRoomIds.size === 0}
            className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copying ? "Copying…" : `Copy to ${selectedRoomIds.size || 0} room${selectedRoomIds.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
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
  defaultExpanded,
  readOnly,
  presetNames,
  assignmentsByRoleKey,
  onRename,
  onDelete,
  canMoveUp,
  canMoveDown,
  roomReordering,
  onMoveUp,
  onMoveDown,
  onAddLine,
  onPatchLine,
  onDeleteLine,
  onReorderLine,
  lineReordering,
  selectedLineIds,
  onToggleLineSelection,
}: {
  section: SowSectionWithTradedLines;
  defaultExpanded: boolean;
  readOnly: boolean;
  /** "Trade-scoped SOW extracts" round — the trade `<select>`'s option list, threaded down to every LineRow. */
  presetNames: string[];
  assignmentsByRoleKey: ReadonlyMap<string, ProjectTradeAssignment>;
  onRename: (heading: string) => Promise<void>;
  onDelete: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  roomReordering: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAddLine: (text: string, kind: SowLineKind, trade: string | null) => Promise<void>;
  onPatchLine: (line: SowLineWithTrade, patch: Partial<SowLineWithTrade>) => Promise<SowLineWithTrade>;
  onDeleteLine: (line: SowLineWithTrade) => void;
  onReorderLine: (lineId: string, destinationIndex: number) => Promise<void>;
  lineReordering: boolean;
  selectedLineIds: ReadonlySet<string>;
  onToggleLineSelection: (lineId: string, checked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [draggedLineId, setDraggedLineId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const lineGroups = groupSowLinesByTrade(section.lines);
  const displayedLines = lineGroups.flatMap((group) => group.lines);
  const hasTradeHeadings = lineGroups.some((group) => group.trade !== null);
  const hasUnassignedGroup = lineGroups.some((group) => group.trade === null);
  const sectionTrade =
    presetNames.find(
      (name) => name.trim().toLowerCase() === section.heading.trim().toLowerCase()
    ) ?? null;

  function tradeKey(line: SowLineWithTrade): string | null {
    return line.trade?.trim() || null;
  }

  function clearDragState() {
    setDraggedLineId(null);
    setDropTargetId(null);
  }

  function dropBefore(targetLineId: string) {
    if (!draggedLineId || draggedLineId === targetLineId || lineReordering) {
      clearDragState();
      return;
    }
    const sourceLine = displayedLines.find((line) => line.id === draggedLineId);
    const targetLine = displayedLines.find((line) => line.id === targetLineId);
    const sourceIndex = displayedLines.findIndex((line) => line.id === draggedLineId);
    const targetIndex = displayedLines.findIndex((line) => line.id === targetLineId);
    if (
      !sourceLine ||
      !targetLine ||
      tradeKey(sourceLine) !== tradeKey(targetLine) ||
      sourceIndex === -1 ||
      targetIndex === -1
    ) {
      clearDragState();
      return;
    }
    const destinationIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    const lineId = draggedLineId;
    clearDragState();
    void onReorderLine(lineId, destinationIndex);
  }

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
          {readOnly || section.source_room_id !== null ? (
            <p className="label-caps !text-nearblack">{section.heading}</p>
          ) : (
            <SectionHeadingEditor heading={section.heading} onRename={onRename} />
          )}
        </div>
        <div className="flex items-center gap-4">
          {!readOnly && (canMoveUp || canMoveDown) && (
            <div className="flex items-center gap-1" aria-label={`Reorder ${section.heading}`}>
              <span className="mr-1 text-caption text-charcoal/45">Room order</span>
              <button
                type="button"
                onClick={onMoveUp}
                disabled={!canMoveUp || roomReordering}
                className="border border-[#c9c2b4] px-2 py-0.5 text-caption text-charcoal transition-colors hover:border-nearblack hover:text-nearblack disabled:cursor-not-allowed disabled:opacity-30"
                title={`Move ${section.heading} up`}
                aria-label={`Move ${section.heading} up`}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={onMoveDown}
                disabled={!canMoveDown || roomReordering}
                className="border border-[#c9c2b4] px-2 py-0.5 text-caption text-charcoal transition-colors hover:border-nearblack hover:text-nearblack disabled:cursor-not-allowed disabled:opacity-30"
                title={`Move ${section.heading} down`}
                aria-label={`Move ${section.heading} down`}
              >
                ↓
              </button>
            </div>
          )}
          <span className="text-caption text-charcoal/50">
            {section.lines.length} {section.lines.length === 1 ? "line" : "lines"}
          </span>
          {!readOnly && section.source_room_id === null && (
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
        <div>
          {lineGroups.map((group, groupIndex) => {
            const groupStartIndex = lineGroups
              .slice(0, groupIndex)
              .reduce((total, candidate) => total + candidate.lines.length, 0);
            const draggedLine = displayedLines.find((line) => line.id === draggedLineId);
            const draggingThisGroup = draggedLine && tradeKey(draggedLine) === group.trade;
            const tradeAssignment = group.trade
              ? assignmentsByRoleKey.get(group.trade.trim().toLowerCase())
              : null;

            return (
              <div
                key={group.trade === null ? "unassigned" : `trade:${group.trade}`}
                className={groupIndex > 0 ? "border-t border-[#dcd6cc]" : undefined}
              >
                {hasTradeHeadings && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#dcd6cc] bg-offwhite px-4 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="label-caps font-semibold !text-nearblack">
                        {section.heading} — {group.trade ?? "General"}
                      </p>
                      {group.trade && (
                        <span
                          className={clsx(
                            "border px-2 py-0.5 text-caption",
                            tradeAssignment?.contact
                              ? "border-[#c9c2b4] text-charcoal/65"
                              : "border-[#BA7517]/40 text-[#9A5D0D]"
                          )}
                        >
                          {tradeAssignment?.contact?.company ?? "Contractor not assigned"}
                        </span>
                      )}
                    </div>
                    <span className="text-caption text-charcoal/45">
                      {group.lines.length} {group.lines.length === 1 ? "line" : "lines"}
                    </span>
                  </div>
                )}
                <div className="divide-y divide-[#e5e0d6]">
                  {group.lines.map((line, lineIndex) => {
                    const displayIndex = groupStartIndex + lineIndex;
                    return (
                      <LineRow
                        key={line.id}
                        line={line}
                        readOnly={readOnly}
                        presetNames={presetNames}
                        onPatch={(patch) => onPatchLine(line, patch)}
                        onDelete={() => onDeleteLine(line)}
                        selected={selectedLineIds.has(line.id)}
                        onSelect={(checked) => onToggleLineSelection(line.id, checked)}
                        dragging={draggedLineId === line.id}
                        dropTarget={dropTargetId === line.id && draggedLineId !== line.id}
                        reordering={lineReordering}
                        canMoveUp={lineIndex > 0}
                        canMoveDown={lineIndex < group.lines.length - 1}
                        onMoveUp={() => void onReorderLine(line.id, displayIndex - 1)}
                        onMoveDown={() => void onReorderLine(line.id, displayIndex + 1)}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", line.id);
                          setDraggedLineId(line.id);
                        }}
                        onDragEnd={clearDragState}
                        onDragOver={(event) => {
                          if (!draggedLine || lineReordering || tradeKey(draggedLine) !== group.trade) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          setDropTargetId(line.id);
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          dropBefore(line.id);
                        }}
                      />
                    );
                  })}
                </div>
                {!readOnly && draggingThisGroup && group.lines.length > 1 && (
                  <div
                    className="h-8 border-t-2 border-dashed border-sand bg-sand/10 text-center text-caption leading-8 text-charcoal"
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropTargetId(null);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const lineId = draggedLineId;
                      clearDragState();
                      if (lineId) void onReorderLine(lineId, groupStartIndex + group.lines.length - 1);
                    }}
                  >
                    Drop at end of {group.trade ?? "General"}
                  </div>
                )}
                {!readOnly && (
                  <DraftLineRow
                    presetNames={presetNames}
                    sectionTrade={group.trade}
                    lockTrade={group.trade !== null}
                    onAdd={onAddLine}
                  />
                )}
              </div>
            );
          })}
          {!readOnly && lineGroups.length === 0 && (
            <DraftLineRow
              presetNames={presetNames}
              sectionTrade={sectionTrade}
              onAdd={onAddLine}
            />
          )}
          {!readOnly && lineGroups.length > 0 && !hasUnassignedGroup && (
            <DraftLineRow
              presetNames={presetNames}
              sectionTrade={sectionTrade}
              onAdd={onAddLine}
            />
          )}
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
 * to the fields a SOW line has (text, kind, and — "Trade-scoped SOW
 * extracts" round — trade). Kind/trade toggles act immediately (a
 * single discrete click/select, not accumulated typing), exactly like
 * EstimateView's item/measurement link buttons.
 */
function LineRow({
  line,
  readOnly,
  presetNames,
  onPatch,
  onDelete,
  selected,
  onSelect,
  dragging,
  dropTarget,
  reordering,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  line: SowLineWithTrade;
  readOnly: boolean;
  /** "Trade-scoped SOW extracts" round — the trade select's option list (current preset names) + blank ("— trade —", clears the tag). */
  presetNames: string[];
  onPatch: (patch: Partial<SowLineWithTrade>) => Promise<SowLineWithTrade>;
  onDelete: () => void;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  dragging: boolean;
  dropTarget: boolean;
  reordering: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
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

  /** "Trade-scoped SOW extracts" round — the compact trade select's onChange; an empty option value clears the tag (`trade: null`), same "explicit null clears" convention PATCH /api/sow/lines/[lineId] uses. */
  async function setTrade(trade: string) {
    setRowError(null);
    try {
      await onPatch({ trade: trade || null });
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Could not update this line's trade tag.");
    }
  }

  if (readOnly) {
    return (
      <div className="flex items-start gap-3 px-4 py-2">
        <span
          className={clsx(
            "label-caps mt-0.5 w-20 shrink-0 !text-charcoal",
            line.kind === "exclusion" && "!text-[#A32D2D]",
            line.kind === "note" && "!text-charcoal/70"
          )}
        >
          {KIND_LABEL[line.kind]}
        </span>
        <p className={clsx("flex-1 text-body text-nearblack", line.kind === "note" && "italic text-charcoal/80")}>
          {line.text}
        </p>
        {/* "Trade-scoped SOW extracts" round — small sand chip, read-only display only (no select once the SOW is issued). */}
        {line.trade && (
          <span className="mt-0.5 shrink-0 border border-nearblack bg-nearblack px-2 py-0.5 text-caption font-semibold text-white">
            {line.trade}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={clsx(
        "flex items-start gap-2 border-t-2 border-transparent px-4 py-2 transition-colors",
        dirty && "bg-cream/60",
        dragging && "opacity-40",
        dropTarget && "border-t-sand bg-sand/10"
      )}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={(event) => onSelect(event.target.checked)}
        aria-label={`Select line for copying: ${line.text}`}
        title="Select this line to copy it to other rooms"
        className="mt-2 h-4 w-4 shrink-0 accent-nearblack"
      />
      <button
        type="button"
        draggable={!reordering}
        disabled={reordering}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        aria-label={`Drag to reorder: ${line.text}`}
        title="Drag to reorder"
        className="mt-1 shrink-0 cursor-grab select-none px-1 text-body text-charcoal/35 hover:text-nearblack active:cursor-grabbing disabled:cursor-wait"
      >
        ⠿
      </button>
      <select
        value={line.kind}
        onChange={(e) => setKind(e.target.value as SowLineKind)}
        className={clsx(
          "label-caps mt-1 w-24 shrink-0 border-none bg-transparent !text-charcoal focus:outline-none",
          line.kind === "exclusion" && "!text-[#A32D2D]",
          line.kind === "note" && "!text-charcoal/70"
        )}
      >
        <option value="inclusion">Inclusion</option>
        <option value="exclusion">Exclusion</option>
        <option value="note">Note</option>
      </select>
      {/* "Trade-scoped SOW extracts" round — compact trade select;
          renders as a small sand chip once a value is set (BUILD-
          SPEC's own "display as small sand chip when set"), a plain
          muted outline while blank. */}
      <select
        value={line.trade ?? ""}
        onChange={(e) => setTrade(e.target.value)}
        title="Trade tag — drives which extract PDF this line appears in"
        className={clsx(
          "label-caps mt-1 w-28 shrink-0 border px-1.5 py-0.5 text-caption font-semibold focus:outline-none focus:ring-2 focus:ring-sand/50",
          line.trade
            ? "border-nearblack bg-nearblack !text-white"
            : "border-charcoal bg-white !text-charcoal"
        )}
      >
        <option value="" className="bg-white text-nearblack">— trade —</option>
        {/* A line tagged with a preset name that no longer exists
            (renamed/deleted since tagging) still shows its actual
            value here rather than silently rendering blank — the tag
            itself is untouched either way (see migration
            044_sow_trade_tags.sql's own comment for why `trade` isn't
            a constrained lookup). */}
        {line.trade && !presetNames.includes(line.trade) && (
          <option value={line.trade} className="bg-white text-nearblack">
            {line.trade} (no longer a preset)
          </option>
        )}
        {presetNames.map((name) => (
          <option key={name} value={name} className="bg-white text-nearblack">
            {name}
          </option>
        ))}
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
            "w-full border-none bg-transparent px-1 py-1 text-body text-nearblack focus:bg-nearwhite focus:outline-none",
            line.kind === "note" && "italic text-charcoal/80"
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
      <div className="mt-0.5 flex shrink-0 flex-col leading-none">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={!canMoveUp || reordering}
          aria-label={`Move ${line.text} up`}
          title="Move up"
          className="px-1 text-caption text-charcoal/35 hover:text-nearblack disabled:opacity-20"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={!canMoveDown || reordering}
          aria-label={`Move ${line.text} down`}
          title="Move down"
          className="px-1 text-caption text-charcoal/35 hover:text-nearblack disabled:opacity-20"
        >
          ↓
        </button>
      </div>
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
  presetNames,
  sectionTrade,
  lockTrade = false,
  onAdd,
}: {
  presetNames: string[];
  /** Exact preset-name match for the enclosing section heading. */
  sectionTrade: string | null;
  /** A trade-group row always creates a line for that group. */
  lockTrade?: boolean;
  onAdd: (text: string, kind: SowLineKind, trade: string | null) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<SowLineKind>("inclusion");
  // null means "use the enclosing section's automatic trade"; a
  // string (including "") is an explicit choice by the user.
  const [tradeChoice, setTradeChoice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trade = tradeChoice ?? sectionTrade ?? "";

  async function submit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd(text.trim(), kind, trade || null);
      setText("");
      setTradeChoice(null);
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
      {!lockTrade && (
        <select
          value={trade}
          onChange={(e) => setTradeChoice(e.target.value)}
          title={
            sectionTrade
              ? `New lines in this section are automatically tagged ${sectionTrade}`
              : "Trade tag for the new line"
          }
          aria-label="Trade for new line"
          className={clsx(
            "label-caps mt-1 w-28 shrink-0 border px-1.5 py-0.5 text-caption focus:outline-none",
            trade
              ? "border-nearblack bg-nearblack text-white"
              : "border-[#c9c2b4] bg-transparent text-charcoal/40"
          )}
        >
          <option value="">— trade —</option>
          {presetNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      )}
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
          placeholder={trade ? `+ Add line to ${trade}…` : "+ Add line…"}
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
