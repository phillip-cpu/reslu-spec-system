'use client';
import {useId,useState} from 'react';
import {parseCandidateAllocations,type CandidateAllocation,type BuilderLot} from '@/lib/builder-workspaces';

/** Kept behind Organise selections so the image-first schedule stays compact. */
export function CandidateAllocationEditor({allocations=[],rooms=[],lots,busy,onSave}:{allocations?:CandidateAllocation[];rooms?:{id:string;name:string}[];lots:BuilderLot[];busy:boolean;onSave:(rows:CandidateAllocation[])=>Promise<boolean>}) {
 const editorId=useId();
 const [rows,setRows]=useState(allocations);
 const [error,setError]=useState('');
 function change(index:number,patch:Partial<CandidateAllocation>){setRows(current=>current.map((row,i)=>i===index?{...row,...patch}:row))}
 async function save(){try{const parsed=parseCandidateAllocations(rows);setError('');await onSave(parsed)}catch(e){setError(e instanceof Error?e.message:'Invalid allocation')}}
 return <details className="mt-4 text-body"><summary className="cursor-pointer">Edit preliminary rooms &amp; quantities</summary><p className="text-charcoal/60 my-3">Leave quantity blank when unknown. These allocations do not approve products or affect totals and orders.</p>
 <fieldset disabled={busy} className="space-y-3">
 {rows.map((row,index)=><div key={index} className="border border-[#dcd6cc] p-3 space-y-2"><div className="flex flex-wrap gap-3">
 <label>Room <input className="border p-2" list={`${editorId}-rooms-${index}`} value={row.room} maxLength={120} onChange={e=>change(index,{room:e.target.value,room_id:rooms.find(r=>r.name===e.target.value)?.id})}/><datalist id={`${editorId}-rooms-${index}`}>{rooms.map(r=><option key={r.id} value={r.name}/>)}</datalist></label>
 <label>Lot <select className="border p-2" value={row.lot_key??''} onChange={e=>change(index,{lot_key:e.target.value||undefined})}><option value="">Selection scope</option>{lots.map(l=><option key={l.key} value={l.key}>{l.label}</option>)}</select></label>
 <label>Quantity <input className="border p-2 w-24" type="number" min="0" step="any" placeholder="TBC" value={row.quantity??''} onChange={e=>change(index,{quantity:e.target.value===''?null:Number(e.target.value)})}/></label>
 <label>Unit <input className="border p-2 w-20" maxLength={24} placeholder="ea, m²" value={row.unit??''} onChange={e=>change(index,{unit:e.target.value||null})}/><datalist id={`${editorId}-rooms-${index}`}>{rooms.map(r=><option key={r.id} value={r.name}/>)}</datalist></label>
 <label>Lot basis <select className="border p-2" value={row.lot_basis} onChange={e=>change(index,{lot_basis:e.target.value as CandidateAllocation['lot_basis']})}><option value="unknown">TBC</option><option value="per_lot">Per lot</option><option value="project_total">Project total</option></select></label>
 <button type="button" className="underline" onClick={()=>setRows(current=>current.filter((_,i)=>i!==index))}>Remove allocation {index+1}</button></div>
 <label className="block">Evidence basis <select className="border p-2" value={row.quantity_basis??'unconfirmed'} onChange={e=>change(index,{quantity_basis:e.target.value as CandidateAllocation['quantity_basis']})}><option value="unconfirmed">Unconfirmed</option><option value="plan_count">Plan count</option><option value="preliminary_schedule">Preliminary schedule</option><option value="measured_area">Measured area</option></select></label>
 <label className="block">Source revision <input className="border p-2" maxLength={1000} value={row.source_revision??''} onChange={e=>change(index,{source_revision:e.target.value})}/></label>
 <label className="block">Source <input className="border p-2 w-full" maxLength={1000} value={row.source_reference??''} onChange={e=>change(index,{source_reference:e.target.value})}/></label>
 <label className="block">Missing basis / coordination notes <input className="border p-2 w-full" maxLength={1000} value={row.note??''} onChange={e=>change(index,{note:e.target.value})}/></label>
 </div>)}
 <div className="flex gap-4"><button type="button" disabled={rows.length>=100} className="underline" onClick={()=>setRows(current=>[...current,{room:'',quantity:null,unit:null,lot_basis:'unknown',status:'preliminary'}])}>Add room</button><button type="button" className="border px-4 py-2" onClick={save}>Save preliminary allocations</button></div>
 </fieldset>{error&&<p role="alert" className="text-red-700 mt-2">{error}</p>}</details>;
}
