import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { PortalBoard } from "@/components/portal/PortalBoard";
import type { PortalItem } from "@/types";

/**
 * Client Approval Portal (Week 3).
 * Unauthenticated, token-gated, read-mostly view of a project's schedule
 * for the client to approve / flag items. Carries NO pricing or ordering
 * data (BUILD-SPEC.md §2) — status is the only procurement signal.
 * Pages are noindex'd (BUILD-SPEC.md §Security).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const PORTAL_FIELDS =
  "id,item_code,name,description,supplier,quantity,location,status,selected_image_url,client_approved,client_flagged,client_flag_note";

export default async function PortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = createServiceRoleClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,client_name")
    .eq("client_token", token)
    .single();

  if (!project) {
    notFound();
  }

  const { data: items } = await supabase
    .from("items")
    .select(PORTAL_FIELDS)
    .eq("project_id", project.id)
    .is("deleted_at", null)
    .order("location", { ascending: true, nullsFirst: false })
    .order("item_code", { ascending: true });

  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-[#dcd6cc] bg-cream px-6 py-8">
        <div className="mx-auto max-w-4xl">
          <Image
            src="/reslu-logo.png"
            alt="RESLU"
            width={130}
            height={57}
            priority
            className="h-12 w-auto"
          />
          <h1 className="mt-6 font-display text-section text-nearblack">
            {project.name}
          </h1>
          <p className="mt-1 text-body text-charcoal/70">
            Selections for {project.client_name}. Please review each item and
            approve it, or flag it with a comment if you&apos;d like a change.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        <PortalBoard token={token} initialItems={(items ?? []) as PortalItem[]} />
      </main>

      <footer className="mx-auto max-w-4xl px-6 py-10 text-caption text-charcoal/40">
        RESLU · This is a private link. Please don&apos;t share it.
      </footer>
    </div>
  );
}
