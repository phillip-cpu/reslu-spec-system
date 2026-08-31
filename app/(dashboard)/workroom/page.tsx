import { Header } from "@/components/layout/Header";
import { WorkroomWorkspace } from "@/components/workroom/WorkroomWorkspace";

export default async function WorkroomPage({ searchParams }: { searchParams: Promise<{ conversation?: string; view?: string; task?: string; agent?: string; q?: string; filter?: string }> }) {
  const params = await searchParams;
  return (
    <>
      <div className="workroom-page-header"><Header title="Workroom" subtitle="Every agent assignment, approval and recurring routine in one place." /></div>
      <main className="min-h-0 flex-1 px-3 py-3 sm:px-4 sm:py-5 md:px-8 md:py-8">
        <WorkroomWorkspace
          conversationId={params.conversation ?? null}
          initialView={params.view ?? null}
          initialTaskId={params.task ?? null}
          initialAgentId={params.agent ?? null}
          initialQuery={params.q ?? null}
          initialFilter={params.filter ?? null}
        />
      </main>
    </>
  );
}
