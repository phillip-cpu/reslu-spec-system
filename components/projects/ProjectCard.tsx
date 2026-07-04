import Link from "next/link";
import type { ProjectWithCounts } from "@/types";
import { StatusPill } from "./StatusPill";

export function ProjectCard({ project }: { project: ProjectWithCounts }) {
  return (
    <Link
      href={`/projects/${project.id}`}
      className="block border border-[#dcd6cc] bg-offwhite p-6 hover:border-nearblack transition-colors"
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-subhead text-nearblack">{project.name}</h3>
          <p className="text-body text-charcoal/70 mt-1">{project.client_name}</p>
        </div>
        <StatusPill status={project.status} />
      </div>

      <div className="mt-6 flex items-center justify-between text-caption text-charcoal/60">
        <span>{project.item_count ?? 0} items</span>
        <span>Updated {new Date(project.updated_at).toLocaleDateString("en-AU")}</span>
      </div>
    </Link>
  );
}
