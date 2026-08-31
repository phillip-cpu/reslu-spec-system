import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SupplierQuoteResponseForm } from "@/components/quote-request/SupplierQuoteResponseForm";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function SupplierQuoteRequestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = createServiceRoleClient();
  const { data: request } = await supabase.from("supplier_quote_requests").select("*").eq("token", token).maybeSingle();
  if (!request) notFound();

  const { data: quotePackage } = await supabase.from("supplier_quote_packages").select("*").eq("id", request.package_id).is("deleted_at", null).maybeSingle();
  if (!quotePackage) notFound();
  const [{ data: project }, { data: contact }, { data: lines }, { data: attachments }] = await Promise.all([
    supabase.from("projects").select("name,address").eq("id", quotePackage.project_id).maybeSingle(),
    request.contact_id ? supabase.from("contacts").select("company,contact_name").eq("id", request.contact_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("supplier_quote_package_lines").select("*").eq("package_id", quotePackage.id).order("sort"),
    supabase.from("supplier_quote_attachments").select("*").eq("package_id", quotePackage.id).eq("kind", "request").or(`request_id.is.null,request_id.eq.${request.id}`).order("sort"),
  ]);
  if (!project) notFound();

  const files = await Promise.all((attachments ?? []).map(async (attachment) => {
    const { data } = await supabase.storage.from(ASSET_BUCKET).createSignedUrl(attachment.storage_path, SIGNED_URL_TTL_SECONDS);
    return { ...attachment, url: data?.signedUrl ?? null };
  }));
  const closed = ["declined", "selected", "closed"].includes(request.status);

  return (
    <div className="min-h-screen bg-offwhite">
      <header className="border-b border-[#dcd6cc] bg-cream px-6 py-5"><p className="font-display text-section text-nearblack">RESLU</p></header>
      <main className="mx-auto max-w-3xl space-y-6 px-5 py-8">
        <section>
          <p className="label-caps">Quote request · {project.name}</p>
          <h1 className="mt-2 font-display text-section text-nearblack">{quotePackage.title}</h1>
          {project.address && <p className="mt-1 text-body text-charcoal/70">{project.address}</p>}
          {contact?.company && <p className="mt-1 text-body text-charcoal/70">For {contact.company}{contact.contact_name ? ` · ${contact.contact_name}` : ""}</p>}
          {quotePackage.requested_quote_date && <p className="mt-3 border-l-2 border-sand pl-3 text-body text-nearblack">Requested by {quotePackage.requested_quote_date}</p>}
          {quotePackage.scope && <p className="mt-4 whitespace-pre-wrap text-body text-charcoal/75">{quotePackage.scope}</p>}
        </section>

        <section className="border border-[#dcd6cc] bg-white">
          <h2 className="border-b border-[#dcd6cc] bg-cream px-4 py-3 label-caps">Items to quote</h2>
          {(lines ?? []).map((line) => <div key={line.id} className="flex justify-between gap-4 border-b border-[#e5e0d6] px-4 py-3 text-body last:border-0"><span>{line.description_snapshot}</span><span className="shrink-0 text-charcoal/60">{line.qty_snapshot ?? "—"} {line.unit_snapshot ?? ""}</span></div>)}
        </section>

        {files.length > 0 && <section><h2 className="label-caps mb-2">Reference files and images</h2><div className="grid gap-3 sm:grid-cols-2">{files.map((file) => <a key={file.id} href={file.url ?? "#"} target="_blank" rel="noreferrer" className="border border-[#dcd6cc] bg-white p-3 text-body text-nearblack hover:border-nearblack"><span className="block font-medium">{file.filename}</span>{file.caption && <span className="mt-1 block text-caption text-charcoal/60">{file.caption}</span>}</a>)}</div></section>}

        {closed ? <p className="border border-sand bg-cream px-5 py-4 text-body">This request is closed. Please contact RESLU if anything needs to change.</p> : <SupplierQuoteResponseForm token={token} lines={lines ?? []} />}
      </main>
    </div>
  );
}
