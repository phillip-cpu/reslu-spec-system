"use client";

import { useEffect, useState } from "react";
import { DesignPhaseSection } from "./DesignPhaseSection";
import { WdPackageHingePanel } from "./WdPackageHingePanel";
import { shouldShowWdPackageHinge } from "@/lib/design-framework";
import type {
  DesignAssigneeSummary,
  DesignFrameworkResponse,
  DesignPhaseWithTasks,
  DesignTaskWithAssignees,
} from "@/types/phase-12b";

interface Props {
  projectId: string;
  /** Signed-in user's profile id, fetched server-side by the page component (same pattern as OfficeBoard/ProjectBoard's currentUserId — there is no GET /api/profiles list/me route in this codebase, per types/phase-13.ts's OfficeTeamMember doc comment) — used only to pre-check the add-task composer's "assign to me" default. */
  currentUserId: string;
}

/**
 * The Design tab — BUILD-SPEC.md §"12b Design Framework": "Design tab
 * on projects: phase checklist/kanban with per-phase tasks, deadlines,
 * assignees (multi, auto-assign creator per Board v2), completion
 * rolling into overview traffic lights." This task's brief further
 * specifies the layout: "vertical phase sections (consistent with the
 * new vertical-board pattern) — each phase: status control ... task
 * list ... add-task composer, phase progress chip."
 *
 * Self-contained: fetches its own data from
 * GET /api/projects/[id]/design (which seeds the 7 brief phases on a
 * project's first visit — see that route's doc comment) so the
 * server page component stays a thin shell, same split as
 * ProjectOverview / OfficeBoard.
 *
 * Fixed order, not reorderable (BUILD-SPEC.md: "Phases reorderable? No
 * — fixed brief order, keep simple") — phases render in the order the
 * API returns them (already sorted by `sort`), with no drag handles.
 */
export function DesignTab({ projectId, currentUserId }: Props) {
  const [phases, setPhases] = useState<DesignPhaseWithTasks[]>([]);
  const [team, setTeam] = useState<DesignAssigneeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/projects/${projectId}/design`)
      .then((r) => r.json())
      .then((body) => {
        if (!active) return;
        if (body.error) throw new Error(body.error);
        const design = body as DesignFrameworkResponse;
        setPhases(design.phases);
        setTeam(design.team);
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : "Could not load Design tab."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [projectId]);

  async function patchPhaseStatus(phaseId: string, status: string) {
    const prev = phases;
    setPhases((cur) => cur.map((p) => (p.id === phaseId ? { ...p, status: status as DesignPhaseWithTasks["status"] } : p)));
    try {
      const res = await fetch(`/api/design-phases/${phaseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update phase status.");
      const { phase } = await res.json();
      setPhases((cur) => cur.map((p) => (p.id === phaseId ? { ...p, ...phase } : p)));
    } catch (err) {
      setPhases(prev);
      setError(err instanceof Error ? err.message : "Could not update phase status.");
    }
  }

  async function dismissHinge(phaseId: string) {
    setPhases((cur) => cur.map((p) => (p.id === phaseId ? { ...p, hinge_dismissed_at: new Date().toISOString() } : p)));
    await fetch(`/api/design-phases/${phaseId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hinge_dismissed: true }),
    }).catch(() => {});
  }

  async function addTask(phaseId: string, title: string, assigneeIds: string[], dueDate: string | null) {
    setError(null);
    try {
      const res = await fetch("/api/design-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          design_phase_id: phaseId,
          title,
          due_date: dueDate,
          assignee_ids: assigneeIds,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add task.");
      const { task } = await res.json();
      setPhases((cur) => cur.map((p) => (p.id === phaseId ? { ...p, tasks: [...p.tasks, task] } : p)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add task.");
    }
  }

  function applyTaskPatch(phaseId: string, taskId: string, patch: Partial<DesignTaskWithAssignees>) {
    setPhases((cur) =>
      cur.map((p) =>
        p.id === phaseId ? { ...p, tasks: p.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) } : p
      )
    );
  }

  async function patchTask(
    phaseId: string,
    task: DesignTaskWithAssignees,
    patch: Record<string, unknown>,
    refUpdate?: Partial<DesignTaskWithAssignees>
  ) {
    const prev = phases;
    if (refUpdate) applyTaskPatch(phaseId, task.id, refUpdate);
    else applyTaskPatch(phaseId, task.id, patch as Partial<DesignTaskWithAssignees>);
    setError(null);
    try {
      const res = await fetch(`/api/design-tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update task.");
      const { task: updated } = await res.json();
      applyTaskPatch(phaseId, task.id, { ...updated, ...refUpdate });
    } catch (err) {
      setPhases(prev);
      setError(err instanceof Error ? err.message : "Could not update task.");
    }
  }

  async function deleteTask(phaseId: string, taskId: string) {
    const prev = phases;
    setPhases((cur) => cur.map((p) => (p.id === phaseId ? { ...p, tasks: p.tasks.filter((t) => t.id !== taskId) } : p)));
    const res = await fetch(`/api/design-tasks/${taskId}`, { method: "DELETE" });
    if (!res.ok) {
      setPhases(prev);
      setError("Could not remove task.");
    }
  }

  if (loading) {
    return <p className="text-body text-charcoal/50">Loading Design tab…</p>;
  }
  if (error && phases.length === 0) {
    return <p className="text-body text-red-700">{error}</p>;
  }

  const wdPackage = phases.find((p) => p.name === "WD Package");

  // Backfill affordance (Phillip, 7 Jul): projects whose design phases
  // seeded before task templates existed show headings only. Offer a
  // one-click template apply whenever every phase is empty; the POST is
  // idempotent (server only fills phases with zero tasks).
  const totalTasks = phases.reduce((n, p) => n + p.tasks.length, 0);
  const applyTemplate = async () => {
    const res = await fetch(`/api/projects/${projectId}/design`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "Could not apply templates.");
      return;
    }
    const fresh = await fetch(`/api/projects/${projectId}/design`).then((r) => r.json());
    if (!fresh.error) setPhases((fresh as DesignFrameworkResponse).phases);
  };

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>
      )}

      {totalTasks === 0 && phases.length > 0 && (
        <div className="flex items-center justify-between border border-[#dcd6cc] bg-offwhite px-4 py-3">
          <p className="text-body text-charcoal/70">
            Phases have no tasks yet — pre-fill each phase from your design task templates?
          </p>
          <button
            type="button"
            onClick={applyTemplate}
            className="border border-nearblack px-4 py-1.5 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
          >
            Apply templates
          </button>
        </div>
      )}

      {wdPackage && shouldShowWdPackageHinge(phases) && (
        <WdPackageHingePanel
          projectId={projectId}
          onDismiss={() => dismissHinge(wdPackage.id)}
        />
      )}

      <div className="space-y-4">
        {phases.map((phase) => (
          <DesignPhaseSection
            key={phase.id}
            phase={phase}
            team={team}
            currentUserId={currentUserId}
            onStatusChange={(status) => patchPhaseStatus(phase.id, status)}
            onAddTask={(title, assigneeIds, dueDate) => addTask(phase.id, title, assigneeIds, dueDate)}
            onPatchTask={(task, patch, refUpdate) => patchTask(phase.id, task, patch, refUpdate)}
            onDeleteTask={(taskId) => deleteTask(phase.id, taskId)}
          />
        ))}
      </div>
    </div>
  );
}
