import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { ContactsBrowser } from "@/components/contacts/ContactsBrowser";

/**
 * Address Book (Week 9) — global reusable trade/supplier directory.
 * BUILD-SPEC.md "Address Book": "Global page /contacts ... searchable
 * list grouped/filterable by category". Mirrors the Library page's
 * server-component shell (app/(dashboard)/library/page.tsx) — fetches
 * distinct categories server-side for the filter dropdown/autocomplete
 * suggestions, then hands off to a client browser component.
 */
export default async function ContactsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("contacts")
    .select("category")
    .is("deleted_at", null)
    .not("category", "is", null);

  const categories = [...new Set((data ?? []).map((r) => r.category as string))].sort(
    (a, b) => a.localeCompare(b)
  );

  return (
    <>
      <Header title="Address Book" subtitle="Trades &amp; suppliers directory." />
      <main className="flex-1 px-8 py-8">
        <ContactsBrowser categories={categories} />
      </main>
    </>
  );
}
