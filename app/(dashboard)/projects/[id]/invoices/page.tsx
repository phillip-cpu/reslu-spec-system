import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { InvoiceQueue } from "@/components/invoices/InvoiceQueue";
import { portalUrlFor } from "@/lib/portal-link";

/**
 * /projects/[id]/invoices — the Invoice queue (admin-only, financial).
 * BUILD-SPEC.md "Invoice pipeline — AI-updated actuals" + "Financial
 * visibility — role-gated". Same server-component gating shape as
 * app/(dashboard)/projects/[id]/estimate/page.tsx: the role check runs
 * before any invoice data is fetched, so a non-admin who navigates here
 * directly gets a quiet "restricted" page with zero invoice rows sent
 * to the client. The API routes independently re-check admin too.
 */
export default async function ProjectInvoicesPage({
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
        <Header title="Invoices" />
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

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client_name, client_token")
    .eq("id", id)
    .single();

  if (!project) {
    notFound();
  }

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Invoices`} titleHref={`/projects/${id}`} />
      <ProjectTabs projectId={id} active="invoices" isAdmin={isAdmin} portalUrl={portalUrlFor(project.client_token)} />
      <main className="flex-1 px-8 py-8">
        <InvoiceQueue projectId={id} />
      </main>
    </>
  );
}
