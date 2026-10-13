import { validatePayload, revisionSnapshot, type Row, type FrozenJob, type JobRevisionPayload } from './model.ts';
/** Assemble a FULL baseline from reviewed exported rows. No DB/network writes.
 * Source SOW is explicit: do not choose latest or reconcile current rooms.
 * Actual accounting remains in the separate archive; never seed a workspace
 * with invoices, actual payments, receivables, orders or notification records.
 */
export function assembleFrozenJob(input:{project:Row;tables:Record<string,Row[]>;scope:{document:Row;sections:Row[];lines:Row[]};payments:Row[];options:Row[];allowances:Row[];sent_pdf:FrozenJob['sent_pdf'];source_manifest_sha256:string;captured_at:string}){
 const {project,tables,scope}=input;
 const active=(rows:Row[])=>rows.filter(r=>!r.deleted_at);
 const sorted=(rows:Row[])=>[...rows].sort((a,b)=>Number(a.sort??0)-Number(b.sort??0));
 const rows=(name:string)=>{if(!Array.isArray(tables[name]))throw Error(`Required baseline table missing: ${name}`);return tables[name];};
 if(scope.document.project_id!==project.id)throw Error('Scope does not belong to project.');
 const items=active(rows('items')),itemIds=new Set(items.map(i=>i.id));
 const payload:JobRevisionPayload={schema:1,project_id:project.id,markup_pct:Number(project.estimate_markup_pct??0),
  sections:sorted(rows('cost_sections')).map(s=>({...s,lines:sorted(active(rows('cost_lines')).filter(l=>l.section_id===s.id))})),
  items,measurement_groups:sorted(rows('measurement_groups')).map(g=>({...g,measurements:sorted(rows('measurements').filter(m=>m.group_id===g.id))})),
  scope:{document:scope.document,sections:sorted(scope.sections).map(s=>({...s,lines:sorted(scope.lines.filter(l=>l.section_id===s.id))}))},
  rooms:active(rows('rooms')),item_rooms:rows('item_rooms').filter(r=>itemIds.has(String(r.item_id))),item_components:active(rows('item_components')).filter(r=>itemIds.has(String(r.item_id))),
  allowances:input.allowances,options:input.options,payments:input.payments,approved_variations:active(rows('variations')).filter(v=>v.status==='approved')};
 validatePayload(payload);
 if(!/^[a-f0-9]{64}$/.test(input.sent_pdf.sha256)||!input.sent_pdf.reference||input.sent_pdf.bytes<=0||!/^[a-f0-9]{64}$/.test(input.source_manifest_sha256))throw Error('Verified source manifest and exact sent PDF required.');
 const frozen:FrozenJob={payload,sent_pdf:input.sent_pdf,source_manifest_sha256:input.source_manifest_sha256,captured_at:input.captured_at};
 return {frozen,snapshot:revisionSnapshot(payload)};
}
