import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { ASSET_BUCKET } from "@/lib/storage";
import { rateLimit } from "@/lib/rate-limit";
import { fetchItemRoomsMap } from "@/lib/portal-rooms";
import { SelectionsWorkspace } from "@/components/portal/SelectionsWorkspace";
import type { PortalItem } from "@/types";
import type { PortalItemFile, PortalItemWithFiles } from "@/app/portal/types";

/**
 * "Your selections" — BUILD-SPEC.md §"Portal selections separation"
 * (fix round B, extended by the Quick items round, 6 July 2026,
 * "stronger cut"): "Approved items move to a SEPARATE portal page:
 * /portal/[token]/selections ... Same token gate/rate limit/noindex as
 * the parent page."
 *
 * Quick items round: this page WAS approved-only (rendered just
 * YourSelectionsGallery, a read-only thumbnail grid) — the fix round
 * never finished moving the Awaiting/Flagged rendering off the main
 * page, it only added this page for the Approved gallery. This round
 * closes that gap: the page now queries the SAME full PORTAL_FIELDS
 * whitelist app/portal/[token]/page.tsx's Selections section uses
 * (item_code/name/description/supplier/quantity/location/status/
 * selected_image_url/client_approved/client_flagged/client_flag_note/
 * decision_needed_by — never any price_trade/price_rrp/markup_pct/
 * price_client column) plus each item's item_files (spec
 * sheets/manuals/warranties, signed URLs), and renders
 * SelectionsWorkspace — a tabbed Awaiting / Flagged / Approved
 * workspace with room grouping, bulk-approve, and the "Review one by
 * one" stepper, i.e. every interactive piece that used to live directly
 * on the main portal page.
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
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const PORTAL_FIELDS =
  "id,item_code,name,description,supplier,quantity,location,status,selected_image_url,client_approved,client_flagged,client_flag_note,decision_needed_by";

const SIGNED_URL_TTL_SECONDS = 60 * 60;

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
    .is("deleted_at", null)
    .order("location", { ascending: true, nullsFirst: false })
    .order("item_code", { ascending: true });

  const portalItems = (items ?? []) as (PortalItem & { decision_needed_by: string | null })[];
  const itemIds = portalItems.map((i) => i.id);
  const filesByItemId = new Map<string, PortalItemFile[]>();
  const roomsByItemId = await fetchItemRoomsMap(supabase, project.id, itemIds);

  if (itemIds.length > 0) {
    const { data: fileRows } = await supabase
      .from("item_files")
      .select("id,item_id,kind,storage_path,filename")
      .in("item_id", itemIds)
      .order("uploaded_at", { ascending: true });

    for (const row of fileRows ?? []) {
      const { data: signed, error: signError } = await supabase.storage
        .from(ASSET_BUCKET)
        .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
      if (signError || !signed?.signedUrl) continue;

      const list = filesByItemId.get(row.item_id) ?? [];
      list.push({
        id: row.id,
        kind: row.kind as PortalItemFile["kind"],
        filename: row.filename,
        url: signed.signedUrl,
      });
      filesByItemId.set(row.item_id, list);
    }
  }

  const itemsWithFiles: PortalItemWithFiles[] = portalItems.map((item) => ({
    ...item,
    files: filesByItemId.get(item.id) ?? [],
    rooms: roomsByItemId.get(item.id) ?? [],
  }));

  const approvedCount = itemsWithFiles.filter((i) => i.client_approved).length;

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
            {itemsWithFiles.length} item{itemsWithFiles.length === 1 ? "" : "s"} · {approvedCount} approved so far.
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
        <SelectionsWorkspace token={token} initialItems={itemsWithFiles} />
      </main>

      <footer className="mx-auto max-w-4xl px-6 py-10 text-caption text-charcoal/40">
        RESLU · This is a private link. Please don&apos;t share it.
      </footer>
    </div>
  );
}
