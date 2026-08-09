import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function BrainNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: note } = await supabase
    .from("brain_notes")
    .select("id,title,body,tags,source,source_ref,confidence,created_at,updated_at")
    .eq("id", id)
    .maybeSingle();
  if (!note) notFound();

  return (
    <main className="min-h-screen bg-nearblack px-6 py-10 text-white sm:px-10 lg:px-16">
      <div className="mx-auto max-w-4xl">
        <Link href="/brain" className="label-caps text-sand hover:text-white">
          ← Second Brain
        </Link>
        <p className="label-caps mt-12 text-sand">{note.source === "marco" ? "Marco / Marketing" : "Durable memory"}</p>
        <h1 className="mt-4 max-w-3xl font-display text-5xl font-light leading-tight text-white">{note.title}</h1>
        <div className="mt-6 flex flex-wrap gap-2">
          {(note.tags ?? []).map((tag: string) => (
            <span key={tag} className="border border-white/15 px-2.5 py-1 text-caption text-white/60">
              {tag}
            </span>
          ))}
        </div>
        <article className="mt-10 whitespace-pre-wrap border-t border-white/10 pt-8 text-[15px] font-light leading-8 text-white/80">
          {note.body}
        </article>
        <dl className="mt-12 grid gap-4 border-t border-white/10 pt-6 text-caption text-white/45 sm:grid-cols-2">
          <div><dt className="label-caps text-white/30">Source</dt><dd className="mt-1">{note.source_ref ?? note.source}</dd></div>
          <div><dt className="label-caps text-white/30">Updated</dt><dd className="mt-1">{new Date(note.updated_at ?? note.created_at).toLocaleString("en-AU", { timeZone: "Australia/Adelaide" })}</dd></div>
        </dl>
      </div>
    </main>
  );
}
