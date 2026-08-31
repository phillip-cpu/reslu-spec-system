"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  PROJECT_SUBTYPE_LABELS,
  SINGLE_ROOM_PROJECT_SUBTYPES,
  type ProjectSubtype,
  type ProjectType,
} from "@/lib/project-templates";

interface Props {
  projectId: string;
  initialProjectType: ProjectType | null;
  initialProjectSubtype: ProjectSubtype;
  canEdit: boolean;
}

export function ProjectTypeCard({
  projectId,
  initialProjectType,
  initialProjectSubtype,
  canEdit,
}: Props) {
  const router = useRouter();
  const [projectType, setProjectType] = useState<ProjectType | "">(initialProjectType ?? "");
  const [projectSubtype, setProjectSubtype] = useState<ProjectSubtype>(initialProjectSubtype);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    if (!projectType) {
      setMessage("Select a project type.");
      return;
    }
    if (projectType === "single_room_renovation" && !projectSubtype) {
      setMessage("Select a room type.");
      return;
    }
    if (
      initialProjectType &&
      initialProjectType !== projectType &&
      !confirm(
        "Save the new project type? The existing Timeline and payment schedule will stay unchanged; only unseeded and future defaults use the new type."
      )
    ) {
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_type: projectType,
          project_subtype: projectType === "single_room_renovation" ? projectSubtype : null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save project type");
      setMessage("Project type saved.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save project type");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border border-[#dcd6cc] bg-offwhite p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-xl space-y-1">
          <h2 className="text-subhead text-nearblack">Project framework</h2>
          <p className="text-body text-charcoal/60">
            Project type is the starting signal for the Timeline, trade packages, payment stages,
            procurement dates and cash-flow forecast.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-56 flex-col gap-1">
            <span className="label-caps">Project type</span>
            <select
              value={projectType}
              disabled={!canEdit || saving}
              onChange={(event) => {
                const next = event.target.value as ProjectType | "";
                setProjectType(next);
                if (next !== "single_room_renovation") setProjectSubtype(null);
                setMessage(null);
              }}
              className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
            >
              <option value="">Select project type</option>
              {PROJECT_TYPES.map((type) => (
                <option key={type} value={type}>{PROJECT_TYPE_LABELS[type]}</option>
              ))}
            </select>
          </label>

          {projectType === "single_room_renovation" && (
            <label className="flex min-w-40 flex-col gap-1">
              <span className="label-caps">Room type</span>
              <select
                value={projectSubtype ?? ""}
                disabled={!canEdit || saving}
                onChange={(event) => setProjectSubtype((event.target.value || null) as ProjectSubtype)}
                className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
              >
                <option value="">Select room</option>
                {SINGLE_ROOM_PROJECT_SUBTYPES.map((subtype) => (
                  <option key={subtype} value={subtype}>{PROJECT_SUBTYPE_LABELS[subtype]}</option>
                ))}
              </select>
            </label>
          )}

          {canEdit && (
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
      {message && <p className="mt-3 text-caption text-charcoal/70">{message}</p>}
    </section>
  );
}
