"use client";

import { useState } from "react";
import type { Category } from "@/types";
import { ExportDialog } from "./ExportDialog";

interface Props {
  projectId: string;
  projectName: string;
  categoriesInProject: Category[];
}

/**
 * Small client wrapper around ExportDialog — the project page header
 * (app/(dashboard)/projects/[id]/page.tsx) is a server component, so
 * the "open/close" state for the dialog needs its own client boundary,
 * same pattern as any other button-opens-a-panel trigger in this app
 * (e.g. MondayBoardPicker). Replaces the old bare
 * `<a href=".../pdf">Download PDF</a>` link (BUILD-SPEC.md "Export +
 * board batch" item 1).
 */
export function ExportDialogTrigger({ projectId, projectName, categoriesInProject }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
      >
        Export…
      </button>
      {open && (
        <ExportDialog
          projectId={projectId}
          projectName={projectName}
          categoriesInProject={categoriesInProject}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
