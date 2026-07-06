import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { YourSelectionsGallery, type YourSelectionGalleryItem } from "@/components/portal/YourSelectionsGallery";

/**
 * "Your selections" — BUILD-SPEC.md §"Portal selections separation"
 * (fix round B): "Approved items move to a SEPARATE portal page:
 * /portal/[token]/selections ... Same token gate/rate limit/noindex as
 * the parent page."
 *
 * Copies app/portal/[token]/page.tsx's guards EXACTLY (this is the only
 * thing this task is allowed to touch on that page beyond its
 * Selections section + nav — the other agent owns the rest of the
 * portal page, so this new route is additive and self-contained rather
 * than importing shared guard logic out of that file):
 *   - noindex metadata
 *   - a per-token+IP rate limit (separate bucket key so this page's
 *     traffic can never exhaust the parent page's rate limit budget or
 *     vice versa)
 *   - service-role client + token -> project lookup, 404 on no match
 *
 * Only ever selects item_code/name/location/selected_image_url (plus id
 * and the client_approved filter itself) — no price_trade/price_rrp/
 * markup_pct/price_client column is ever touched, matching the portal's
 * non-negotiable "zero pricing" rule. No item_files/document lookup
 * either — this gallery is thumbnails-grouped-by-room only, per the
 * spec's own description; documents remain the main portal page's
 * Selections section's job (expanded row).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const PORTAL_FIELDS = "id,item_code,name,location,selected_image_url";

export default async function YourSelectionsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`portal-selections-page:${token}:${clientIp}`);
  if (!limit.ok) {
    notFound();
  }

  const supabase = createServiceRoleClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,client_name,status")
    .eq("client_token", token)
    .single();

  if (!project) {
    notFound();
  }

  const { data: items } = await supabase
    .from("items")
    .select(PORTAL_FIELDS)
    .eq("project_id", project.id)
    .eq("client_approved", true)
    .is("deleted_at", null)
    .order("location", { ascending: true, nullsFirst: false })
    .order("item_code", { ascending: true });

  const approvedItems = (items ?? []) as YourSelectionGalleryItem[];

  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-[#dcd6cc] bg-cream px-6 py-8">
        <div className="mx-auto max-w-4xl">
          <Image
            src="/reslu-logo.png"
            alt="RESLU"
            width={130}
            height={57}
            priority
            className="h-12 w-auto"
          />
          <p className="label-caps mt-6 !text-sand">Your selections</p>
          <h1 className="mt-1 font-display text-section text-nearblack">{project.name}</h1>
          <p className="mt-1 text-body text-charcoal/70">
            {approvedItems.length} approved item{approvedItems.length === 1 ? "" : "s"}, grouped by room.
          </p>
          <Link
            href={`/portal/${token}`}
            className="mt-4 inline-block label-caps !text-sand hover:!text-nearblack"
          >
            ← Back to your project
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        <YourSelectionsGallery token={token} items={approvedItems} />
      </main>

      <footer className="mx-auto max-w-4xl px-6 py-10 text-caption text-charcoal/40">
        RESLU · This is a private link. Please don&apos;t share it.
      </footer>
    </div>
  );
}
