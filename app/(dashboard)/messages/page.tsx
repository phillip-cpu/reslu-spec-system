import { Header } from "@/components/layout/Header";
import { ConversationWorkspace } from "@/components/conversations/ConversationWorkspace";

export default function MessagesPage() {
  return (
    <>
      <Header title="Messages" subtitle="RESLU staff and agents, in one place." />
      <main className="min-h-0 flex-1 md:p-6">
        <ConversationWorkspace />
      </main>
    </>
  );
}
