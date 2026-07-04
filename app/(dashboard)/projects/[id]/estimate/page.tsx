import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { EstimateWorkspace } from "@/components/estimate/EstimateWorkspace";

/**
 * /projects/[id]/estimate — the Estimate module ("the Excel killer").
 * BUILD-SPEC.md "Project estimating module" / "Estimating module —
 * enriched from Phillip's Excel template" / §Financial visibility.
 *
 * Admin-only, server-enforced: this is a server component, so the role
 * check runs before any estimate data is fetched or sent to the
 * client. A non-admin who navigates here directly gets a quiet
 * "restricted" page with no estimate query executed at all — per the
 * build brief ("If a non-admin somehow navigates here: server
 * component checks role and renders a quiet 'This area is restricted'
 * page (no data fetch)."). This mirrors the same admin-only guard the
 * estimate API routes enforce independently — belt and braces, since
 * the API is the real security boundary either way.
 */
export default async function EstimatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  const isAdmin = info?.role === "admin";

  if (!isAdmin) {
    return (
      <>
        <Header title="Estimate" />
        <main className="flex-1 px-8 py-16">
          <div className="mx-auto max-w-md border border-[#dcd6cc] bg-offwhite p-8 text-center">
            <p className="label-caps mb-2">Restricted</p>
            <p className="text-body text-charcoal/70">
              This area is restricted. Ask an admin if you need access to
              project financials.
            </p>
          </div>
        </main>
      </>
    );
  }

  // Admin confirmed — safe to fetch project identity for the header.
  // (No estimate/financial rows are fetched here; EstimateWorkspace
  // fetches those client-side from the admin-gated API routes, which
  // re-check the role independently.)
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client_name")
    .eq("id", id)
    .single();

  if (!project) {
    notFound();
  }

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Estimate`} />
      <main className="flex-1 px-8 py-8">
        <EstimateWorkspace projectId={id} />
      </main>
    </>
  );
}
