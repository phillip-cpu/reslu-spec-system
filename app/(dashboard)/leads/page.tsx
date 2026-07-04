import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { LeadsWorkspace } from "@/components/leads/LeadsWorkspace";

/**
 * /leads — Leads pipeline (Week 10, admin-only, financial-adjacent).
 * Same server-component gating shape as
 * app/(dashboard)/projects/[id]/invoices/page.tsx: the role check runs
 * before any lead data is fetched, so a non-admin who navigates here
 * directly gets a quiet "restricted" page with zero lead rows sent to
 * the client. Every /api/leads route independently re-checks admin
 * too — this page-level gate is a UX nicety, not the enforcement
 * boundary.
 */
export default async function LeadsPage() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  const isAdmin = info?.role === "admin";

  if (!isAdmin) {
    return (
      <>
        <Header title="Leads" />
        <main className="flex-1 px-8 py-16">
          <div className="mx-auto max-w-md border border-[#dcd6cc] bg-offwhite p-8 text-center">
            <p className="label-caps mb-2">Restricted</p>
            <p className="text-body text-charcoal/70">
              This area is restricted. Ask an admin if you need access to leads.
            </p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Header title="Leads" subtitle="Pipeline from first contact to construction." />
      <main className="flex-1 px-8 py-8">
        <LeadsWorkspace />
      </main>
    </>
  );
}
