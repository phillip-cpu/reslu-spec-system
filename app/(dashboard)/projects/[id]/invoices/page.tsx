import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { InvoiceQueue } from "@/components/invoices/InvoiceQueue";
import { ClientInvoiceQueue } from "@/components/invoices/ClientInvoiceQueue";
import { portalUrlFor } from "@/lib/portal-link";

/**
 * /projects/[id]/invoices — admin-only, financial. Two sections, two
 * directions of money, clearly labelled apart (Client invoicing round,
 * BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 5):
 *   - "Client invoices — money in": RESLU billing THIS client
 *     (ClientInvoiceQueue, new table `client_invoices`).
 *   - "Supplier invoices — money out": the pre-existing InvoiceQueue
 *     (BUILD-SPEC.md "Invoice pipeline — AI-updated actuals"), table
 *     `invoices`, unchanged by this round.
 * Same server-component gating shape as
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
    .select("id, name, client_name, client_email, address, client_token")
    .eq("id", id)
    .single();

  if (!project) {
    notFound();
  }

  // Client invoicing round (BUILD-SPEC.md "Phillip's ideas list — 6
  // July 2026" item 5) — server-computed boolean, never the raw env
  // itself, passed down to gate the per-invoice "Create payment link"
  // action (same convention as Settings' own Stripe status line).
  const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY);

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Invoices`} titleHref={`/projects/${id}`} />
      <ProjectTabs projectId={id} active="invoices" isAdmin={isAdmin} portalUrl={portalUrlFor(project.client_token)} />
      <main className="flex-1 space-y-10 px-8 py-8">
        {/* Client invoicing round — money IN (RESLU bills THIS client).
            Deliberately its own clearly-labelled section above the
            pre-existing supplier queue below (money OUT, trade/supplier
            bills) so the two directions of money are never confused on
            one page — see components/invoices/ClientInvoiceQueue.tsx's
            own header comment. */}
        <section>
          <h2 className="mb-1 text-subhead text-nearblack">Client invoices — money in</h2>
          <p className="mb-4 text-body text-charcoal/60">
            Tax invoices RESLU raises against this client (design fees to start — phase 1).
            Numbered off this project's job number, GST-compliant, emailed with the branded
            PDF attached. Bank transfer is the standard payment method (Settings → Client
            invoicing); an optional Stripe payment link can be added per invoice for small
            amounts.
          </p>
          <ClientInvoiceQueue
            projectId={id}
            projectClientName={project.client_name}
            projectClientEmail={project.client_email}
            projectAddress={project.address}
            stripeConfigured={stripeConfigured}
          />
        </section>

        <section>
          <h2 className="mb-1 text-subhead text-nearblack">Supplier invoices — money out</h2>
          <p className="mb-4 text-body text-charcoal/60">
            Trade/supplier bills against this project's estimate, matched to a cost line or
            spec item and approved before actuals update.
          </p>
          <InvoiceQueue projectId={id} />
        </section>
      </main>
    </>
  );
}
