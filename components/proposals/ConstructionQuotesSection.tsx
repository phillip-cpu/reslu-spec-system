"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Proposal } from "@/types/proposals";
export function ConstructionQuotesSection({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [quotes, setQuotes] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false), requestId = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    fetch(`/api/proposals?project_id=${projectId}`).then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b.error); if (active) setQuotes((b.proposals as Proposal[]).filter(p => p.content.kind === "construction_quote")); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [projectId]);
  async function create() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    requestId.current ??= crypto.randomUUID();
    try {
      const r = await fetch(`/api/projects/${projectId}/construction-quotes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: requestId.current }) });
      const b = await r.json(); if (!r.ok) throw new Error(b.error || "Could not create quote");
      router.push(`/proposals/${b.proposal.id}`);
    } catch (e) { setError((e as Error).message); lock.current = false; setBusy(false); }
  }
  return <section className="space-y-3 border border-[#dcd6cc] p-5">
    <h3 className="font-sans text-section">Pre-contract construction quotes</h3>
    <p className="text-body text-charcoal/60">Editable price and scope summary against drawings. Detailed scope follows price agreement.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <button type="button" disabled={busy} onClick={create} className="bg-nearblack px-4 py-2 text-white disabled:opacity-50">{busy ? "Creating…" : "New construction quote"}</button>
    {quotes.map(q => <p key={q.id}><a className="underline" href={`/proposals/${q.id}`}>Construction quote · {q.status} · ${Number(q.total_inc).toFixed(2)} inc GST</a></p>)}
  </section>;
}
