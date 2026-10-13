"use client";
import { useRef, useState } from "react";
export function TradeDisplayHeadingEditor({ trade, heading, overridden, onSave }: { trade: string; heading: string; overridden: boolean; onSave: (value: string | null) => Promise<void> }) {
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(heading),[error,setError]=useState("");
  const [busy,setBusy]=useState(false);const lock=useRef(false);
  async function save(value: string | null) {
    if(lock.current)return;lock.current=true;setBusy(true);setError("");
    try {await onSave(value);setEditing(false);} catch(e){setError((e as Error).message);} finally{lock.current=false;setBusy(false);}
  }
  return <div className="space-y-1">
    {!editing ? <button type="button" className="label-caps !text-nearblack hover:!text-sand" title={`Edit display heading; trade remains ${trade}`} onClick={()=>{setDraft(heading);setError("");setEditing(true);}}>{heading}</button> : <div className="flex flex-wrap gap-2">
      <input aria-label="Trade display heading" maxLength={160} className="border border-[#c9c2b4] px-2 py-1" value={draft} disabled={busy} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'&&!busy)setEditing(false);}}/>
      <button type="button" disabled={busy||!draft.trim()} onClick={()=>save(draft.trim())}>Save heading</button>
      {overridden&&<button type="button" disabled={busy} onClick={()=>save(null)}>Reset heading</button>}
      <button type="button" disabled={busy} onClick={()=>setEditing(false)}>Cancel</button>
      <p className="w-full text-caption text-charcoal/60">Display only. Trade identity remains {trade}.</p>
    </div>}
    {error&&<p role="alert" className="text-caption text-red-700">{error}</p>}
  </div>;
}
