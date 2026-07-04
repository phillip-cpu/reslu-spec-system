import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { LibraryBrowser } from "@/components/library/LibraryBrowser";
import type { Category } from "@/types";

/** Product Library (Week 4) — global reusable product catalogue. */
export default async function LibraryPage() {
  const supabase = await createClient();
  const { data: categories } = await supabase
    .from("categories")
    .select("*")
    .order("sort_order");

  return (
    <>
      <Header title="Library" subtitle="Global product catalogue." />
      <main className="flex-1 px-8 py-8">
        <LibraryBrowser categories={(categories ?? []) as Category[]} />
      </main>
    </>
  );
}
