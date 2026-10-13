"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
const input = "border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body";
export function ConstructionVariationBuilder({ projectId, baseId }: { projectId: string; baseId: string }) {
  const router = useRouter();
  const [sources, setSources] = useState<{ source_digest: string; packages: { id: string; label: string; amount_inc_gst: number }[] } | null>(null);
  const [packageId, setPackageId] = useState("");
  const [description, setDescription] = useState("");
  const [days, setDays] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function run(generate: boolean) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const url = `/api/projects/${projectId}/construction-proposals/variation`;
      const res = await fetch(generate ? url : `${url}?base_id=${encodeURIComponent(baseId)}`, generate ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base_id: baseId, package_id: packageId, source_digest: sources?.source_digest, description, time_effect_days: Number(days), time_effect_note: note }) } : undefined);
      const body = await res.json(); if (!res.ok) throw new Error(body.error);
      if (generate) router.push(`/proposals/${body.proposal.id}`); else setSources(body);
    } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="space-y-3 border border-[#dcd6cc] p-4">
    <h3 className="font-display text-subhead">Separate post-contract variation</h3>
    <p>The accepted original remains unchanged. Select an existing client billing variation package; its selling price is frozen into a new review draft.</p>
    <fieldset disabled={busy} className="space-y-3">
      <button className={input} onClick={() => run(false)}>Load variation packages</button>
      {sources && <>
        <label className="block">Variation package <select aria-label="Variation package" className={input} value={packageId} onChange={e => setPackageId(e.target.value)}><option value="">Choose package</option>{sources.packages.map(p => <option key={p.id} value={p.id}>{p.label} · ${p.amount_inc_gst.toFixed(2)} inc GST</option>)}</select></label>
        <label className="block">Description <textarea className={`${input} w-full`} value={description} onChange={e => setDescription(e.target.value)}/></label>
        <label className="block">Time effect (days; enter 0 explicitly for no change) <input className={`${input} w-24`} type="number" step="1" value={days} onChange={e => setDays(e.target.value)}/></label>
        <label className="block">Time effect explanation <textarea className={`${input} w-full`} value={note} onChange={e => setNote(e.target.value)}/></label>
        <button className={input} disabled={!packageId || !description.trim() || days === "" || !Number.isInteger(Number(days)) || !note.trim()} onClick={() => run(true)}>Generate variation review draft</button>
        <button className={input} onClick={() => { setSources(null); setError(""); }}>Cancel</button>
      </>}
    </fieldset>
    {busy && <p role="status">Working…</p>}{error && <p role="alert" className="text-red-700">{error}</p>}
  </section>;
}
