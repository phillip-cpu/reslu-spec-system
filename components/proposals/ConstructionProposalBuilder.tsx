"use client";
import { ConstructionVariationBuilder } from "./ConstructionVariationBuilder";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { validatePayments } from "@/lib/construction-proposals";
import type { ConstructionGroup, ConstructionPayment, ConstructionPrice } from "@/types/construction-proposals";
import type { EstimateVersionSummary } from "@/types/phase-12a-a";
import type { SowDocument } from "@/types";
import type { Proposal } from "@/types/proposals";

const input = "border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body";
export function ConstructionProposalBuilder({ projectId, versions }: { projectId: string; versions: EstimateVersionSummary[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sows, setSows] = useState<SowDocument[]>([]);
  const [previous, setPrevious] = useState<Proposal[]>([]);
  const [versionId, setVersionId] = useState("");
  const [sowId, setSowId] = useState("");
  const [previousId, setPreviousId] = useState("");
  const [review, setReview] = useState<{ source_digest: string; prices: ConstructionPrice[]; scope: { id: string; heading: string }[] } | null>(null);
  const [groups, setGroups] = useState<Record<string, ConstructionGroup>>({});
  const [scopeGroups, setScopeGroups] = useState<Record<string, ConstructionGroup>>({});
  const [payments, setPayments] = useState<ConstructionPayment[]>([{ label: "Deposit", percentage: 0 }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    Promise.all([fetch(`/api/projects/${projectId}/sow`, { signal: controller.signal }), fetch(`/api/proposals?project_id=${projectId}`, { signal: controller.signal })]).then(async responses => {
      const bodies = await Promise.all(responses.map(r => r.json()));
      if (responses.some(r => !r.ok)) throw new Error("Could not load scope and proposal versions.");
      if (!controller.signal.aborted) { setSows(bodies[0].sow_documents.filter((s: SowDocument) => s.status === "issued")); setPrevious(bodies[1].proposals.filter((p: Proposal) => p.content.kind === "construction")); }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [open, projectId]);
  function resetReview() { epoch.current++; setReview(null); setGroups({}); setScopeGroups({}); setError(""); }
  async function loadReview() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    const current = ++epoch.current;
    try {
      const res = await fetch(`/api/projects/${projectId}/construction-proposals?estimate_version_id=${encodeURIComponent(versionId)}&sow_id=${encodeURIComponent(sowId)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      if (epoch.current === current) { setReview(body); setGroups({}); setScopeGroups({}); }
    } catch (e) { if (epoch.current === current) setError((e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function generate() {
    if (inFlight.current || !review) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/construction-proposals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estimate_version_id: versionId, sow_id: sowId, source_digest: review.source_digest, groups, scope_groups: scopeGroups, payments, previous_proposal_id: previousId || undefined }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      router.push(`/proposals/${body.proposal.id}`);
    } catch (e) { setError((e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const paymentError = validatePayments(payments);
  const prior = previous.find(p => p.id === previousId);
  const contracted = prior?.status === "accepted" || prior?.status === "closed";
  return <section className="border border-[#dcd6cc] bg-offwhite p-5 space-y-4">
    <h3 className="font-display text-subhead">Construction proposal</h3>
    <p className="text-body text-charcoal/70">Generate an internal review draft using the existing proposal preview and PDF. Sending and signing remain unavailable.</p>
    {!open ? <button className={input} onClick={() => setOpen(true)}>Prepare construction proposal</button> : <>
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
        <div className="flex flex-wrap gap-3">
          <label className="text-caption">Saved estimate<br/><select aria-label="Saved estimate" className={input} value={versionId} onChange={e => { setVersionId(e.target.value); resetReview(); }}><option value="">Choose version</option>{versions.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label>
          <label className="text-caption">Issued scope<br/><select aria-label="Issued scope" className={input} value={sowId} onChange={e => { setSowId(e.target.value); resetReview(); }}><option value="">Choose matching revision</option>{sows.map(s => <option key={s.id} value={s.id}>{s.revision_label}</option>)}</select></label>
          <label className="text-caption">Revises proposal<br/><select aria-label="Revises proposal" className={input} value={previousId} onChange={e => setPreviousId(e.target.value)}><option value="">Initial draft</option>{previous.map(p => <option key={p.id} value={p.id}>{p.content.construction?.estimate_label} · {p.status} · {p.id.slice(0, 8)}</option>)}</select></label>
        </div>
        {contracted && <p role="alert">Use the project’s separate variation workflow for post-contract changes. The accepted proposal cannot be revised.</p>}
        <button className={input} disabled={!versionId || !sowId || contracted} onClick={loadReview}>Review source prices</button>
        {review && <>
          <p className="text-caption">Classify every selling-price group. Shared preliminaries appear separately. Options are excluded from the base total; confirm their corresponding scope before issue.</p>
          {review.prices.map(p => <div key={p.key} className="flex flex-wrap items-center justify-between gap-2"><span className="text-body">{p.label} — {p.selling_ex_gst.toLocaleString("en-AU", { style: "currency", currency: "AUD" })} ex GST</span><select aria-label={`Classify ${p.label}`} className={input} value={groups[p.key] ?? ""} onChange={e => setGroups({ ...groups, [p.key]: e.target.value as ConstructionGroup })}><option value="">Choose group</option><option value="internal">Internal works</option><option value="external">External works</option><option value="preliminaries">Shared preliminaries</option><option value="option">Option (excluded)</option></select></div>)}
          <h4 className="label-caps">Authoritative scope sections</h4>
          {review.scope.map(s => <div key={s.id} className="flex justify-between gap-2"><span>{s.heading}</span><select aria-label={`Scope ${s.heading}`} className={input} value={scopeGroups[s.id] ?? ""} onChange={e => setScopeGroups({ ...scopeGroups, [s.id]: e.target.value as ConstructionGroup })}><option value="">Choose group</option><option value="internal">Internal works</option><option value="external">External works</option><option value="preliminaries">Shared preliminaries</option><option value="option">Option (excluded)</option></select></div>)}
          <h4 className="label-caps">Payment stages (first stage is deposit)</h4>
          {payments.map((p, i) => <div key={i} className="flex gap-2"><input aria-label={`Stage ${i + 1} name`} className={input} value={p.label} onChange={e => setPayments(payments.map((v, j) => j === i ? { ...v, label: e.target.value } : v))}/><input aria-label={`Stage ${i + 1} percentage`} className={`${input} w-24`} type="number" min="0" max="100" step="0.01" value={p.percentage} onChange={e => setPayments(payments.map((v, j) => j === i ? { ...v, percentage: e.target.value === "" ? 0 : Number(e.target.value) } : v))}/><span>%</span><button className={input} onClick={() => setPayments(payments.filter((_, j) => i !== j))}>Remove</button></div>)}
          <button className={input} onClick={() => setPayments([...payments, { label: "", percentage: 0 }])}>Add stage</button>
          {paymentError && <p role="alert" className="text-caption text-red-700">{paymentError}</p>}
          <button className="bg-nearblack px-4 py-2 text-white disabled:opacity-50" disabled={!!paymentError || review.prices.some(p => !groups[p.key]) || review.scope.some(s => !scopeGroups[s.id]) || contracted} onClick={generate}>Generate frozen draft</button>
        </>}
        <button className={input} onClick={() => { resetReview(); setOpen(false); }}>Cancel</button>
      </fieldset>
      {prior?.status === "accepted" && <ConstructionVariationBuilder key={prior.id} projectId={projectId} baseId={prior.id} />}
      {busy && <p role="status">Working…</p>}
      {error && <p role="alert" className="text-red-700">{error}</p>}
    </>}
  </section>;
}
