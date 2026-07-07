import { Sidebar } from "@/components/layout/Sidebar";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { ScrollMemory } from "@/components/shared/ScrollMemory";
import { FocusOnLoad } from "@/components/shared/FocusOnLoad";
import { Suspense } from "react";

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
      {/* Bug fix, 7 July 2026: min-w-0 is required here — a flex item's
          default min-width is `auto` (its content's intrinsic width),
          not 0, so without this a wide-content page (e.g. the Timeline's
          multi-week Gantt grid) grows THIS whole flex item — and the
          page itself — to fit that content instead of respecting the
          sidebar+content split, silently defeating any overflow-x-auto
          scroll container further down the tree (it never gets a chance
          to activate, since nothing upstream is actually constraining
          its width). This is the "window stretches forever, can't see
          the right-hand buttons" symptom Phillip reported on Timeline. */}
      <div className="min-w-0 flex-1 flex flex-col"><Suspense fallback={null}><ScrollMemory /><FocusOnLoad /></Suspense>{children}</div>
    </div>
  );
}
