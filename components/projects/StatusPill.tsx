import clsx from "clsx";
import type { ProjectStatus } from "@/types";

const LABELS: Record<ProjectStatus, string> = {
  active: "Active",
  completed: "Completed",
  archived: "Archived",
};

export function StatusPill({ status }: { status: ProjectStatus }) {
  return (
    <span
      className={clsx(
        "label-caps inline-block px-2 py-1 border",
        status === "active" && "border-nearblack text-nearblack",
        status === "completed" && "border-sand text-sand",
        status === "archived" && "border-charcoal/40 text-charcoal/40"
      )}
    >
      {LABELS[status]}
    </span>
  );
}
