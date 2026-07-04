import { Sidebar } from "@/components/layout/Sidebar";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";

/**
 * Dashboard shell (server component). Week 10 adds `isAdmin` here so
 * <Sidebar> can conditionally show the "Leads" nav entry — leads are
 * "admin-only, financial-adjacent" per BUILD-SPEC.md, the first
 * top-level (non project-scoped) admin-only page this app has had.
 * Previously no top-level nav item needed role-awareness (Invoices/
 * Estimate are gated at the per-project tab level instead — see
 * components/projects/ProjectTabs.tsx) so Sidebar had no such prop
 * until now. This is UI-only convenience: every /api/leads route and
 * the /leads page itself independently re-check admin server-side, so
 * hiding the link here is not the enforcement boundary.
 */
export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  const isAdmin = info?.role === "admin";

  return (
    <div className="flex min-h-screen bg-cream">
      <Sidebar isAdmin={isAdmin} />
      <div className="flex-1 flex flex-col">{children}</div>
    </div>
  );
}
