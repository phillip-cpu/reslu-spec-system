import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { ImportWizard } from "@/components/items/ImportWizard";

/**
 * CSV import (Week 2). Accepts a Programa-ish export (Code, Type/Item,
 * Product Name, Brand, Colour, Material, Finish, Width/Height/Length/Depth,
 * Supplier, Supplier Email, Location, Qty, Category) and bulk-creates spec
 * items via /api/projects/[id]/import after the user confirms the column
 * mapping (auto-suggested by header-name similarity).
 */
export default async function ImportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,client_name")
    .eq("id", id)
    .single();

  if (!project) {
    notFound();
  }

  return (
    <>
      <Header title="Import Items" subtitle={`${project.name} · ${project.client_name}`} subtitleHref={`/projects/${id}`} />
      <main className="flex-1 px-8 py-8">
        <ImportWizard projectId={id} />
      </main>
    </>
  );
}
