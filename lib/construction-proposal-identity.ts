import { createHash } from "node:crypto";
// JSONB reorders object keys. Identity must survive round trips through storage.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const constructionDigest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function constructionDraftId(projectId: string, content: unknown) {
  const hash = constructionDigest({ project_id: projectId, content });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Acceptance evidence must name the exact displayed version. Construction
 * acceptance remains release-blocked; this check cannot authorize signing. */
export function matchesConstructionApproval(proposal: { id: string; content: unknown; construction_version_digest?: string | null }, input: { proposal_version_id?: string; proposal_version_digest?: string }) {
  return typeof proposal.construction_version_digest === "string" && /^[a-f0-9]{64}$/.test(proposal.construction_version_digest) && input.proposal_version_id === proposal.id && input.proposal_version_digest === proposal.construction_version_digest;
}
