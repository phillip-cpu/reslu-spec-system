import type { Metadata } from "next";
import Image from "next/image";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { ASSET_BUCKET } from "@/lib/storage";
import { rateLimit } from "@/lib/rate-limit";
import { PortalBoard } from "@/components/portal/PortalBoard";
import { PortalNav } from "@/components/portal/PortalNav";
import { PortalSection } from "@/components/portal/PortalSection";
import { DocumentsSection } from "@/components/portal/DocumentsSection";
import { ContractsSection, type ContractRow } from "@/components/portal/ContractsSection";
import { VariationsSection } from "@/components/portal/VariationsSection";
import { ProgressPhotosSection } from "@/components/portal/ProgressPhotosSection";
import { UpdatesFeed } from "@/components/portal/UpdatesFeed";
import { TimelineSection } from "@/components/portal/TimelineSection";
import type { PortalItem, PortalPhase } from "@/types";
import type {
  PortalItemFile,
  PortalItemWithFiles,
  PortalDocument,
  PortalVariation,
  PortalProgressPhoto,
  PortalUpdate,
} from "@/app/portal/types";

/**
 * Client Approval Portal — Week 8B expansion (BUILD-SPEC.md "Week 8 —
 * Client portal expansion"): the portal is now sectioned — Schedule &
 * approvals (existing PortalBoard, reused unmodified per the task's
 * "reuse, don't rewrite"), Documents, Contracts & signatures,
 * Variations, Progress photos, Updates. Every section is token-gated +
 * rate-limited + noindex, same as the Week 3B page this extends.
 *
 * Still carries NO item pricing anywhere — PORTAL_FIELDS is unchanged
 * from Week 3B. The ONE deliberate exception (BUILD-SPEC.md) is
 * variations' client-facing cost, shown INC GST only, computed
 * server-side below (never cost_ex_gst, never any item price_trade/
 * price_rrp/markup_pct field).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const PORTAL_FIELDS =
  "id,item_code,name,description,supplier,quantity,location,status,selected_image_url,client_approved,client_flagged,client_flag_note";

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
    .select("id,name,client_name")
    .eq("client_token", token)
    .single();

  if (!project) {
    notFound();
  }

  // ---- Schedule & approvals (existing, unchanged query) ----
  const { data: items } = await supabase
    .from("items")
    .select(PORTAL_FIELDS)
    .eq("project_id", project.id)
    .is("deleted_at", null)
    .order("location", { ascending: true, nullsFirst: false })
    .order("item_code", { ascending: true });

  const portalItems = (items ?? []) as PortalItem[];
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

  // ---- Documents (project_files where share_to_portal) ----
  const { data: fileRows } = await supabase
    .from("project_files")
    .select("id,kind,storage_path,filename,revision_label,uploaded_at")
    .eq("project_id", project.id)
    .eq("share_to_portal", true)
    .is("deleted_at", null)
    .order("uploaded_at", { ascending: false });

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
    });
  }

  // ---- Contracts & signatures (signature_requests for shared project_files) ----
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

  // ---- Progress photos (newest first) ----
  const { data: photoRows } = await supabase
    .from("progress_photos")
    .select("id,storage_path,caption,taken_at,created_at")
    .eq("project_id", project.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  const photos: PortalProgressPhoto[] = [];
  for (const row of photoRows ?? []) {
    const { data: signed, error: signError } = await supabase.storage
      .from(ASSET_BUCKET)
      .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
    if (signError || !signed?.signedUrl) continue;
    photos.push({
      id: row.id,
      url: signed.signedUrl,
      caption: row.caption,
      taken_at: row.taken_at,
      created_at: row.created_at,
    });
  }

  // ---- Timeline (Week 9 portal mirror) ----
  // BUILD-SPEC.md "Portal mirror": "phase names + bars + date ranges
  // ONLY (no contacts, no notes)" — the select() below is an explicit
  // whitelist that omits contact_id and notes entirely, same pattern
  // as PORTAL_FIELDS above for items: the excluded columns are never
  // fetched in the first place, not merely hidden by the component.
  const { data: phaseRows } = await supabase
    .from("schedule_phases")
    .select("id,name,start_date,end_date,color_key")
    .eq("project_id", project.id)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  const phases: PortalPhase[] = (phaseRows ?? []) as PortalPhase[];

  // ---- Updates feed (published only, newest first) ----
  const { data: updateRows } = await supabase
    .from("portal_updates")
    .select("id,title,body_richtext,published_at")
    .eq("project_id", project.id)
    .not("published_at", "is", null)
    .is("deleted_at", null)
    .order("published_at", { ascending: false });

  const updates: PortalUpdate[] = (updateRows ?? []).map((u) => ({
    id: u.id,
    title: u.title,
    body_richtext: u.body_richtext,
    published_at: u.published_at as string,
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
            Your project home. Review selections, documents, and variations, and see the latest
            progress.
          </p>
        </div>
      </header>

      <PortalNav
        visible={{
          schedule: true,
          timeline: phases.length > 0,
          documents: documents.length > 0,
          contracts: contracts.length > 0,
          variations: variations.length > 0,
          photos: photos.length > 0,
          updates: updates.length > 0,
        }}
      />

      <main className="mx-auto max-w-4xl space-y-10 px-6 py-8">
        <PortalSection id="schedule" title="Schedule &amp; approvals">
          <PortalBoard token={token} initialItems={itemsWithFiles} />
        </PortalSection>

        <TimelineSection phases={phases} />
        <DocumentsSection documents={documents} />
        <ContractsSection token={token} contracts={contracts} />
        <VariationsSection token={token} initialVariations={variations} />
        <ProgressPhotosSection photos={photos} />
        <UpdatesFeed updates={updates} />
      </main>

      <footer className="mx-auto max-w-4xl px-6 py-10 text-caption text-charcoal/40">
        RESLU · This is a private link. Please don&apos;t share it.
      </footer>
    </div>
  );
}
