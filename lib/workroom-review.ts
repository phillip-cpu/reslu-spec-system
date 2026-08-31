import type { AgentTaskArtifact } from "@/types/conversations";
import type { WorkroomApprovalPolicy } from "@/types/workroom";

type JsonObject = Record<string, unknown>;

export interface WorkroomAuthorityRequest {
  tool_name: string;
  tool_args: JsonObject;
  target_type: string | null;
  target_id: string | null;
  approval_scope: string | null;
  expected_version: string | null;
  idempotency_key: string | null;
  domain_review_ref: string | null;
  expires_at: string | null;
}

export interface SocialReviewPost {
  id: string;
  title: string;
  caption: string;
  altText: string | null;
  schedule: string | null;
  assets: string[];
  crop: string | null;
  credit: string | null;
}

export type WorkroomReviewKind = "social" | "email" | "record" | "file" | "report";

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

export function authorityRequest(artifact: AgentTaskArtifact): WorkroomAuthorityRequest | null {
  const request = objectValue(artifact.content?.authority_request);
  const toolName = textValue(request?.tool_name);
  const toolArgs = objectValue(request?.tool_args);
  if (!request || !toolName || !toolArgs) return null;
  return {
    tool_name: toolName,
    tool_args: toolArgs,
    target_type: textValue(request.target_type),
    target_id: textValue(request.target_id),
    approval_scope: textValue(request.approval_scope),
    expected_version: textValue(request.expected_version),
    idempotency_key: textValue(request.idempotency_key),
    domain_review_ref: textValue(request.domain_review_ref),
    expires_at: textValue(request.expires_at),
  };
}

export function reviewKind(artifact: AgentTaskArtifact): WorkroomReviewKind {
  if (Array.isArray(artifact.content?.posts) || objectValue(artifact.content?.first_post_pack)) return "social";
  if (artifact.kind === "email_draft" || textValue(artifact.content?.subject)) return "email";
  if (artifact.kind === "record_change" || objectValue(artifact.content?.before) || objectValue(artifact.content?.after)) return "record";
  if (artifact.kind === "file" || textValue(artifact.content?.filename)) return "file";
  return "report";
}

function assetStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(assetStrings);
  const object = objectValue(value);
  if (!object) return [];
  return [object.url, object.path, object.asset, object.file, object.filename, object.folder_alias]
    .flatMap(assetStrings);
}

function shortAssetKey(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function reviewMediaUrls(artifact: AgentTaskArtifact) {
  const manifest = new Map<string, string>();
  if (Array.isArray(artifact.content?.asset_manifest)) {
    for (const row of artifact.content.asset_manifest) {
      const item = objectValue(row);
      const key = textValue(item?.file);
      const hash = textValue(item?.sha256)?.toLowerCase();
      if (key && hash && /^[a-f0-9]{64}$/.test(hash)) manifest.set(shortAssetKey(key), hash);
    }
  }
  const rows = Array.isArray(artifact.content?.workroom_review_media)
    ? artifact.content.workroom_review_media
    : [];
  const urls = new Map<string, string>();
  for (const row of rows) {
    const media = objectValue(row);
    const key = textValue(media?.asset_key);
    const url = textValue(media?.url);
    const sourceHash = textValue(media?.source_sha256)?.toLowerCase();
    if (key && url && sourceHash && manifest.get(shortAssetKey(key)) === sourceHash && isWebAsset(url)) {
      urls.set(key, url);
    }
  }
  return urls;
}

export function socialReviewPosts(artifact: AgentTaskArtifact): SocialReviewPost[] {
  let candidates: unknown[] = Array.isArray(artifact.content?.posts) ? artifact.content.posts : [];
  const firstPost = objectValue(artifact.content?.first_post_pack);
  if (!candidates.length && firstPost) candidates = [firstPost];
  const mediaUrls = reviewMediaUrls(artifact);
  return candidates.map((candidate, index) => {
    const post = objectValue(candidate) ?? {};
    const asset = objectValue(post.asset);
    const visual = objectValue(post.visual);
    const assets = [
      ...assetStrings(post.assets),
      ...assetStrings(post.visuals),
      ...assetStrings(post.asset),
      ...assetStrings(post.visual),
    ]
      .filter((value, position, all) => all.indexOf(value) === position)
      .map((value) => mediaUrls.get(value) ?? mediaUrls.get(shortAssetKey(value)) ?? value);
    return {
      id: textValue(post.post_id) ?? textValue(post.id) ?? `post-${index + 1}`,
      title: textValue(post.title) ?? textValue(post.theme) ?? `Post ${String(index + 1).padStart(2, "0")}`,
      caption: textValue(post.caption) ?? textValue(post.instagram_copy) ?? textValue(post.facebook_copy) ?? textValue(post.post) ?? "Caption not supplied.",
      altText: textValue(post.alt_text) ?? textValue(visual?.alt_text),
      schedule: textValue(post.publish_at) ?? textValue(post.schedule) ?? textValue(post.planned_date),
      assets,
      crop: textValue(post.crop) ?? textValue(asset?.crop),
      credit: textValue(post.credit),
    };
  });
}

export function isWebAsset(value: string) {
  return /^(https?:\/\/|data:image\/|\/api\/|\/storage\/)/i.test(value);
}

export function inaccessibleAssets(artifact: AgentTaskArtifact) {
  return socialReviewPosts(artifact)
    .flatMap((post) => post.assets)
    .filter((value) => !isWebAsset(value));
}

export function policyForArtifact(artifact: AgentTaskArtifact, policies: WorkroomApprovalPolicy[]) {
  const request = authorityRequest(artifact);
  return request ? policies.find((policy) => policy.tool_name === request.tool_name) ?? null : null;
}

const ACTION_LABELS: Record<string, string> = {
  send_aria_email: "Send email",
  create_stuart_xero_draft_bill: "Create Xero draft bill",
  create_stuart_xero_supplier_contact: "Create supplier contact",
  approve_proposal: "Apply proposed change",
  reject_proposal: "Reject proposed change",
  book_trade_visit: "Book trade visit",
  move_lead_stage: "Move lead",
  commit_company_overhead_finance_intake: "Create company expense draft",
  update_stuart_cockpit_forecast_date: "Move forecast date",
  add_brain_note: "Approve trusted memory",
};

export function approvalActionLabel(artifact: AgentTaskArtifact, policy: WorkroomApprovalPolicy | null) {
  const request = authorityRequest(artifact);
  if (!request) return reviewKind(artifact) === "social" ? "Approve content pack" : "Approve draft";
  if (!policy) return "Approval unavailable";
  return ACTION_LABELS[request.tool_name] ?? "Approve action";
}

export function approvalBoundary(artifact: AgentTaskArtifact, policy: WorkroomApprovalPolicy | null) {
  const request = authorityRequest(artifact);
  if (!request) return "This approves the reviewed content for the agent's next step. It does not itself send, publish, book or create an external record.";
  if (!policy) return `The requested action (${request.tool_name}) is not registered as an approvable RESLU action, so it cannot run from this review.`;
  if (policy.rollback_kind === "manual-recovery") return "This action cannot be automatically undone. RESLU will verify the provider result and will not retry an uncertain outcome blindly.";
  if (policy.rollback_kind === "compensating-action") return "This creates an external commitment or draft. Reversal requires a separate corrective action.";
  if (policy.rollback_kind === "restore-version") return "This changes an authoritative RESLU record. The prior version can be restored if needed.";
  if (policy.rollback_kind === "delete-draft") return "This creates a draft only. It can be removed before any later approval or payment.";
  return "This exact, versioned action will run once and its resulting state will be checked.";
}

export function authorityTimingIssue(artifact: AgentTaskArtifact, now = Date.now()) {
  const expiry = authorityRequest(artifact)?.expires_at;
  if (!expiry) return null;
  const expiresAt = new Date(expiry).getTime();
  if (Number.isNaN(expiresAt)) return "The approval window supplied by the agent is invalid.";
  if (expiresAt <= now) return "This exact action has expired and must be refreshed before approval.";
  if (expiresAt > now + 24 * 60 * 60 * 1000) return "This approval window is broader than RESLU's 24-hour safety limit.";
  return null;
}

export function artifactHasUsefulPreview(artifact: AgentTaskArtifact) {
  if (reviewKind(artifact) === "social") return socialReviewPosts(artifact).length > 0;
  const content = artifact.content ?? {};
  return Object.keys(content).some((key) => key !== "authority_request");
}
