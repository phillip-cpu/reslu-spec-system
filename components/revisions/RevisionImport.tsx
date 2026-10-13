'use client';
import { useRef, useState } from 'react';

type Summary={label:string;totalIncGst:number;sections:number;costLines:number;items:number;scopeSections:number;scopeLines:number;paymentPercent:number;pdfSha256:string;archiveSha256:string};
/** No financial archive is bundled or retained in browser storage. The selected
 * File stays in memory until completion/cancel and is only submitted to our API.
 */
export function RevisionImport({projectId,onImported}:{projectId:string;onImported:(id:string)=>Promise<void>}) {
 const [file,setFile]=useState<File|null>(null),[summary,setSummary]=useState<Summary|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
 const pending=useRef(false),input=useRef<HTMLInputElement>(null);
 function clear(){if(pending.current)return;setFile(null);setSummary(null);setError('');if(input.current)input.current.value='';}
 async function submit(mode:'preview'|'commit'){
  if(!file||pending.current||(mode==='commit'&&!summary))return;
  pending.current=true;setBusy(true);setError('');
  try{
   const body=new FormData();body.set('archive',file);body.set('mode',mode);
   if(summary)body.set('confirmed_archive_sha256',summary.archiveSha256);
   const response=await fetch(`/api/projects/${projectId}/revisions/import`,{method:'POST',body}),result=await response.json();
   if(!response.ok)throw Error(result.error??'Import failed.');
   if(mode==='preview'){setSummary(result.summary);return;}
   setFile(null);setSummary(null);setDone(true);if(input.current)input.current.value='';
   await onImported(result.version.id);
  }catch(e){setError(e instanceof Error?e.message:'Import failed. Reload revisions before retrying.');}
  finally{pending.current=false;setBusy(false);}
 }
 if(done)return <p role="status">Protected baseline created. Select it to create an independent working revision.</p>;
 return <section className="border border-sand bg-cream p-4 space-y-3" aria-label="Import reviewed baseline">
  <h2 className="font-display text-section">Import reviewed baseline</h2>
  <p>The original reviewed archive and private PDF must match. Current project data is checked again when the baseline is created.</p>
  <input ref={input} aria-label="Reviewed baseline archive" type="file" accept=".json,application/json" disabled={busy} onChange={e=>{setFile(e.target.files?.[0]??null);setSummary(null);setError('');}}/>
  <div className="flex gap-3"><button className="border border-sand px-3 py-2 disabled:opacity-40" disabled={!file||busy} onClick={()=>void submit('preview')}>Review archive</button><button className="border border-sand px-3 py-2 disabled:opacity-40" disabled={busy||!file} onClick={clear}>Cancel import</button></div>
  {summary&&<div className="space-y-2" aria-label="Reviewed import summary">
   <p>{summary.label} · {new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'}).format(summary.totalIncGst)} including GST</p>
   <p>{summary.sections} estimate sections · {summary.costLines} cost lines · {summary.items} FF&amp;E items · {summary.scopeSections} scope sections · {summary.scopeLines} scope lines</p>
   <p>Payment breakdown: {summary.paymentPercent}% allocated{summary.paymentPercent===100?'':' — incomplete; not ready to issue'}.</p>
   <p className="break-all text-caption">Original PDF verified: {summary.pdfSha256}</p>
   <p>This creates a protected internal baseline. Your signed-in administrator identity is recorded. Nothing is sent or accepted.</p>
   <button className="border border-sand px-3 py-2 disabled:opacity-40" disabled={busy} onClick={()=>void submit('commit')}>Create protected {summary.label}</button>
  </div>}
  {error&&<p role="alert" className="text-red-700">{error}</p>}
 </section>;
}
