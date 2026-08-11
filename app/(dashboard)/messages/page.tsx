import { ConversationWorkspace } from "@/components/conversations/ConversationWorkspace";

export default function MessagesPage() {
  return (
    <>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden md:hidden">
        <ConversationWorkspace />
      </main>
      <div className="hidden min-h-0 flex-1 items-center justify-center text-body text-charcoal/45 md:flex" aria-hidden="true">
        Opening messages…
      </div>
    </>
  );
}
