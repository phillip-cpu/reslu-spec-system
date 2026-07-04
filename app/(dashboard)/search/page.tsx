import { Header } from "@/components/layout/Header";
import { SearchClient } from "@/components/search/SearchClient";

/** Global search across projects, items, and the library (Review §1.9). */
export default function SearchPage() {
  return (
    <>
      <Header title="Search" subtitle="Find projects, items, and library products." />
      <main className="flex-1 px-8 py-8">
        <SearchClient />
      </main>
    </>
  );
}
