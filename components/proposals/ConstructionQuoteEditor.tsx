"use client";
import { useEffect, useRef, useState } from "react";
import { emptyQuote, quoteContent, type ConstructionQuoteFields } from "@/lib/construction-quotes";
import type { Proposal } from "@/types/proposals";

const inputClass = "w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-sm focus:border-nearblack focus:outline-none";
const labels: Record<Exclude<keyof ConstructionQuoteFields, "price_ex_gst">, string> = {
  introduction: "Introduction", scope_summary: "Scope summary", drawing_references: "Drawing identifiers and revisions (one per line)", payment_terms: "Payment breakdown / terms", assumptions: "Assumptions", exclusions: "Exclusions", terms: "Terms and conditions",
};
// Memory only, scoped to this browser tab. Never persisted to disk or sent automatically.
// Keep the original timestamp so recovered edits still conflict with newer server saves.
const unsavedQuotes = new Map<string, { proposal: Proposal; fields: ConstructionQuoteFields; expires: number }>();
export function ConstructionQuoteEditor({ proposal: initial }: { proposal: Proposal }) {
  const [recovered] = useState(() => {
    const draft = unsavedQuotes.get(initial.id);
    return draft && draft.expires > Date.now() ? draft : undefined;
  });
  const [proposal, setProposal] = useState(recovered?.proposal ?? initial);
  const [serverBaseline, setServerBaseline] = useState(initial);
  const [fields, setFields] = useState(recovered?.fields ?? initial.content.quote ?? emptyQuote());
  const [dirty, setDirty] = useState(!!recovered);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    // Next links can leave without unloading the document.
    const leave = (e: MouseEvent) => {
      if (!dirty || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const next = new URL(link.href, window.location.href);
      if (next.pathname === window.location.pathname && next.search === window.location.search) return;
      if (!window.confirm("Discard unsaved quote changes and leave?")) {
        e.preventDefault(); e.stopPropagation();
      } else { unsavedQuotes.delete(initial.id); }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", leave, true); };
  }, [dirty, initial.id]);
  let price = "Enter a valid selling price.";
  try { const c = quoteContent(fields); price = `${c.fees.price_lines?.join(" · ")} · Total including GST: $${c.fees.stages[0].total_inc.toFixed(2)}`; } catch { /* Validation appears on save. */ }
  function edit(next: ConstructionQuoteFields) {
    unsavedQuotes.set(proposal.id, { proposal, fields: next, expires: Date.now() + 30 * 60 * 1000 });
    setFields(next); setDirty(true);
  }
  async function save() {
    if (lock.current) return;
    lock.current = true; setSaving(true); setError("");
    try {
      const content = quoteContent(fields);
      const res = await fetch(`/api/proposals/${proposal.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, expected_updated_at: proposal.updated_at }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not save quote");
      unsavedQuotes.delete(proposal.id); setProposal(body.proposal); setServerBaseline(body.proposal); setDirty(false);
    } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setSaving(false); }
  }
  return <section style={{ fontFamily: "'Helvetica Neue Light', 'Helvetica Neue', Helvetica, Arial, sans-serif" }} className="mx-auto max-w-4xl space-y-6">
    <h2 className="text-section">Construction quote</h2>
    <p className="text-body text-charcoal/70">Internal pre-contract draft. Quote against the identified drawings; prepare the detailed scope after price agreement. Sending and acceptance are unavailable.</p>
    {recovered && dirty && <p role="status">Unsaved edits recovered from this tab. Review and save, or discard them.</p>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <fieldset disabled={saving || proposal.status !== "draft"} className="grid grid-cols-1 gap-5 md:grid-cols-2">
      {Object.entries(labels).map(([key, label]) => <label key={key} className="block"><span className="mb-2 block text-xs font-medium text-charcoal">{label}</span><textarea rows={key === "terms" ? 4 : 3} className={inputClass} value={fields[key as keyof typeof labels]} onChange={e => { edit({ ...fields, [key]: e.target.value }); }} /></label>)}
      <label className="block"><span className="mb-2 block text-xs font-medium text-charcoal">Selling price excluding GST (AUD)</span><input type="number" min="0" step="0.01" className={inputClass} value={Number.isNaN(fields.price_ex_gst) ? "" : fields.price_ex_gst} onChange={e => { edit({ ...fields, price_ex_gst: e.target.value === "" ? NaN : Number(e.target.value) }); }} /></label>
    </fieldset>
    <p>{price}</p>
    <div className="flex flex-wrap gap-4 items-center border-t border-[#c9c2b4] pt-4 text-sm">
      <button type="button" onClick={save} disabled={saving || !dirty || proposal.status !== "draft"} className="bg-nearblack px-4 py-2 text-white disabled:opacity-50">{saving ? "Saving…" : "Save draft"}</button>
      <button type="button" disabled={saving || !dirty} onClick={() => { unsavedQuotes.delete(proposal.id); setFields(serverBaseline.content.quote ?? emptyQuote()); setProposal(serverBaseline); setDirty(false); setError(""); }} className="border border-[#c9c2b4] px-4 py-2 disabled:opacity-50">Discard unsaved edits</button>
      {!dirty && <a href={`/api/proposals/${proposal.id}/pdf`} target="_blank" rel="noreferrer" className="underline">Preview saved PDF</a>}
      <span aria-live="polite">{dirty ? "Unsaved changes" : "Saved draft"}</span>
    </div>
  </section>;
}
