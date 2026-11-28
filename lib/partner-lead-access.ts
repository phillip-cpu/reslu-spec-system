import { createHash, timingSafeEqual } from "node:crypto";

export type PartnerLeadScope = { campaigns: string[]; since: string };
export const REPORT_STAGES = [
  "Enquiry", "New", "Contacted", "Qualified", "Site Visit",
  "Proposal Sent", "Won", "Lost", "On Hold", "Lead Lost", "Unable to Contact",
  "Potential Future Lead", "Potential Lead", "Complete",
  "Awaiting to Send Proposal", "Design Work In Progress",
] as const;
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
const campaignPattern = /^[A-Za-z0-9_-]{1,80}$/;

export function partnerLeadScope(
  key: unknown,
  env: Record<string, string | undefined>,
  now = Date.now(),
): PartnerLeadScope | null {
  const digest = env.PARTNER_REPORT_KEY_SHA256 ?? "";
  const expires = Date.parse(env.PARTNER_REPORT_EXPIRES_AT ?? "");
  const since = Date.parse(env.PARTNER_REPORT_SINCE ?? "");
  const campaigns = [...new Set((env.PARTNER_REPORT_CAMPAIGNS ?? "").split(",").map(s => s.trim()))];
  if (
    typeof key !== "string" || !keyPattern.test(key) ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !Number.isFinite(expires) || expires <= now ||
    !Number.isFinite(since) || since > now ||
    campaigns.length > 20 || campaigns.some(c => !campaignPattern.test(c))
  ) return null;
  const actual = createHash("sha256").update(key).digest();
  if (!timingSafeEqual(actual, Buffer.from(digest, "hex"))) return null;
  return { campaigns, since: new Date(since).toISOString() };
}

export function summarizePartnerLeads(
  rows: { utm_campaign?: unknown; stage?: unknown }[],
  allowed: string[],
): { campaign: string; stage: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.utm_campaign !== "string" ||
        !campaignPattern.test(row.utm_campaign) ||
        !allowed.includes(row.utm_campaign)) continue;
    const stage = REPORT_STAGES.find(s => s === row.stage) ?? "Other";
    const label = JSON.stringify([row.utm_campaign, stage]);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts, ([label, count]) => {
    const [campaign, stage] = JSON.parse(label) as [string, string];
    return { campaign, stage, count };
  }).sort((a, b) => a.campaign.localeCompare(b.campaign) || a.stage.localeCompare(b.stage));
}
