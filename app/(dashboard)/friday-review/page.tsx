import { Header } from "@/components/layout/Header";
import { FridayReviewWorkspace } from "@/components/friday-review/FridayReviewWorkspace";

export default function FridayReviewPage() {
  return (
    <>
      <Header title="Friday Review" subtitle="Review every active project, capture next actions and prepare client updates in one meeting." />
      <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <FridayReviewWorkspace />
      </main>
    </>
  );
}
