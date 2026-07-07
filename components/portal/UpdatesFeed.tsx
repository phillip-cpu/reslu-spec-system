import type { PortalUpdate } from "@/app/portal/types";
import { PortalSection } from "@/components/portal/PortalSection";
import { SimpleMarkdown } from "@/lib/simple-markdown";

/**
 * Updates feed (BUILD-SPEC.md "Week 8 — Client portal expansion":
 * "Updates (published portal_updates as a feed, markdown rendered
 * simply ..., NO dangerouslySetInnerHTML of raw input)"). updates is
 * already published-only + newest-first (server query filters
 * published_at not null, orders desc).
 */
export function UpdatesFeed({ updates }: { updates: PortalUpdate[] }) {
  if (updates.length === 0) {
    return (
      <PortalSection id="updates" title="Updates">
        <p className="text-body text-charcoal/50">No updates have been posted yet.</p>
      </PortalSection>
    );
  }

  return (
    <PortalSection id="updates" title="Updates">
      <div className="space-y-8">
        {updates.map((u) => (
          <article key={u.id} className="border-b border-[#e5e0d6] pb-6 last:border-b-0">
            <p className="label-caps mb-1 !text-sand">
              {new Date(u.published_at).toLocaleDateString("en-AU", {
                timeZone: "Australia/Adelaide",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </p>
            <h3 className="text-subhead mb-2 text-nearblack">{u.title}</h3>
            <SimpleMarkdown text={u.body_richtext} />
          </article>
        ))}
      </div>
    </PortalSection>
  );
}
