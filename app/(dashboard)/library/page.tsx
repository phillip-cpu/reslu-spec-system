import { Header } from "@/components/layout/Header";
import { LibraryBrowser } from "@/components/library/LibraryBrowser";
import { getCategories } from "@/lib/reference-data";

/** Product Library (Week 4) — global reusable product catalogue. */
export default async function LibraryPage() {
  // Phase 14A caching: categories are stable reference data — see
  // lib/reference-data.ts.
  const categories = await getCategories();

  return (
    <>
      <Header title="Library" subtitle="Global product catalogue." />
      <main className="flex-1 px-8 py-8">
        <LibraryBrowser categories={categories} />
      </main>
    </>
  );
}
