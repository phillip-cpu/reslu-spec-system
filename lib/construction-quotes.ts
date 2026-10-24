import type { ProposalContent } from "../types/proposals";

export const QUOTE_HOLD = "Construction quotes are internal drafts. Sending and acceptance are not enabled.";
export interface ConstructionQuoteFields {
  introduction: string;
  scope_summary: string;
  price_ex_gst: number;
  payment_terms: string;
  assumptions: string;
  exclusions: string;
  terms: string;
  drawing_references: string;
}
export const emptyQuote = (): ConstructionQuoteFields => ({ introduction: "", scope_summary: "", price_ex_gst: 0, payment_terms: "", assumptions: "", exclusions: "", terms: "", drawing_references: "" });
export function isConstructionQuote(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "construction_quote";
}
const lines = (s: string) => s.split("\n").map(s => s.trim()).filter(Boolean);
export function quoteContent(value: unknown): ProposalContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Quote fields are required.");
  const q = value as ConstructionQuoteFields;
  const keys = Object.keys(emptyQuote());
  if (Object.keys(q).some(k => !keys.includes(k))) throw new Error("Unsupported quote field.");
  for (const key of keys.filter(k => k !== "price_ex_gst")) {
    if (typeof q[key as keyof ConstructionQuoteFields] !== "string" || String(q[key as keyof ConstructionQuoteFields]).length > 20000) throw new Error("Quote text must be a string of at most 20,000 characters.");
  }
  if (typeof q.price_ex_gst !== "number" || !Number.isFinite(q.price_ex_gst) || q.price_ex_gst < 0 || q.price_ex_gst > 999999999 || Math.abs(q.price_ex_gst * 100 - Math.round(q.price_ex_gst * 100)) > 0.0001) throw new Error("Enter a non-negative selling price with at most two decimal places.");
  const cents = Math.round(q.price_ex_gst * 100), gst = Math.round(cents / 10), total = (cents + gst) / 100;
  const money = (n: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
  return {
    kind: "construction_quote", quote: { ...q },
    letter: q.introduction,
    vision: "Pre-contract price discussion based on the drawings listed below. Detailed scope of works follows agreement on price. Internal draft only; not issued and not a contract.",
    scope_sections: [
      { title: "Scope summary", bullets: lines(q.scope_summary), deliverables: [] },
      { title: "Drawings - identifiers and revisions", bullets: lines(q.drawing_references), deliverables: [] },
      { title: "Assumptions", bullets: lines(q.assumptions), deliverables: [] },
    ],
    fees: { mode: "single", stages: [{ label: "Construction quote (including GST)", total_inc: total, milestones: [] }], price_lines: [`Selling price excluding GST: ${money(cents / 100)}`, `GST (10%): ${money(gst / 100)}`], payment_lines: lines(q.payment_terms) },
    timeline: [], exclusions: { bullets: lines(q.exclusions), allowance: "" }, terms_md: q.terms,
  };
}
