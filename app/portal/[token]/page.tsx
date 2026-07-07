import type { Metadata } from "next";
import Image from "next/image";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { ASSET_BUCKET } from "@/lib/storage";
import { rateLimit } from "@/lib/rate-limit";
import { signedRenditionUrl, RENDITION_SIZES } from "@/lib/image-url";
import { PortalNav } from "@/components/portal/PortalNav";
import { WhatsNextBlock } from "@/components/portal/WhatsNextBlock";
import { UpcomingMeetingsCard } from "@/components/portal/UpcomingMeetingsCard";
import { SelectionsSection } from "@/components/portal/SelectionsSection";
import { DocumentsSection } from "@/components/portal/DocumentsSection";
import { ContractsSection, type ContractRow } from "@/components/portal/ContractsSection";
import { VariationsSection } from "@/components/portal/VariationsSection";
import { ProgressPhotosSection } from "@/components/portal/ProgressPhotosSection";
import { DiarySection } from "@/components/portal/DiarySection";
import { TimelineSection } from "@/components/portal/TimelineSection";
import { HandoverSection } from "@/components/portal/HandoverSection";
import { getWhatsNext } from "@/lib/portal-whats-next";
import { fetchItemRoomsMap } from "@/lib/portal-rooms";
import type { PortalItem, PortalPhase } from "@/types";
import type {
  PortalItemFile,
  PortalItemWithFiles,
  PortalDocument,
  PortalSignatureSummary,
  PortalVariation,
  PortalProgressPhoto,
  PortalUpdate,
  PortalHandoverPack,
  PortalHandoverFile,
  PortalClientEvent,
} from "@/app/portal/types";

/**
 * Client Approval Portal — Phase 11B restyle (BUILD-SPEC.md "Phase 11
 * — Client portal v2 + trade confirmations" points 2-5, "Phase 11
 * additions — confirmed by Phillip"). Single sectioned page, sticky
 * top nav:
 *
 *   What's next (derived, top of page, no nav entry — always visible
 *   when there's anything to show) -> Selections (FF&E approvals at
 *   scale) -> Timeline (owned by the Phase 11A agent's
 *   TimelineSection.tsx — NOT touched here beyond passing it the same
 *   phases prop it already accepted) -> Diary (magazine-style journal,
 *   renamed from "Updates") -> Documents (+ certificates, signed
 *   badges) -> Contracts & signatures -> Variations -> Progress photos
 *   (published site_photos + any published-update photos) -> Handover
 *   (only when project status = 'completed').
 *
 * Still carries NO item pricing anywhere — PORTAL_FIELDS is unchanged
 * from Week 3B/8B. The ONE deliberate exception (BUILD-SPEC.md) is
 * variations' client-facing cost, shown INC GST only, computed
 * server-side below (never cost_ex_gst, never any item price_trade/
 * price_rrp/markup_pct field). No internal-only photo reaches this
 * page: site_photos are queried with `.eq("published_to_portal", true)`
 * only — never the full internal gallery.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Phase 14A caching decision — BUILD-SPEC.md Phase 14 "Speed": "portal
 * page: add revalidate where the page is a server component IF it
 * doesn't break token-gated freshness of approvals ... approvals must
 * reflect immediately after a client action".
 *
 * Deliberately NOT adding `export const revalidate` (or any ISR/static
 * treatment) to this page. This component already calls headers() a
 * few lines below (for the rate limiter's client-IP key) — per Next.js
 * semantics, any use of a dynamic API (headers/cookies/searchParams)
 * opts a route into fully dynamic rendering automatically, so this
 * page is already rendered fresh on every request; there is no stale
 * cache to accidentally serve. Adding a `revalidate` value here would
 * only be meaningful if the page were otherwise eligible for static/
 * ISR caching, which it isn't — so doing so would add a false sense of
 * "cached for N seconds" without changing actual behaviour, and risks
 * a future refactor (e.g. someone removing the headers() call) quietly
 * turning it into a real staleness bug. What WAS cached this round,
 * safely, is narrower: item-image renditions (lib/image-url.ts,
 * Supabase-edge-cached, keyed on the image bytes+size — never on
 * approval state) and the generated builder PDF (content-hash keyed on
 * item updated_at/count — see app/api/projects/[id]/pdf/route.ts).
 * Neither can ever serve stale approval/flag state: approvals live in
 * `items.client_approved`/`client_flagged` and `approval_events`,
 * queried fresh on every portal page load exactly as before.
 */

const PORTAL_FIELDS =
  "id,item_code,name,description,supplier,quantity,location,status,selected_image_url,client_approved,client_flagged,client_flag_note,decision_needed_by";

const SIGNED_URL_TTL_SECONDS = 60 * 60;
const GST_RATE = 0.1;

export default async function PortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`portal-page:${token}:${clientIp}`);
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

  // ---- Selections (FF&E approvals) — unchanged field whitelist plus
  // decision_needed_by (Phase 11B) ----
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

  // ---- Documents (project_files where share_to_portal, incl. certificates) ----
  const { data: fileRows } = await supabase
    .from("project_files")
    .select("id,kind,storage_path,filename,revision_label,uploaded_at")
    .eq("project_id", project.id)
    .eq("share_to_portal", true)
    .is("deleted_at", null)
    .order("uploaded_at", { ascending: false });

  // ---- Contracts & signatures (signature_requests for shared project_files) ----
  // Computed before the documents list below so each document can carry
  // its own signature summary inline (Phase 11B "signed badges").
  const sharedFileIds = new Set((fileRows ?? []).map((f) => f.id));
  const filenameById = new Map((fileRows ?? []).map((f) => [f.id, f.filename]));

  const { data: signatureRequests } = await supabase
    .from("signature_requests")
    .select("id,subject_type,subject_id,status")
    .eq("project_id", project.id)
    .in("status", ["pending", "signed", "void"]);

  const relevantRequests = (signatureRequests ?? []).filter(
    (r) => r.subject_type !== "project_file" || sharedFileIds.has(r.subject_id)
  );

  const signedRequestIds = relevantRequests.filter((r) => r.status === "signed").map((r) => r.id);
  const evidenceByRequest = new Map<string, { signer_name_typed: string; signed_at: string }>();
  if (signedRequestIds.length > 0) {
    const { data: events } = await supabase
      .from("signature_events")
      .select("signature_request_id,signer_name_typed,signed_at")
      .in("signature_request_id", signedRequestIds);
    for (const e of events ?? []) {
      if (e.signature_request_id) {
        evidenceByRequest.set(e.signature_request_id, {
          signer_name_typed: e.signer_name_typed,
          signed_at: e.signed_at,
        });
      }
    }
  }

  const signatureByFileId = new Map<string, PortalSignatureSummary>();
  for (const r of relevantRequests) {
    if (r.subject_type !== "project_file") continue;
    const evidence = evidenceByRequest.get(r.id);
    signatureByFileId.set(r.subject_id, {
      request_id: r.id,
      status: r.status,
      subject_type: r.subject_type,
      signed_by: evidence?.signer_name_typed ?? null,
      signed_at: evidence?.signed_at ?? null,
    });
  }

  const documents: PortalDocument[] = [];
  for (const row of fileRows ?? []) {
    const { data: signed, error: signError } = await supabase.storage
      .from(ASSET_BUCKET)
      .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
    if (signError || !signed?.signedUrl) continue;
    documents.push({
      id: row.id,
      kind: row.kind as PortalDocument["kind"],
      filename: row.filename,
      revision_label: row.revision_label,
      uploaded_at: row.uploaded_at,
      url: signed.signedUrl,
      signature: signatureByFileId.get(row.id) ?? null,
    });
  }

  const contracts: ContractRow[] = relevantRequests.map((r) => {
    const evidence = evidenceByRequest.get(r.id);
    return {
      request_id: r.id,
      subject_type: r.subject_type,
      filename:
        r.subject_type === "project_file"
          ? (filenameById.get(r.subject_id) ?? "Document")
          : r.subject_type === "variation"
            ? "Variation"
            : "Scope of Works",
      status: r.status,
      signed_by: evidence?.signer_name_typed ?? null,
      signed_at: evidence?.signed_at ?? null,
    };
  });

  // ---- Variations (share_to_portal, cost INC GST — the deliberate exception) ----
  const { data: variationRows } = await supabase
    .from("variations")
    .select("id,var_number,var_date,description,cost_ex_gst,client_response,client_response_note,client_responded_at")
    .eq("project_id", project.id)
    .eq("share_to_portal", true)
    .is("deleted_at", null)
    .order("var_number", { ascending: false });

  const variations: PortalVariation[] = (variationRows ?? []).map((v) => ({
    id: v.id,
    var_number: v.var_number,
    var_date: v.var_date,
    description: v.description,
    cost_inc_gst: Math.round(v.cost_ex_gst * (1 + GST_RATE) * 100) / 100,
    client_response: v.client_response,
    client_response_note: v.client_response_note,
    client_responded_at: v.client_responded_at,
  }));

  // ---- Progress photos ----
  // Phase 11B: "Existing Week 8 portal progress-photos section becomes
  // the published view of this gallery ... portal shows only
  // published_to_portal = true or photos attached to published
  // updates — one photo pipeline, staged internally, curated out."
  // Reads ONLY site_photos with published_to_portal = true — the
  // internal staging gallery (unpublished rows) never reaches this
  // query. progress_photos (the pre-Phase-11B table) is also still
  // read for backward compatibility with any historical rows uploaded
  // before the Gallery tab existed; new uploads only ever go to
  // site_photos (see app/api/projects/[id]/site-photos/route.ts).
  const [{ data: sitePhotoRows }, { data: legacyPhotoRows }] = await Promise.all([
    supabase
      .from("site_photos")
      .select("id,storage_path,caption,taken_at,created_at")
      .eq("project_id", project.id)
      .eq("published_to_portal", true)
      .is("deleted_at", null)
      .order("taken_at", { ascending: false }),
    supabase
      .from("progress_photos")
      .select("id,storage_path,caption,taken_at,created_at")
      .eq("project_id", project.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
  ]);

  // Phase 14A perf: ProgressPhotosSection.tsx renders a grid (thumb_url,
  // sized via lib/image-url.ts) PLUS a full-size lightbox on click
  // (url, unmodified signed URL) — so each photo needs both. Both
  // signing calls per photo, AND every photo, run in parallel
  // (Promise.all) rather than the sequential-per-photo loop this would
  // otherwise become with two awaits per iteration — signing calls are
  // independent Storage API requests with no shared state, so there's
  // no correctness reason to serialise them (unlike e.g. lib/images.ts's
  // deliberately-sequential external-image re-hosting, which is
  // sequential for its OWN stated reason: bounding total time spent on
  // potentially-slow third-party hosts, not applicable here since both
  // calls here hit Supabase's own Storage API). thumb_url errors (e.g.
  // transform add-on unavailable) fall back to the same full-size url
  // rather than dropping the photo.
  const photoResults = await Promise.all(
    [...(sitePhotoRows ?? []), ...(legacyPhotoRows ?? [])].map(async (row) => {
      const [{ data: signed, error: signError }, thumb] = await Promise.all([
        supabase.storage.from(ASSET_BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS),
        signedRenditionUrl(supabase, ASSET_BUCKET, row.storage_path, SIGNED_URL_TTL_SECONDS, {
          width: RENDITION_SIZES.grid,
        }),
      ]);
      if (signError || !signed?.signedUrl) return null;
      const photo: PortalProgressPhoto = {
        id: row.id,
        url: signed.signedUrl,
        thumb_url: thumb ?? signed.signedUrl,
        caption: row.caption,
        taken_at: row.taken_at,
        created_at: row.created_at,
      };
      return photo;
    })
  );
  const photos: PortalProgressPhoto[] = photoResults.filter((p): p is PortalProgressPhoto => p !== null);
  photos.sort((a, b) => (b.taken_at ?? b.created_at).localeCompare(a.taken_at ?? a.created_at));

  // ---- Timeline (Week 9 portal mirror, owned by the Phase 11A agent's
  // TimelineSection.tsx component — this page only queries the same
  // whitelisted columns it always has and passes them through
  // unchanged) ----
  const { data: phaseRows } = await supabase
    .from("schedule_phases")
    .select("id,name,start_date,end_date,color_key")
    .eq("project_id", project.id)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  const phases: PortalPhase[] = (phaseRows ?? []) as PortalPhase[];

  // ---- What's next (derived-only, Phase 11B) ----
  const whatsNext = await getWhatsNext(supabase, project.id);

  // ---- Upcoming client meetings (Phase 12a-B) ----
  // BUILD-SPEC.md §"Portal — upcoming client meetings": "future events
  // only, drop past". Sorted soonest-first, same as the team-side list.
  const { data: clientEventRows } = await supabase
    .from("client_events")
    .select("id,title,starts_at,ends_at,location,notes")
    .eq("project_id", project.id)
    .is("deleted_at", null)
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true });

  const upcomingMeetings: PortalClientEvent[] = clientEventRows ?? [];

  // ---- Diary (published only, newest first, with 1-2 photos each) ----
  const { data: updateRows } = await supabase
    .from("portal_updates")
    .select("id,title,body_richtext,published_at")
    .eq("project_id", project.id)
    .not("published_at", "is", null)
    .is("deleted_at", null)
    .order("published_at", { ascending: false });

  const updateIds = (updateRows ?? []).map((u) => u.id);
  const diaryPhotosByUpdate = new Map<string, { id: string; url: string; caption: string | null }[]>();
  if (updateIds.length > 0) {
    const { data: links } = await supabase
      .from("portal_update_photos")
      .select("update_id,sort,site_photos(id,storage_path,caption)")
      .in("update_id", updateIds)
      .order("sort", { ascending: true });

    for (const link of links ?? []) {
      const photo = Array.isArray(link.site_photos) ? link.site_photos[0] : link.site_photos;
      if (!photo) continue;
      // Phase 14A perf: DiarySection.tsx renders these at a fixed
      // aspect-[4/3] tile (max ~500px, no lightbox) — mint directly at
      // card size via lib/image-url.ts rather than a full-size image
      // that's immediately downscaled by the browser.
      const rendition = await signedRenditionUrl(
        supabase,
        ASSET_BUCKET,
        photo.storage_path,
        SIGNED_URL_TTL_SECONDS,
        { width: RENDITION_SIZES.card }
      );
      const url =
        rendition ??
        (
          await supabase.storage
            .from(ASSET_BUCKET)
            .createSignedUrl(photo.storage_path, SIGNED_URL_TTL_SECONDS)
        ).data?.signedUrl;
      if (!url) continue;
      const list = diaryPhotosByUpdate.get(link.update_id) ?? [];
      list.push({ id: photo.id, url, caption: photo.caption });
      diaryPhotosByUpdate.set(link.update_id, list);
    }
  }

  const updates: PortalUpdate[] = (updateRows ?? []).map((u) => ({
    id: u.id,
    title: u.title,
    body_richtext: u.body_richtext,
    published_at: u.published_at as string,
    photos: diaryPhotosByUpdate.get(u.id) ?? [],
  }));

  // ---- Handover pack (only when project status = 'completed') ----
  // BUILD-SPEC.md §"Phase 11 additions — confirmed by Phillip" point 4.
  let handoverPack: PortalHandoverPack | null = null;
  if (project.status === "completed") {
    handoverPack = await buildHandoverPack(supabase, project.id);
  }

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
            Your project home. Review selections, documents, and variations, and see the latest
            progress.
          </p>
        </div>
      </header>

      <WhatsNextBlock whatsNext={whatsNext} />
      <UpcomingMeetingsCard events={upcomingMeetings} />

      <PortalNav
        visible={{
          timeline: phases.length > 0,
          diary: true,
          documents: documents.length > 0,
          contracts: contracts.length > 0,
          variations: variations.length > 0,
          photos: photos.length > 0,
          handover: handoverPack !== null,
        }}
        // Quick items round (6 July 2026) — BUILD-SPEC.md §"Portal
        // selections separation" (stronger cut): "Selections" is now
        // ALWAYS a real link to /portal/[token]/selections (see
        // PortalNav.tsx's doc comment) — `selections` is no longer a
        // key in `visible` at all (there's no in-page #selections
        // anchor any more, only the compact summary card below).
        token={token}
      />

      <main className="mx-auto max-w-4xl space-y-10 px-6 py-8">
        <SelectionsSection token={token} initialItems={itemsWithFiles} />
        <TimelineSection phases={phases} />
        <DiarySection updates={updates} />
        <DocumentsSection documents={documents} />
        <ContractsSection token={token} contracts={contracts} />
        <VariationsSection token={token} initialVariations={variations} />
        <ProgressPhotosSection photos={photos} />
        {handoverPack && <HandoverSection pack={handoverPack} />}
      </main>

      <footer className="mx-auto max-w-4xl px-6 py-10 text-caption text-charcoal/40">
        RESLU · This is a private link. Please don&apos;t share it.
      </footer>
    </div>
  );
}

/**
 * Assembles the Handover section's payload — curated (in_handover_pack
 * = true) manuals & warranties (item_files), certificates + documents
 * (project_files, split by kind === 'certificate' vs everything else),
 * and the curated final gallery (site_photos where in_handover_pack).
 * Only called when project.status === 'completed'.
 */
async function buildHandoverPack(
  supabase: ReturnType<typeof createServiceRoleClient>,
  projectId: string
): Promise<PortalHandoverPack> {
  const [{ data: itemFileRows }, { data: projectFileRows }, { data: galleryRows }] = await Promise.all([
    // item_files has no project_id column — the items!inner(...) embed
    // filters to items actually belonging to this project (same
    // pattern already used by app/api/projects/[id]/overview/route.ts
    // and app/api/projects/[id]/handover/route.ts), so ownership is
    // enforced by the query itself rather than a defensive re-check
    // after the fact.
    supabase
      .from("item_files")
      .select("id,item_id,kind,storage_path,filename,items!inner(project_id,name)")
      .in("kind", ["install_manual", "warranty"])
      .eq("in_handover_pack", true)
      .eq("items.project_id", projectId),
    supabase
      .from("project_files")
      .select("id,kind,storage_path,filename")
      .eq("project_id", projectId)
      .eq("in_handover_pack", true)
      .is("deleted_at", null),
    supabase
      .from("site_photos")
      .select("id,storage_path,caption")
      .eq("project_id", projectId)
      .eq("in_handover_pack", true)
      .is("deleted_at", null),
  ]);

  const manualsAndWarranties: PortalHandoverFile[] = [];
  for (const row of itemFileRows ?? []) {
    const { data: signed, error } = await supabase.storage
      .from(ASSET_BUCKET)
      .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
    if (error || !signed?.signedUrl) continue;
    const item = Array.isArray(row.items) ? row.items[0] : row.items;
    manualsAndWarranties.push({
      id: row.id,
      kind: row.kind,
      filename: row.filename,
      url: signed.signedUrl,
      item_name: item?.name,
    });
  }

  const certificates: PortalHandoverFile[] = [];
  const documents: PortalHandoverFile[] = [];
  for (const row of projectFileRows ?? []) {
    const { data: signed, error } = await supabase.storage
      .from(ASSET_BUCKET)
      .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
    if (error || !signed?.signedUrl) continue;
    const file: PortalHandoverFile = { id: row.id, kind: row.kind, filename: row.filename, url: signed.signedUrl };
    if (row.kind === "certificate") certificates.push(file);
    else documents.push(file);
  }

  // Phase 14A perf: HandoverSection.tsx's "Final gallery" is a plain
  // aspect-square grid with no lightbox — mint directly at grid size
  // (see lib/image-url.ts), falling back to the full-size signed URL
  // if the transform call errors.
  const gallery: PortalHandoverPack["gallery"] = [];
  for (const row of galleryRows ?? []) {
    const rendition = await signedRenditionUrl(
      supabase,
      ASSET_BUCKET,
      row.storage_path,
      SIGNED_URL_TTL_SECONDS,
      { width: RENDITION_SIZES.grid }
    );
    if (rendition) {
      gallery.push({ id: row.id, url: rendition, caption: row.caption });
      continue;
    }
    const { data: signed, error } = await supabase.storage
      .from(ASSET_BUCKET)
      .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
    if (error || !signed?.signedUrl) continue;
    gallery.push({ id: row.id, url: signed.signedUrl, caption: row.caption });
  }

  return { manuals_and_warranties: manualsAndWarranties, certificates, documents, gallery };
}
