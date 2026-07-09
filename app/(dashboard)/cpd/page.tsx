import { Header } from "@/components/layout/Header";
import { CpdWorkspace } from "@/components/cpd/CpdWorkspace";

/**
 * /cpd — CPD (Continuing Professional Development) point tracker.
 * BUILD-SPEC.md "CPD point tracker" section. Team-visible — every
 * signed-in user tracks their own CPD entries; the admin-only "All
 * team" grouped view is gated inside CpdWorkspace/GET /api/cpd itself
 * (same "page always renders, admin extras gated server-side" shape as
 * /my-work's lead_follow_up source), not at this page/sidebar level.
 *
 * Server shell only (mirrors /my-work, /contacts) — CpdWorkspace does
 * its own GET /api/cpd fetch client-side, since the page's real content
 * (this year's progress + entries) is per-user state that changes on
 * every add/edit/delete and gains no benefit from a server-side initial
 * read the way Settings' rarely-mutated app_settings editors do.
 */
export default function CpdPage() {
  return (
    <>
      <Header title="CPD" subtitle="Continuing Professional Development points, tracked per licence year." />
      <main className="flex-1 px-8 py-8">
        <CpdWorkspace />
      </main>
    </>
  );
}
