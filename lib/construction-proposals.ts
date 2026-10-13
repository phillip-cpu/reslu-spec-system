import { lineClientPrice, roundMoney } from "./estimate.ts";
import type { EstimateVersion } from "../types/phase-12a-a";
import type { Proposal, ProposalContent } from "../types/proposals";
import type { SowDocument, SowSectionWithLines } from "../types";
import type { ConstructionContent, ConstructionPayment, ConstructionPrice, ConstructionSelection } from "../types/construction-proposals";

export const CONSTRUCTION_RELEASE_HOLD = "Construction proposals are for internal review only. Sending and acceptance require final review and verified contract terms.";
export function isConstruction(content: unknown): content is ConstructionContent {
  return !!content && typeof content === "object" && (content as { kind?: unknown }).kind === "construction";
}
const money = (n: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
const cents = (n: number) => Math.round(n * 100);
function price(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || !Number.isSafeInteger(cents(n))) throw new Error("A selling price is missing or invalid. Verify the estimate first.");
  return roundMoney(n);
}
export function constructionPrices(version: EstimateVersion): ConstructionPrice[] {
  const s = version.snapshot;
  if (s.rollup.approvedVariationsExGst !== 0) throw new Error("This estimate includes post-contract variations. Use the separate variation workflow.");
  const measurements = new Map(s.measurements.map(m => [m.id, m]));
  const rows = s.sections.map(section => ({
    key: `section:${section.id}`, label: section.name,
    selling_ex_gst: roundMoney(section.lines.filter(l => !l.deleted_at).reduce((sum, line) =>
      sum + price(lineClientPrice(line, s.markup_pct, line.measurement_id ? measurements.get(line.measurement_id) : null)), 0)),
  }));
  if (s.ffe.unpriced_count > 0) throw new Error("The estimate contains unpriced FF&E. Verify pricing first.");
  for (const category of s.ffe.categories) rows.push({ key: `ffe:${category.category}`, label: `FF&E — ${category.category}`, selling_ex_gst: price(category.client_total) });
  const sum = rows.reduce((n, row) => n + cents(row.selling_ex_gst), 0);
  if (sum !== cents(price(s.wholeJob.combinedExGst))) throw new Error("Selling prices do not reconcile to the saved estimate. Save a verified estimate version first.");
  const expectedInc = roundMoney(sum / 100 + roundMoney(sum / 100 * .1));
  if (cents(expectedInc) !== cents(price(s.wholeJob.combinedIncGst))) throw new Error("Saved estimate GST does not reconcile. Verify the estimate version first.");
  return rows;
}
export function validatePayments(payments: ConstructionPayment[]): string | null {
  if (!Array.isArray(payments) || !payments.length || payments.some(p => !p || typeof p.label !== "string" || !p.label.trim() || typeof p.percentage !== "number" || !Number.isFinite(p.percentage) || p.percentage < 0 || p.percentage > 100 || Math.abs(p.percentage * 100 - Math.round(p.percentage * 100)) > 1e-7)) return "Enter named payment stages with percentages from 0 to 100 (up to two decimal places).";
  const total = payments.reduce((n, p) => n + Math.round(p.percentage * 100), 0);
  return total === 10000 ? null : `Payment stages total ${total / 100}%; ${Math.abs(10000 - total) / 100}% ${total < 10000 ? "unallocated" : "overallocated"}. They must total 100%.`;
}
export function allocatePayments(payments: ConstructionPayment[], total: number) {
  const error = validatePayments(payments);
  if (error) throw new Error(error);
  const totalCents = cents(total);
  let cumulative = 0, allocated = 0;
  return payments.map(p => {
    cumulative += Math.round(p.percentage * 100);
    const next = Math.round(totalCents * cumulative / 10000);
    const amount_inc = (next - allocated) / 100;
    allocated = next;
    return { label: p.label.trim(), percentage: p.percentage, amount_inc };
  });
}
export function constructionChanges(previous: ProposalContent | undefined, next: ProposalContent): string[] {
  if (!previous) return ["Initial construction proposal."];
  const changes: string[] = [];
  for (const [key, label] of [["scope_sections", "Scope"], ["fees", "Selling prices / payment stages"], ["exclusions", "Exclusions / options"], ["timeline", "Time effects"], ["terms_md", "Terms"]] as const) {
    if (JSON.stringify(key === "scope_sections" ? previous.scope_sections.filter(s => s.title !== "Version change summary") : previous[key]) !== JSON.stringify(next[key])) changes.push(`${label} changed; review this version in full.`);
  }
  if (isConstruction(previous) && isConstruction(next)) {
    const delta = roundMoney(next.construction.total_inc - previous.construction.total_inc);
    changes.push(`Total change: ${money(delta)} inc GST.`);
    if (previous.construction.source_digest !== next.construction.source_digest) changes.push("Source estimate or scope revision changed.");
  }
  return changes.length ? changes : ["No client-facing content changes."];
}
export function buildConstructionContent(input: {
  version: EstimateVersion; sow: SowDocument; sections: SowSectionWithLines[];
  selection: ConstructionSelection; sourceDigest: string; previous?: Proposal;
}): ConstructionContent {
  const { version, sow, sections, selection, sourceDigest, previous } = input;
  if (version.project_id !== sow.project_id || (previous && previous.project_id !== version.project_id)) throw new Error("All sources must belong to the same project.");
  if (previous && (!isConstruction(previous.content) || previous.status === "accepted" || previous.status === "closed")) throw new Error("An accepted or closed proposal cannot be revised. Create a separate post-contract variation.");
  if (sow.status !== "issued" || sow.deleted_at || !version.snapshot.sow_revision_label || sow.revision_label !== version.snapshot.sow_revision_label) throw new Error("Choose the issued scope revision recorded by this estimate version.");
  if (!sections.length || !sections.some(s => s.lines.some(l => l.kind === "inclusion"))) throw new Error("The authoritative scope must contain inclusions.");
  for (const section of sections) {
    if (!["internal", "external", "preliminaries", "option"].includes(selection.scope_groups?.[section.id])) throw new Error(`Classify scope: ${section.heading}.`);
  }
  if (Object.keys(selection.scope_groups ?? {}).length !== sections.length) throw new Error("Scope selection changed. Reload and classify every section.");
  const prices = constructionPrices(version).map(row => {
    const group = selection.groups?.[row.key];
    if (!["internal", "external", "preliminaries", "option"].includes(group)) throw new Error(`Classify ${row.label} as internal, external, shared preliminaries or option.`);
    return { ...row, group };
  });
  if (Object.keys(selection.groups ?? {}).length !== prices.length) throw new Error("The estimate selection changed. Reload and classify every row.");
  const subtotal = roundMoney(prices.filter(p => p.group !== "option").reduce((n, p) => n + p.selling_ex_gst, 0));
  const gst = roundMoney(subtotal * 0.1), total = roundMoney(subtotal + gst);
  if (total <= 0) throw new Error("The base construction proposal must have a positive selling total.");
  const payments = allocatePayments(selection.payments, total);
  const labels = { internal: "Internal works", external: "External works", preliminaries: "Shared preliminaries" };
  const groupTotals = Object.entries(labels).map(([group, label]) => ({ label, ex: roundMoney(prices.filter(p => p.group === group).reduce((n, p) => n + p.selling_ex_gst, 0)) }));
  const optionLines = prices.filter(p => p.group === "option").map(p => `${p.label}: ${money(p.selling_ex_gst)} ex GST + ${money(roundMoney(p.selling_ex_gst * .1))} GST = ${money(roundMoney(p.selling_ex_gst * 1.1))} inc GST. Not included in the base price or payment stages.`);
  const content: ConstructionContent = {
    kind: "construction",
    letter: `Thank you for the opportunity to prepare your construction proposal. Please read this proposal in conjunction with Scope of Works ${sow.revision_label}.`,
    vision: `Generated from estimate ${version.label} and issued scope ${sow.revision_label}. Optional scope is identified separately below and is not included in the base price.`,
    scope_sections: sections.filter(s => selection.scope_groups[s.id] !== "option").map(s => ({ title: `${selection.scope_groups[s.id] === "preliminaries" ? "Shared preliminaries" : selection.scope_groups[s.id] === "external" ? "External works" : "Internal works"} — ${s.heading}`, bullets: s.lines.filter(l => l.kind === "inclusion").map(l => l.text), deliverables: s.lines.filter(l => l.kind === "note").map(l => l.text) })),
    fees: { mode: "single", stages: [{ label: "Construction selling price", total_inc: total, milestones: [] }], price_lines: [
      ...groupTotals.map(g => `${g.label}: ${money(g.ex)} ex GST`),
      `Base subtotal: ${money(subtotal)} ex GST; GST (10%): ${money(gst)}; total: ${money(total)} inc GST.`,
    ], payment_lines: [
      ...payments.map(p => `${p.label}: ${p.percentage}% — ${money(p.amount_inc)} inc GST`),
    ] },
    timeline: [{ phase: "Construction programme", duration: "To be agreed with the construction programme" }],
    exclusions: { bullets: [...sections.flatMap(s => s.lines.filter(l => l.kind === "exclusion").map(l => l.text)), ...optionLines, ...sections.filter(s => selection.scope_groups[s.id] === "option").flatMap(s => s.lines.map(l => `OPTION — ${s.heading}: ${l.text}`))], allowance: "Options are excluded from the construction price and require separate acceptance. Refer to the Scope of Works for allowances and selections." },
    terms_md: `Read this proposal in conjunction with Scope of Works ${sow.revision_label}. Post-contract changes require a separate variation identifying the description, price, GST and time effects, with approval tied to the exact version. The original accepted proposal remains unchanged.`,
    construction: { schema: 1, estimate_version_id: version.id, estimate_label: version.label, sow_id: sow.id, sow_revision: sow.revision_label, source_digest: sourceDigest, previous_proposal_id: previous?.id ?? null, prices, payments, subtotal_ex_gst: subtotal, gst, total_inc: total, estimate_total_inc: price(version.snapshot.wholeJob.combinedIncGst), changes: [] },
  };
  content.construction.changes = constructionChanges(previous?.content, content);
  // Shared renderers already handle sections, so changes appear identically in HTML and PDF.
  content.scope_sections.push({ title: "Version change summary", bullets: content.construction.changes, deliverables: [] });
  return content;
}

/** A frozen review document sourced from the existing client billing variation
 * package. It cannot modify the package, base proposal, or approval evidence. */
export function buildConstructionVariation(input: {
  base: Proposal;
  baseDigest: string;
  sourceDigest: string;
  package: { id: string; project_id: string; label: string; amount_inc_gst: number };
  description: string;
  time_effect_days: number;
  time_effect_note: string;
}): ConstructionContent {
  const { base, package: pack } = input;
  if (!isConstruction(base.content) || base.content.construction.variation || base.status !== "accepted" || !base.signed_name || !base.signed_at) throw new Error("Choose the accepted original construction proposal with recorded approval evidence.");
  if (base.project_id !== pack.project_id) throw new Error("Variation package and accepted proposal must belong to the same project.");
  if (typeof input.description !== "string" || !input.description.trim() || typeof input.time_effect_note !== "string" || !input.time_effect_note.trim() || !Number.isInteger(input.time_effect_days) || Math.abs(input.time_effect_days) > 36500) throw new Error("Provide the variation description and explicit time effect (days and explanation).");
  const total = price(pack.amount_inc_gst);
  if (total <= 0) throw new Error("This existing variation package requires a positive selling value.");
  const ex = roundMoney(total / 1.1), gst = roundMoney(total - ex);
  const meta = base.content.construction;
  const changes = [`Separate variation to accepted proposal ${base.id}; original total remains ${money(base.total_inc)} inc GST.`, `Additional selling price: ${money(total)} inc GST.`, `Time effect: ${input.time_effect_days} days — ${input.time_effect_note.trim()}`];
  return {
    kind: "construction",
    letter: "Post-contract variation — internal review draft. Not issued or available for approval.",
    vision: `Variation package: ${pack.label}. This document is separate from the accepted original proposal.`,
    scope_sections: [{ title: "Variation description", bullets: [input.description.trim()], deliverables: [] }, { title: "Version change summary", bullets: changes, deliverables: [] }],
    fees: { mode: "single", stages: [{ label: "Variation selling price", total_inc: total, milestones: [] }], payment_lines: [`Subtotal: ${money(ex)} ex GST; GST (10%): ${money(gst)}; variation total: ${money(total)} inc GST.`, "Payment terms require review against the linked variation package before issue."] },
    timeline: [{ phase: "Variation time effect", duration: `${input.time_effect_days} days — ${input.time_effect_note.trim()}` }],
    exclusions: { bullets: ["Original accepted contract scope and price remain unchanged."], allowance: "This variation is not yet approved. No claim or payment is created by this draft." },
    terms_md: "INTERNAL REVIEW DRAFT\n\nVariation terms require verification against the actual signed contract before issue. Approval must identify this exact document version. No approval is recorded by generating this draft.",
    construction: { schema: 1, estimate_version_id: meta.estimate_version_id, estimate_label: meta.estimate_label, sow_id: meta.sow_id, sow_revision: meta.sow_revision, source_digest: input.sourceDigest, previous_proposal_id: null, prices: [{ key: `variation:${pack.id}`, label: pack.label, group: "variation", selling_ex_gst: ex }], payments: [], subtotal_ex_gst: ex, gst, total_inc: total, estimate_total_inc: base.total_inc, changes,
      variation: { package_id: pack.id, accepted_proposal_id: base.id, accepted_version_digest: input.baseDigest, description: input.description.trim(), time_effect_days: input.time_effect_days, time_effect_note: input.time_effect_note.trim(), approval_history: [{ proposal_id: base.id, version_digest: input.baseDigest, decision: "accepted", name: base.signed_name, at: base.signed_at }] },
    },
  };
}
