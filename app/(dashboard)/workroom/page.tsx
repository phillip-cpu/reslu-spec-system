import { Header } from "@/components/layout/Header";
import { WorkroomWorkspace } from "@/components/workroom/WorkroomWorkspace";

export default async function WorkroomPage({ searchParams }: { searchParams: Promise<{ conversation?: string }> }) {
  const params = await searchParams;
  return (
    <>
      <Header title="Workroom" subtitle="Every agent assignment, approval and recurring routine in one place." />
      <main className="min-h-0 flex-1 px-4 py-5 md:px-8 md:py-8">
        <WorkroomWorkspace conversationId={params.conversation ?? null} />
      </main>
    </>
  );
}
