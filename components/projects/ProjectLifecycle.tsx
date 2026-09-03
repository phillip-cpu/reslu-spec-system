"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import {
  ProjectCloseoutCockpit,
  ProjectFinaliseDialog,
} from "@/components/projects/ProjectCloseoutCockpit";
import {
  JOB_LIFECYCLE_STEPS,
  PROJECT_STAGE_OPTIONS,
  lifecycleStepIndex,
  nextProjectStage,
  projectStageLabel,
} from "@/lib/project-lifecycle";
import type { Project, ProjectStage } from "@/types";
import type { ProjectCloseoutReadiness } from "@/types/project-closeout";

type LifecycleProject = Pick<Project, "id" | "project_stage" | "status" | "updated_at">;

export function ProjectLifecycle({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [project, setProject] = useState<LifecycleProject | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<ProjectCloseoutReadiness | null>(null);
  const [closeoutLoading, setCloseoutLoading] = useState(false);
  const [closeoutExpanded, setCloseoutExpanded] = useState(false);
  const [showFinalise, setShowFinalise] = useState(false);

  const loadReadiness = useCallback(async () => {
    setCloseoutLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/closeout`, {
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? "Could not load closeout readiness");
      }
      const nextReadiness = body as ProjectCloseoutReadiness;
      setReadiness(nextReadiness);
      return nextReadiness;
    } catch (loadError) {
      setReadiness(null);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load closeout readiness"
      );
      return null;
    } finally {
      setCloseoutLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    fetch(`/api/projects/${projectId}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load job stage");
        if (active) {
          const loadedProject = body.project as LifecycleProject;
          setProject(loadedProject);
          setCloseoutExpanded(loadedProject.project_stage === "handover");
          if (
            canEdit &&
            ["construction", "handover", "complete"].includes(
              loadedProject.project_stage
            )
          ) {
            void loadReadiness();
          }
        }
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load job stage");
      });
    return () => {
      active = false;
    };
  }, [canEdit, loadReadiness, projectId]);

  async function saveStage(stage: ProjectStage, closeoutAcknowledged = false) {
    if (!project || stage === project.project_stage) return false;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage,
          expected_updated_at: project.updated_at,
          closeout_acknowledged: closeoutAcknowledged,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not change job stage");
      setProject(body.project as LifecycleProject);
      if (stage === "handover") setCloseoutExpanded(true);
      if (["construction", "handover", "complete"].includes(stage)) {
        await loadReadiness();
      }
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not change job stage");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function setStage(stage: ProjectStage) {
    if (!project || stage === project.project_stage) return;
    const label = projectStageLabel(stage);

    if (stage === "complete") {
      if (project.project_stage !== "handover") {
        setError("Move the job to Handover and review closeout before finalising it.");
        return;
      }
      setError(null);
      setCloseoutExpanded(true);
      const currentReadiness = await loadReadiness();
      if (currentReadiness) setShowFinalise(true);
      return;
    }

    if (!window.confirm(`Move this job to ${label}? Finance will use the same stage.`)) return;
    await saveStage(stage);
  }

  if (!project && !error) {
    return <div className="h-16 animate-pulse border-b border-[#dcd6cc] bg-offwhite" aria-label="Loading job lifecycle" />;
  }
  if (!project) return null;

  const currentIndex = lifecycleStepIndex(project.project_stage);
  const nextStage = nextProjectStage(project.project_stage);

  return (
    <section className="border-b border-[#dcd6cc] bg-offwhite px-4 py-4 md:px-8" aria-label="Job lifecycle">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex items-center gap-3">
            <p className="label-caps">Job lifecycle</p>
            <span className={clsx(
              "border px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em]",
              project.project_stage === "on_hold"
                ? "border-amber-700/35 bg-amber-50 text-amber-800"
                : project.project_stage === "complete"
                  ? "border-[#4c6b4f]/40 bg-[#4c6b4f]/5 text-[#304b33]"
                  : "border-sand/50 bg-sand/10 text-[#76570a]"
            )}>
              {projectStageLabel(project.project_stage)}
            </span>
          </div>
          <div className="overflow-x-auto pb-1">
            <ol className="flex min-w-[820px] max-w-5xl" aria-label="Lead to finalised progression">
              {JOB_LIFECYCLE_STEPS.map((step, index) => {
                const reached = currentIndex !== null && index <= currentIndex;
                const current = currentIndex === index;
                return (
                  <li key={step.key} className="flex min-w-0 flex-1 items-center last:flex-none">
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={clsx(
                        "flex h-6 w-6 items-center justify-center rounded-full border text-[9px] font-semibold",
                        reached ? "border-nearblack bg-nearblack text-white" : "border-charcoal/25 text-charcoal/40",
                        current && "ring-2 ring-sand/40 ring-offset-2 ring-offset-offwhite"
                      )}>
                        {reached && !current ? "✓" : index + 1}
                      </span>
                      <span className={clsx("text-caption", reached ? "text-nearblack" : "text-charcoal/40")}>
                        {step.label}
                      </span>
                    </div>
                    {index < JOB_LIFECYCLE_STEPS.length - 1 && (
                      <span className={clsx("mx-2 h-px min-w-3 flex-1", currentIndex !== null && index < currentIndex ? "bg-nearblack" : "bg-charcoal/20")} />
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        {canEdit && (
          <div className="flex shrink-0 flex-wrap items-end gap-2">
            <label>
              <span className="label-caps block">Set stage</span>
              <select
                value={project.project_stage}
                disabled={saving}
                onChange={(event) => void setStage(event.target.value as ProjectStage)}
                className="mt-2 border border-charcoal/20 bg-cream px-3 py-2 text-body disabled:opacity-50"
              >
                {PROJECT_STAGE_OPTIONS.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={
                      option.value === "complete" &&
                      project.project_stage !== "handover" &&
                      project.project_stage !== "complete"
                    }
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {nextStage && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void setStage(nextStage)}
                className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-50"
              >
                {saving ? "Saving…" : `Move to ${projectStageLabel(nextStage)}`}
              </button>
            )}
          </div>
        )}
      </div>
      {error && <p role="alert" className="mt-3 text-caption text-red-700">{error}</p>}
      {canEdit && ["construction", "handover", "complete"].includes(project.project_stage) && (
        <ProjectCloseoutCockpit
          readiness={readiness}
          loading={closeoutLoading}
          expanded={closeoutExpanded}
          onToggle={() => setCloseoutExpanded((current) => !current)}
        />
      )}
      {showFinalise && readiness && (
        <ProjectFinaliseDialog
          readiness={readiness}
          saving={saving}
          onClose={() => setShowFinalise(false)}
          onConfirm={(acknowledged) => {
            void saveStage("complete", acknowledged).then((saved) => {
              if (saved) setShowFinalise(false);
            });
          }}
        />
      )}
    </section>
  );
}
