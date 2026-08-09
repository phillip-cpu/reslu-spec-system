import { Header } from "@/components/layout/Header";
import { ConversationWorkspace } from "@/components/conversations/ConversationWorkspace";

export default function MessagesPage() {
  return (
    <>
      <div className="hidden md:block">
        <Header title="Messages" subtitle="RESLU staff and agents, in one place." />
      </div>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden md:p-6">
        <ConversationWorkspace />
      </main>
    </>
  );
}
