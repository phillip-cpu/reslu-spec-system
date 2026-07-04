import Image from "next/image";
import Link from "next/link";
import type { ProjectWithCounts } from "@/types";
import { StatusPill } from "./StatusPill";

/**
 * Project cover image thumbnail (Week 7) — ~3:2 aspect, object-cover,
 * cream placeholder block when no cover is set. `project.cover_image_url`
 * is a signed URL minted server-side (dashboard page / GET /api/projects
 * both batch this) since the `assets` bucket is private.
 */
export function ProjectCard({ project }: { project: ProjectWithCounts }) {
  return (
    <Link
      href={`/projects/${project.id}`}
      className="block border border-[#dcd6cc] bg-offwhite hover:border-nearblack transition-colors"
    >
      <div className="relative aspect-[3/2] w-full overflow-hidden bg-cream">
        {project.cover_image_url ? (
          <Image
            src={project.cover_image_url}
            alt=""
            fill
            sizes="(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw"
            className="object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-caption text-charcoal/25">
            No cover image
          </span>
        )}
      </div>

      <div className="p-6">
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
      </div>
    </Link>
  );
}
