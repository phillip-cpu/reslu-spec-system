/** Local-only bridge to the atomic SQL operations. The independent database
 * release gate also defaults OFF. Production cannot opt in via an env flag. */
export function localConstructionLifecycleEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (!["development", "test"].includes(env.NODE_ENV ?? "") || env.RESLU_CONSTRUCTION_LOCAL_TEST !== "1") return false;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname); } catch { return false; }
}
interface RpcClient { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }
export async function issueConstructionVersion(db: RpcClient, input: { projectId: string; proposalId: string; digest: string; requestId: string; actorId: string }) {
  const { data, error } = await db.rpc("issue_construction_proposal", { p_project: input.projectId, p_proposal: input.proposalId, p_digest: input.digest, p_request: input.requestId, p_actor: input.actorId });
  if (error) throw new Error(error.message);
  return data;
}
export async function respondConstructionVersion(db: RpcClient, input: { projectId: string; proposalId: string; token: string; digest: string; requestId: string; decision: "accepted" | "declined"; evidence: Record<string, unknown> }) {
  const { data, error } = await db.rpc("respond_construction_proposal", { p_project: input.projectId, p_proposal: input.proposalId, p_token: input.token, p_digest: input.digest, p_request: input.requestId, p_decision: input.decision, p_evidence: input.evidence });
  if (error) throw new Error(error.message);
  return data;
}
