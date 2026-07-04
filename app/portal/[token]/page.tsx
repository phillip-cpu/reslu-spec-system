import type { Metadata } from "next";
import Image from "next/image";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { ASSET_BUCKET } from "@/lib/storage";
import { rateLimit } from "@/lib/rate-limit";
import { PortalBoard } from "@/components/portal/PortalBoard";
import type { PortalItem } from "@/types";
import type { PortalItemFile, PortalItemWithFiles } from "@/app/portal/types";

/**
 * Client Approval Portal (Week 3).
 * Unauthenticated, token-gated, read-mostly view of a project's schedule
 * for the client to approve / flag items. Carries NO pricing or ordering
 * data (BUILD-SPEC.md §2) — status is the only procurement signal.
 * Pages are noindex'd (BUILD-SPEC.md §Security).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Explicit column allowlist — this is the actual guarantee that no
// pricing/ordering field (price_rrp, price_trade, markup_pct, ordered_at,
// eta, delivered_at, lead_time_weeks, monday_*) ever reaches the portal.
// Verified against supabase/migrations/001_initial.sql column-for-column.
const PORTAL_FIELDS =
  "id,item_code,name,description,supplier,quantity,location,status,selected_image_url,client_approved,client_flagged,client_flag_note";

// Signed URLs expire in 1 hour — long enough for a client to browse and
// open a couple of documents in one sitting, short enough that a leaked/
// forwarded link doesn't hand out a permanent download.
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export default async function PortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Rate limit page loads too, not just the approve/flag POSTs — the
  // page itself does a handful of DB reads + storage signing calls per
  // token, unauthenticated (BUILD-SPEC.md §Security: "Rate-limit portal
  // routes"). Same per-token+IP fixed window as the action routes; see
  // lib/rate-limit.ts for the in-memory/serverless-instance caveat.
  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`portal-page:${token}:${clientIp}`);
  if (!limit.ok) {
    // Server Components can't set a custom status/Retry-After header the
    // way a Route Handler can, so a throttled page load surfaces as 404
    // rather than a proper 429 — an acceptable trade-off here since it
    // also avoids confirming to a prober whether a given token is valid.
    notFound();
  }

  const supabase = createServiceRoleClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,client_name")
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

  const portalItems = (items ?? []) as PortalItem[];

  // Item documents (BUILD-SPEC.md §5 / audit task #6): spec_sheet /
  // install_manual (and other) files listed as download links, via
  // signed Storage URLs — never the permanent public URL, even though
  // the bucket happens to be public today (defence in depth: a signed
  // URL doesn't depend on the bucket's current public/private setting
  // remaining what it is).
  const itemIds = portalItems.map((i) => i.id);
  const filesByItemId = new Map<string, PortalItemFile[]>();

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

      // A single failed signing (e.g. object missing) shouldn't break
      // the whole portal page — just omit that document.
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
  }));

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
          <h1 className="mt-6 font-display text-section text-nearblack">
            {project.name}
          </h1>
          <p className="mt-1 text-body text-charcoal/70">
            Selections for {project.client_name}. Please review each item and
            approve it, or flag it with a comment if you&apos;d like a change.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        <PortalBoard token={token} initialItems={itemsWithFiles} />
      </main>

      <footer className="mx-auto max-w-4xl px-6 py-10 text-caption text-charcoal/40">
        RESLU · This is a private link. Please don&apos;t share it.
      </footer>
    </div>
  );
}
