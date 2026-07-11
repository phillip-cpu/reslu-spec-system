import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProposalEditor } from "@/components/proposals/ProposalEditor";

/**
 * /proposals/[id] — the fee-proposal Builder UI's editor (BUILD-SPEC.md
 * §"Fee proposal phase (r23)" item 3: "editor at
 * app/(dashboard)/proposals/[id] ... match how invoices/SOW edit UIs
 * are structured, pick the least-disturbing"). A dedicated full-page
 * route, not a slide-over panel — a proposal's content (letter, vision,
 * multiple scope sections with bullets+deliverables, staged fees with
 * milestone rows, timeline, exclusions, a full terms document) is far
 * more than a panel comfortably holds, the same reasoning
 * app/(dashboard)/projects/[id]/sow/page.tsx and
 * .../estimate/page.tsx already apply to their own content-heavy
 * editors.
 *
 * Server shell only (mirrors app/(dashboard)/trade-requests/[id]/page.tsx)
 * — ProposalEditor does its own GET /api/proposals/[id] fetch
 * client-side. Admin-gated at this layer too (same "quiet restricted
 * page, zero rows sent to a non-admin" shape as
 * app/(dashboard)/projects/[id]/invoices/page.tsx) — every proposals
 * API route independently re-checks admin as well.
 */
export default async function ProposalEditorPage({
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
        <Header title="Fee proposal" />
        <main className="flex-1 px-8 py-16">
          <div className="mx-auto max-w-md border border-[#dcd6cc] bg-offwhite p-8 text-center">
            <p className="label-caps mb-2">Restricted</p>
            <p className="text-body text-charcoal/70">
              This area is restricted. Ask an admin if you need access to fee proposals.
            </p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Header title="Fee proposal" subtitle="Letter, vision, scope, fees, timeline, exclusions, terms." />
      <main className="flex-1 px-8 py-8">
        <ProposalEditor proposalId={id} />
      </main>
    </>
  );
}
