"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EstimateVersion } from '@/types/phase-12a-a';
import type { MeasurementGroupWithRows } from '@/types';
import type { SowSectionWithTradedLines } from '@/types/sow-trade-tags';
import { EstimateView } from '@/components/estimate/EstimateView';
import { MeasurementsView } from '@/components/estimate/MeasurementsView';
import { VersionSnapshotView } from '@/components/estimate/VersionsPanel';
import { SectionBlock } from '@/components/sow/SowBuilder';
import { EditableCell } from '@/components/items/SpecRegister';
import { formatMoney } from '@/components/estimate/EstimateWorkspace';
import { diffSections, diffFfeSubstitutions, ffeSubstitutionItemsFromSnapshot } from '@/lib/estimate-versions';
import { RevisionImport } from './RevisionImport';
import { RevisionTransportContext } from './RevisionTransport';
import { createRevisionTransport } from '@/lib/revisions/adapter';
import { revisionChangeSummary } from '@/lib/revisions/change-summary';
import { priceRevisionVariation } from '@/lib/revisions/variation-pricing';
import { editRevision, paymentValidation, revisionEstimate, revisionSnapshot, type FrozenJob, type JobRevisionPayload, type RevisionEdit, type RevisionWorkspace, type Row } from '@/lib/revisions/model';

type Version = EstimateVersion & {frozen_job_hash:string; snapshot:EstimateVersion['snapshot'] & {full_job_revision:FrozenJob}};
type Summary={id:string;label:string;frozen_job_hash?:string;source_version_id?:string};
type Loaded={workspace:RevisionWorkspace|null;version:Version};
const noOp=()=>{};
const button='border border-sand px-3 py-2 text-caption disabled:opacity-40';
const tabs=['Estimate','FF&E','Measurements','Scope','Allowances & options','Payment drafts','Compare'] as const;

export function RevisionWorkspaceView({projectId}:{projectId:string}){
 const [entries,setEntries]=useState<{versions:Summary[];workspaces:Summary[]}>({versions:[],workspaces:[]});
 const [loaded,setLoaded]=useState<Loaded|null>(null),[draft,setDraft]=useState<JobRevisionPayload|null>(null);
 const draftRef=useRef<JobRevisionPayload|null>(null);
 const [selected,setSelected]=useState(''),[tab,setTab]=useState<typeof tabs[number]>('Estimate');
 const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [forkLabel,setForkLabel]=useState('V3');
 const pending=useRef(false), forkRequest=useRef<{key:string;id:string}|null>(null);
 const saveRequest=useRef<{body:string;id:string}|null>(null);
 const [epoch,setEpoch]=useState(0);
 const api=`/api/projects/${projectId}/revisions`;
 const list=useCallback(async()=>{const r=await fetch(api,{cache:'no-store'}),b=await r.json();if(!r.ok)throw Error(b.error);setEntries(b);return b as typeof entries;},[api]);
 useEffect(()=>{let active=true;const timer=setTimeout(()=>void list().catch(e=>active&&setError(e.message)),0);return()=>{active=false;clearTimeout(timer)};},[list]);
 useEffect(()=>{if(!dirty)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[dirty]);
 async function open(id:string){
  if(pending.current)return;
  if(dirty&&!window.confirm('Discard unsaved revision changes?'))return;
  pending.current=true;setBusy(true);setError('');
  try{const r=await fetch(`${api}/${id}`,{cache:'no-store'}),b=await r.json();if(!r.ok)throw Error(b.error);
   setLoaded(b);const p=b.workspace?.payload??b.version.snapshot.full_job_revision.payload;draftRef.current=p;setDraft(p);setDirty(false);setSelected(id);setEpoch(e=>e+1);setNotice('');saveRequest.current=null;
  }catch(e){setError(e instanceof Error?e.message:'Could not load revision.');}finally{pending.current=false;setBusy(false);}
 }
 const apply=useCallback((edit:RevisionEdit)=>{
  if(!draftRef.current||!loaded?.workspace||pending.current)throw Error('This revision is read-only or saving.');
  const result=editRevision(draftRef.current,edit);draftRef.current=result.payload;setDraft(result.payload);setDirty(true);setNotice('');return result;
 },[loaded]);
 // The adapter stores event callbacks; it never invokes them during render.
 // eslint-disable-next-line react-hooks/refs
 const transport=useMemo(()=>({revision:true,fetch:createRevisionTransport(()=>{if(!draftRef.current)throw Error('No revision.');return draftRef.current;},apply,!loaded?.workspace)}),[apply,loaded]);
 async function fork(){
  if(!loaded||pending.current)return;
  const key=loaded.version.id+'|'+forkLabel.trim();
  if(!forkRequest.current||forkRequest.current.key!==key)forkRequest.current={key,id:crypto.randomUUID()};
  pending.current=true;setBusy(true);setError('');
  try{const r=await fetch(api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_version_id:loaded.version.id,source_hash:loaded.version.frozen_job_hash,label:forkLabel.trim(),request_id:forkRequest.current.id})}),b=await r.json();if(!r.ok)throw Error(b.error);
   setLoaded({...loaded,workspace:b.workspace});draftRef.current=b.workspace.payload;setDraft(b.workspace.payload);setSelected(b.workspace.id);setDirty(false);setEpoch(e=>e+1);await list();setNotice('Independent working revision created. Nothing issued.');
  }catch(e){setError(e instanceof Error?e.message:'Could not fork.');}finally{pending.current=false;setBusy(false);}
 }
 async function save(){
  if(!loaded?.workspace||!draftRef.current||pending.current||!dirty)return;
  const w=loaded.workspace,body={payload:draftRef.current,source_hash:w.source_hash,expected_version:w.lock_version};
  const bodyKey=JSON.stringify(body);if(saveRequest.current?.body!==bodyKey)saveRequest.current={body:bodyKey,id:crypto.randomUUID()};
  pending.current=true;setBusy(true);setError('');
  try{const r=await fetch(`${api}/${w.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,request_id:saveRequest.current.id})}),b=await r.json();if(!r.ok)throw Error(b.error);
   setLoaded({...loaded,workspace:b.workspace});draftRef.current=b.workspace.payload;setDraft(b.workspace.payload);setDirty(false);saveRequest.current=null;setNotice('Working revision saved. Frozen baseline unchanged.');
  }catch(e){setError(e instanceof Error?e.message:'Save failed; draft retained.');}finally{pending.current=false;setBusy(false);}
 }
 function cancel(){if(!loaded||pending.current)return;const p=loaded.workspace?.payload??loaded.version.snapshot.full_job_revision.payload;draftRef.current=p;setDraft(p);setDirty(false);setEpoch(e=>e+1);setError('');setNotice('Unsaved changes discarded.');saveRequest.current=null;}
 function change(edit:RevisionEdit){try{apply(edit);}catch(e){setError(e instanceof Error?e.message:'Edit failed.');}}
 const readOnly=!loaded?.workspace, estimate=draft?revisionEstimate(draft):null;
 const payments=draft?paymentValidation(draft):null;
 const variationPricing=loaded&&draft?priceRevisionVariation(loaded.version.snapshot.full_job_revision.payload,draft):null;
 return <div className="space-y-5">
  <a href={`/projects/${projectId}/estimate`} className="text-caption underline" onClick={e=>{if(dirty&&!confirm('Discard unsaved revision changes?'))e.preventDefault();}}>Back to project estimate</a>
  <p className="text-body">Job revisions are private. Working changes do not update the current project, invoices, actual payments, orders or sent proposals.</p>
  <div className="flex flex-wrap gap-3 items-center">
   <label>Revision <select aria-label="Revision" className={button} value={selected} disabled={busy} onChange={e=>void open(e.target.value)}><option value="" disabled>Select revision</option>{entries.versions.map(v=><option key={v.id} value={v.id}>{v.label} · frozen / read-only</option>)}{entries.workspaces.map(w=><option key={w.id} value={w.id}>{w.label} · working / unissued</option>)}</select></label>
   {loaded&&<button className={button} disabled={busy} onClick={()=>void open(selected)}>Reload</button>}
   {loaded&&!readOnly&&<><button className={button} disabled={busy||!dirty} onClick={()=>void save()}>Save working revision</button><button className={button} disabled={busy||!dirty} onClick={cancel}>Cancel changes</button></>}
  </div>
  {entries.versions.length===0&&<RevisionImport projectId={projectId} onImported={async id=>{await list();await open(id);}}/>}
  {error&&<p role="alert" className="border border-red-700 p-3 text-red-700">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {loaded&&draft&&estimate&&<>
   <div className="border border-sand bg-cream p-4 space-y-2"><h2 className="font-display text-section">{loaded.workspace?.label??loaded.version.label} · {readOnly?'Frozen / read-only':'Working / unissued'}{dirty?' · Unsaved changes':''}</h2>
    <p className="text-caption">Baseline: {loaded.version.label} · {loaded.version.frozen_job_hash}</p>
    <p className="text-caption break-all">Exact sent PDF: {loaded.version.snapshot.full_job_revision.sent_pdf.reference} · {loaded.version.snapshot.full_job_revision.sent_pdf.bytes} bytes · SHA-256 {loaded.version.snapshot.full_job_revision.sent_pdf.sha256}</p>
    {loaded.version.snapshot.full_job_revision.sent_pdf.storage_path&&<a className="underline" target="_blank" rel="noreferrer" href={`${api}/${selected}/sent-pdf`}>Open exact sent PDF</a>}
    {readOnly&&<div className="flex gap-2"><input aria-label="New working revision label" className={button} value={forkLabel} onChange={e=>setForkLabel(e.target.value)}/><button className={button} disabled={busy||!forkLabel.trim()} onClick={()=>void fork()}>Create working revision</button></div>}
   </div>
   <nav className="flex flex-wrap gap-2" aria-label="Revision sections">{tabs.map(t=><button key={t} className={`${button} ${tab===t?'bg-nearblack text-white':''}`} onClick={()=>setTab(t)}>{t}</button>)}</nav>
   <RevisionTransportContext.Provider value={transport}><div key={`${selected}-${epoch}`}>
    {tab==='Estimate'&&(readOnly?<VersionSnapshotView version={{...loaded.version,snapshot:revisionSnapshot(draft)}}/>:<fieldset disabled={busy}><EstimateView projectId={projectId} estimate={estimate} notInitialised={false} onInitialise={noOp} onReload={noOp} onLineAdded={noOp} onLineChanged={noOp} onLineRemoved={noOp} onLinesReordered={noOp} approvedVariationsTotal={0} measurements={estimate.measurements} onOpenQuoteRequests={()=>setError('Quote requests remain project-owned. No sending is available here.')}/></fieldset>)}
    {tab==='Measurements'&&<fieldset disabled={readOnly||busy}><MeasurementsView projectId={projectId} groups={draft.measurement_groups as unknown as MeasurementGroupWithRows[]} onReload={noOp} onMeasurementAdded={noOp} onMeasurementChanged={noOp} onMeasurementRemoved={noOp}/></fieldset>}
    {tab==='FF&E'&&<><RevisionRows rows={draft.items} entity="items" readOnly={readOnly||busy} onEdit={change} fields={[
     ['item_code','Code'],['name','Item'],['category','Category'],['quantity','Quantity','number'],['price_trade','Trade cost ex GST','number'],['price_rrp','RRP ex GST','number'],['markup_pct','Markup %','number'],['cost_scope','direct / trade_package'],['measurement_id','Measurement ID'],['wastage_pct','Wastage %','number'],['coverage_per_unit','Coverage per unit','number'],['description','Description'],['supplier','Supplier'],['unit','Unit'],['colour','Colour'],['material','Material'],['finish','Finish'],['location','Location'],['application_note','Application'],['product_url','Product URL'],['lead_time_weeks','Lead time weeks','number']
    ]}/><h3 className="mt-4">Item room allocations</h3><RevisionRows rows={draft.item_rooms.map(r=>({...r,name:`${draft.items.find(i=>i.id===r.item_id)?.name??'Item'} · ${draft.rooms.find(room=>room.id===r.room_id)?.name??'Room'}`}))} entity="item_rooms" fields={[["quantity","Room quantity","number"]]} readOnly={readOnly||busy} onEdit={change} allowAdd={false}/><h3 className="mt-4">Item components</h3><RevisionRows rows={draft.item_components} entity="item_components" fields={[["name","Component"],["quantity_per_item","Quantity per item","number"],["price_trade","Trade cost ex GST","number"],["supplier","Supplier"]]} readOnly={readOnly||busy} onEdit={change} allowAdd={false}/></>} 
    {tab==='Scope'&&<div className="space-y-3">{draft.scope.sections.map((s,index)=><SectionBlock allowLineSelection={false} key={s.id} section={s as unknown as SowSectionWithTradedLines} defaultExpanded={false} readOnly={readOnly||busy} presetNames={Array.from(new Set(draft.scope.sections.flatMap(s=>s.lines.map(l=>String(l.trade??'')).filter(Boolean))))} assignmentsByRoleKey={new Map()} onRename={async heading=>{apply({entity:'scope_sections',action:'patch',id:s.id,values:{heading}});}} onTradeHeading={async(trade,heading)=>{const headings={...(s.trade_heading_overrides as Record<string,string>??{})};if(heading)headings[trade]=heading;else delete headings[trade];apply({entity:'scope_sections',action:'patch',id:s.id,values:{trade_heading_overrides:headings}});}} onDelete={()=>change({entity:'scope_sections',action:'delete',id:s.id})} canMoveUp={index>0} canMoveDown={index<draft.scope.sections.length-1} roomReordering={false} onMoveUp={()=>moveSection(s.id,-1)} onMoveDown={()=>moveSection(s.id,1)} onAddLine={async(text,kind,trade)=>{apply({entity:'scope_lines',action:'add',parent_id:s.id,values:{text,kind,trade}});}} onPatchLine={async(line,patch)=>apply({entity:'scope_lines',action:'patch',id:line.id,values:patch}).row as unknown as typeof line} onDeleteLine={line=>change({entity:'scope_lines',action:'delete',id:line.id})} onReorderLine={async(id,to)=>{const ids=s.lines.map(l=>l.id),from=ids.indexOf(id);ids.splice(from,1);ids.splice(to,0,id);apply({entity:'scope_lines',action:'reorder',parent_id:s.id,ids});}} lineReordering={false} selectedLineIds={new Set()} onToggleLineSelection={noOp}/>)}{!readOnly&&<button className={button} disabled={busy} onClick={()=>change({entity:'scope_sections',action:'add',values:{heading:'New scope section'}})}>Add scope section</button>}</div>}
    {tab==='Allowances & options'&&<div className="space-y-5"><p>Allowance notes are references to amounts included in the estimate; options are separate and excluded from the base total. Update the relevant estimate line for any base-price change.</p><h3>Allowances included in base estimate</h3><RevisionRows rows={draft.allowances} entity="allowances" fields={[['description','Description'],['amount_inc_gst','Included allowance inc GST','number'],['notes','Notes']]} readOnly={readOnly||busy} onEdit={change}/><h3>Separate options</h3><RevisionRows rows={draft.options} entity="options" fields={[['description','Description'],['amount_inc_gst','Option inc GST','number'],['time_effect','Time effect'],['notes','Notes']]} readOnly={readOnly||busy} onEdit={change}/></div>}
    {tab==='Payment drafts'&&<><p role="status" className="mb-4">Payment total: {payments?.total}% · {payments?.valid?'100% allocated':`${payments?.remaining}% unallocated — not ready to issue`}. GST is included in milestone amounts. Design receivables and actual payments remain unchanged.</p><RevisionRows rows={draft.payments} entity="payments" fields={[['description','Stage'],['percent','Percent','number']]} readOnly={readOnly||busy} onEdit={change}/><ul className="mt-4">{draft.payments.map(p=><li key={p.id}>{String(p.description)}: {formatMoney((variationPricing?.total_inc_gst??estimate.wholeJob.combinedIncGst)*Number(p.percent)/100)} inc GST</li>)}</ul></>}
    {tab==='Compare'&&<RevisionComparison baseline={loaded.version.snapshot.full_job_revision.payload} draft={draft}/>}
   </div></RevisionTransportContext.Provider>
   {variationPricing&&<div className="border border-sand bg-cream p-4"><p>Variation-priced selling total: {formatMoney(variationPricing.selling_ex_gst)} ex GST + {formatMoney(variationPricing.gst)} GST = {formatMoney(variationPricing.total_inc_gst)} inc GST.</p><p>Original profit retained: {formatMoney(variationPricing.baseline_profit_ex_gst)}. Added profit: {formatMoney(variationPricing.profit_added_ex_gst)}. Resulting profit: {formatMoney(variationPricing.profit_ex_gst)} ex GST.</p><p>Removed work credits cost only. Added work receives the applicable trade or FF&E markup. Separate options are excluded.</p></div>}
   <p className="text-caption">Estimate recalculation before the retained-profit variation rule: {formatMoney(estimate.wholeJob.combinedExGst)} ex GST + {formatMoney(estimate.wholeJob.combinedGst)} GST = {formatMoney(estimate.wholeJob.combinedIncGst)} inc GST. Options remain separate.</p>
  </>}
 </div>;
 function moveSection(id:string,by:number){if(!draft)return;const ids=draft.scope.sections.map(s=>s.id),from=ids.indexOf(id);ids.splice(from,1);ids.splice(from+by,0,id);change({entity:'scope_sections',action:'reorder',ids});}
}

type Field=[string,string,('number')?];
function RevisionRows({rows,entity,fields,readOnly,onEdit,allowAdd=true}:{rows:Row[];entity:string;fields:Field[];readOnly:boolean;onEdit:(e:RevisionEdit)=>void;allowAdd?:boolean}){
 return <fieldset disabled={readOnly} className="space-y-3">{rows.map(row=><details key={row.id} className="border border-sand p-3"><summary>{String(row.item_code??'')} {String(row.name??row.description??'New entry')}</summary><div className="grid grid-cols-2 gap-3 p-2">{fields.map(([key,label,type])=><div key={key}><span className="label-caps">{label}</span>{readOnly?<p>{String(row[key]??'—')}</p>:<EditableCell value={row[key]==null?null:String(row[key])} type={type??'text'} onCommit={v=>onEdit({entity,action:'patch',id:row.id,values:{[key]:type==='number'?(v===''?null:Number(v)):v||null}})}/>}</div>)}</div>{!readOnly&&<button className={button} onClick={()=>onEdit({entity,action:'delete',id:row.id})}>Remove draft entry</button>}</details>)}{!readOnly&&allowAdd&&<button className={button} onClick={()=>onEdit({entity,action:'add',values:entity==='items'?{}:entity==='payments'?{description:'New stage',percent:0}:{description:'New entry',amount_inc_gst:0}})}>Add {entity==='items'?'FF&E item':'entry'}</button>}</fieldset>;
}
function RevisionComparison({baseline,draft}:{baseline:JobRevisionPayload;draft:JobRevisionPayload}){
 const pricing=priceRevisionVariation(baseline,draft);
 const changes=revisionChangeSummary(baseline,draft);
 const a=revisionSnapshot(baseline),b=revisionSnapshot(draft,true),sections=diffSections(a.sections,b.sections);
 const ffe=diffFfeSubstitutions(ffeSubstitutionItemsFromSnapshot(a)??[],ffeSubstitutionItemsFromSnapshot(b)??[]);
 return <div className="space-y-4"><h3 className="font-display text-section">Baseline → working revision</h3><p>{formatMoney(a.wholeJob.combinedIncGst)} → {formatMoney(b.wholeJob.combinedIncGst)} inc GST ({formatMoney(b.wholeJob.combinedIncGst-a.wholeJob.combinedIncGst)} change)</p>{sections.map(s=><div key={s.name}><h4>{s.name}</h4>{s.lines.filter(l=>l.status!=='unchanged').map((l,i)=><p key={i}>{l.status}: {l.line?.description??l.previous?.description} · cost change {formatMoney(-(l.costDelta??0))} ex GST</p>)}</div>)}<h4>FF&E changes: {ffe.length}</h4>{ffe.map(row=><p key={row.item_code}>{row.item_code}: {row.was?.name??'Added'} → {row.now?.name??'Removed'} · estimate recalculation {formatMoney(-(row.saving??0))} ex GST</p>)}<h4>Variation pricing — cost-only credits, markup on additions</h4>{pricing.changes.map(c=><p key={c.id}>{c.description}: cost {formatMoney(c.cost_delta_ex_gst)}, added profit {formatMoney(c.profit_added_ex_gst)}, selling adjustment {formatMoney(c.selling_delta_ex_gst)} ex GST</p>)}<h4>Full change summary · {changes.length} changes</h4>{changes.map((c,i)=><div key={i} className="border-b border-sand py-2"><p>{c.group}: {c.action} — {c.description}</p>{c.fields.map(f=><p key={f.name} className="text-caption">{f.name}: {JSON.stringify(f.before)} → {JSON.stringify(f.after)}</p>)}</div>)}</div>;
}
