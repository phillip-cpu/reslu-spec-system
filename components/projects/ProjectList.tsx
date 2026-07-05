import type { ProjectWithCountsAndAlias } from "@/types/phase-12a-b";
import { ProjectCard } from "./ProjectCard";

export function ProjectList({ projects }: { projects: ProjectWithCountsAndAlias[] }) {
  if (projects.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
        <p className="text-body text-charcoal/60">
          No projects yet. Create the first one to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </div>
  );
}
