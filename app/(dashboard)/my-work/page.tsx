import { Header } from "@/components/layout/Header";
import { MyWorkWorkspace } from "@/components/my-work/MyWorkWorkspace";

/**
 * /my-work — per-user "what do I do today" page (BUILD-SPEC.md §"Phase
 * 12a — My Work"). Sidebar entry added right after Projects (see
 * components/layout/Sidebar.tsx). Team-visible (every signed-in user
 * has their own My Work) — the admin-only lead-follow-ups source is
 * gated inside GET /api/my-work itself (simply absent from the response
 * for non-admins), not at the page level, since every OTHER source on
 * this page (board tasks, diary drafts, trade proposals, overdue
 * decisions) is genuinely team-visible and the page itself has real
 * content for every role.
 */
export default function MyWorkPage() {
  return (
    <>
      <Header title="My Work" subtitle="What needs your attention today." />
      <main className="flex-1 px-8 py-8">
        <MyWorkWorkspace />
      </main>
    </>
  );
}
