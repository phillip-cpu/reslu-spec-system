import type { EstimateResponse, Item, CostSectionWithLines, MeasurementGroupWithRows, Variation } from '@/types';
import type { EstimateSnapshot } from '@/types/phase-12a-a';
import { ffeRollup, projectRollup, sectionRollup, wholeJobSummary } from '../estimate.ts';
import { DEFAULT_FFE_MARKUP_PERCENT } from '../ffe-pricing.ts';
import { buildEstimateFfeItemSnapshots } from '../estimate-ffe-snapshot.ts';

export type Row = { id: string; [key: string]: unknown };
export interface JobRevisionPayload {
  schema: 1;
  project_id: string;
  markup_pct: number;
  sections: (Row & { lines: Row[] })[];
  items: Row[];
  measurement_groups: (Row & { measurements: Row[] })[];
  scope: { document: Row; sections: (Row & { lines: Row[] })[] };
  /** References/metadata remain frozen; no invoice, purchase or payment records are copied. */
  rooms: Row[];
  item_rooms: Row[];
  item_components: Row[];
  allowances: Row[];
  options: Row[];
  payments: Row[];
  /** Historical approved variation references; not independently cloned or editable. */
  approved_variations?: Row[];
}
export interface RevisionWorkspace {
  id: string; project_id: string; source_version_id: string; source_hash: string;
  label: string; lock_version: number; payload: JobRevisionPayload;
  created_at: string; updated_at: string;
}
export interface FrozenJob {
  payload: JobRevisionPayload;
  sent_pdf: { reference: string; sha256: string; bytes: number; storage_path?: string };
  source_manifest_sha256: string;
  captured_at: string;
}
export const accountingKeys = new Set(['actual_paid_ex_gst', 'source_payments', 'cost_line_source_payments', 'invoice_id', 'invoice_line_id', 'payment_id', 'xero_id', 'xero_invoice_id', 'ordered_at', 'delivered_at', 'client_approved', 'client_actioned_at']);
export const ownedLists = ['sections','items','measurement_groups','item_rooms','item_components','allowances','options','payments'] as const;

export function ownedRows(p: JobRevisionPayload): Row[] {
  return [...p.sections.flatMap(s => [s, ...s.lines]), ...p.items,
    ...p.measurement_groups.flatMap(g => [g, ...g.measurements]), p.scope.document,
    ...p.scope.sections.flatMap(s => [s, ...s.lines]), ...p.item_rooms, ...p.item_components,
    ...p.allowances, ...p.options, ...p.payments];
}

export function validatePayload(p: JobRevisionPayload) {
  if (!p || p.schema !== 1 || !p.project_id || !Number.isFinite(p.markup_pct) || p.markup_pct < 0 || p.markup_pct > 10) throw new Error('Invalid revision payload or markup.');
  for (const key of [...ownedLists, 'rooms'] as const) if (!Array.isArray(p[key])) throw new Error(`Missing ${key}.`);
  if (!p.scope?.document || !Array.isArray(p.scope.sections)) throw new Error('Missing frozen scope.');
  const rows = ownedRows(p), ids = new Set<string>();
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) throw new Error('Missing or duplicate revision identity.');
    ids.add(row.id);
    if (row.project_id && row.project_id !== p.project_id) throw new Error('Cross-project row.');
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Invalid ${key}.`);
      if (['quantity','qty','wastage_pct','coverage_per_unit','markup_pct','percent','amount_inc_gst'].includes(key) && typeof value === 'number' && value < 0) throw new Error(`Negative ${key}.`);
    }
  }
  for(const i of p.items){if(!Number.isFinite(i.quantity)||Number(i.quantity)<0||!['direct','trade_package'].includes(String(i.cost_scope)))throw new Error('Invalid FF&E quantity or cost scope.');}
  for(const g of p.measurement_groups)for(const m of g.measurements)if(!Number.isFinite(m.value))throw new Error('Invalid measurement value.');
  const exists = (id: unknown, list: Row[]) => id == null || id === '' || list.some(r => r.id === id);
  const measurements = p.measurement_groups.flatMap(g=>g.measurements);
  for (const s of p.sections) for (const l of s.lines) {
    if (l.section_id !== s.id || !exists(l.measurement_id, measurements) || !exists(l.item_id, p.items)) throw new Error('Invalid estimate relationship.');
  }
  for (const g of p.measurement_groups) for (const m of g.measurements) if (m.group_id !== g.id || !exists(m.item_id,p.items)) throw new Error('Invalid measurement relationship.');
  for (const i of p.items) if (!exists(i.measurement_id,measurements)) throw new Error('Invalid item measurement.');
  for (const s of p.scope.sections) {
    if (s.sow_id !== p.scope.document.id) throw new Error('Invalid scope relationship.');
    for (const l of s.lines) if (l.section_id !== s.id) throw new Error('Invalid scope line relationship.');
  }
  for (const r of [...p.item_rooms,...p.item_components]) if (!exists(r.item_id,p.items)) throw new Error('Invalid item relationship.');
  for (const payment of p.payments) if (typeof payment.percent !== 'number' || payment.percent > 100) throw new Error('Invalid payment percentage.');
}

/** Drafts may be incomplete, but never pass readiness validation until exactly 100%. */
export function paymentValidation(p: JobRevisionPayload) {
  const total = p.payments.reduce((n,r)=>n+Math.round(Number(r.percent)*100),0);
  return { total: total/100, remaining: (10000-total)/100, valid: p.payments.length > 0 && total === 10000 };
}

export function revisionEstimate(p: JobRevisionPayload): EstimateResponse {
  const groups = p.measurement_groups as unknown as MeasurementGroupWithRows[];
  const measurements = groups.flatMap(g=>g.measurements.map(m=>({...m,group_name:g.name})));
  const byId = new Map(measurements.map(m=>[m.id,{value:m.value}]));
  const sections = (p.sections as unknown as CostSectionWithLines[]).map(s=>({...s,rollup:sectionRollup(s.lines,byId,p.markup_pct)}));
  const rollup = projectRollup({lines:sections.flatMap(s=>s.lines),variations:(p.approved_variations??[]) as unknown as Pick<Variation,'status'|'cost_ex_gst'>[],markupPct:p.markup_pct,measurementsById:byId});
  const ffe = ffeRollup(p.items as unknown as Item[],byId);
  return {sections,markup_pct:p.markup_pct,measurements,rollup,ffe,wholeJob:wholeJobSummary(rollup,ffe),quote_summaries:{}};
}
export function revisionSnapshot(p: JobRevisionPayload, originIds = false): EstimateSnapshot {
  const e = revisionEstimate(p);
  return {...e, sections: originIds ? e.sections.map(s=>({...s,id:String((s as unknown as Row).origin_id??s.id),lines:s.lines.map(l=>({...l,id:String((l as unknown as Row).origin_id??l.id)}))})) : e.sections,
    ffe_items:buildEstimateFfeItemSnapshots(p.items as unknown as Item[],e.ffe,new Map(e.measurements.map(m=>[m.id,{value:m.value}]))),
    sow_revision_label:String(p.scope.document.revision_label)};
}

/** Pure reference implementation of the database fork; only ownership keys remap. */
export function cloneRevision(p: JobRevisionPayload, uuid: ()=>string): JobRevisionPayload {
  validatePayload(p);
  const ids = new Map(ownedRows(p).map(r=>[r.id,uuid()]));
  const links = new Set(['id','section_id','group_id','measurement_id','item_id','sow_id','parent_item_id','option_id']);
  function copy(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(copy);
    if (!value || typeof value !== 'object') return value;
    const row=value as Record<string,unknown>, next:Record<string,unknown>={};
    for(const [key,v] of Object.entries(row)) {
      if (accountingKeys.has(key)) { next[key] = key.includes('payments') ? [] : key==='client_approved' ? false : null; continue; }
      next[key]=links.has(key)&&typeof v==='string'&&ids.has(v)?ids.get(v):copy(v);
    }
    if (typeof row.id === 'string' && ids.has(row.id)) next.origin_id=row.id;
    return next;
  }
  const next=copy(p) as JobRevisionPayload;
  next.scope.document={...next.scope.document,status:'draft',issued_at:null,revision_label:'Working revision'};
  validatePayload(next); return next;
}

const editable: Record<string,string[]> = {
  sections:['name','sort'], lines:['cost_ex_gst','quoted_to_client_ex_gst','gst_treatment','source_forecast_total_minor','forecast_fx_rate','line_kind','description','qty','unit','rate_ex_gst','quoted_ex_gst','quote_status','notes','sort','measurement_id','item_id','contact_id','markup_pct','wastage_pct','coverage_per_unit','source_currency','source_unit_price','source_exchange_rate','source_exchange_rate_date','source_exchange_rate_note'],
  measurement_groups:['name','sort'], measurements:['label','value','unit','notes','sort','item_id','status','source','provenance_note'],
  item_rooms:['quantity'], item_components:['name','quantity_per_item','unit','price_trade','supplier','supplier_email','brand','finish','product_url','lead_time_weeks'],
  items:['item_code','name','description','category','quantity','unit','price_trade','price_rrp','markup_pct','cost_scope','measurement_id','wastage_pct','coverage_per_unit','supplier','supplier_email','brand','colour','material','finish','width_mm','height_mm','length_mm','depth_mm','location','application_note','product_url','lead_time_weeks','notes'],
  scope_sections:['heading','sort','trade_heading_overrides'], scope_lines:['text','kind','trade','sort'],
  allowances:['description','amount_inc_gst','notes'], options:['description','amount_inc_gst','time_effect','notes'], payments:['description','percent'],
};
export interface RevisionEdit { entity: string; action: 'add'|'patch'|'delete'|'reorder'; id?: string; parent_id?: string; values?: Record<string,unknown>; ids?: string[] }
export function editRevision(input: JobRevisionPayload, edit: RevisionEdit, uuid=()=>crypto.randomUUID()): {payload: JobRevisionPayload; row?: Row} {
  const p=structuredClone(input), {entity,action,id,parent_id,values={}}=edit;
  if (entity==='markup') {
    if(action!=='patch'||Object.keys(values).some(k=>k!=='markup_pct'))throw new Error('Invalid markup edit.');
    p.markup_pct=Number(values.markup_pct);validatePayload(p);return {payload:p};
  }
  if(!editable[entity])throw new Error('This operation is unavailable in a revision.');
  // Existing estimate rows submit unchanged actual fields; accept only the empty value.
  for(const [k,v] of Object.entries(values)) if (!editable[entity].includes(k) && !(k==='actual_paid_ex_gst' && v===null)) throw new Error(`Cannot edit ${k} in a revision.`);
  const clean=Object.fromEntries(Object.entries(values).filter(([k])=>editable[entity].includes(k)));
  let list:Row[]; let foreign:Record<string,unknown>={};
  if(entity==='lines') { const s=p.sections.find(s=>s.id===parent_id||s.lines.some(l=>l.id===id));if(!s)throw new Error('Section not found.');list=s.lines;foreign={section_id:s.id}; }
  else if(entity==='measurements'){ const g=p.measurement_groups.find(g=>g.id===parent_id||g.measurements.some(m=>m.id===id));if(!g)throw new Error('Group not found.');list=g.measurements;foreign={group_id:g.id}; }
  else if(entity==='scope_lines'){ const s=p.scope.sections.find(s=>s.id===parent_id||s.lines.some(l=>l.id===id));if(!s)throw new Error('Scope section not found.');list=s.lines;foreign={section_id:s.id}; }
  else if(entity==='scope_sections'){list=p.scope.sections;foreign={sow_id:p.scope.document.id};}
  else if(entity==='item_components'){list=p.item_components;if(action==='add'){if(!p.items.some(i=>i.id===parent_id))throw new Error('Item not found.');foreign={item_id:parent_id};}}
  else list=p[entity as keyof JobRevisionPayload] as Row[];
  let row:Row|undefined;
  if(action==='reorder') {
    if(!edit.ids || edit.ids.length!==list.length || new Set(edit.ids).size!==list.length || edit.ids.some(i=>!list.some(r=>r.id===i)))throw new Error('Invalid row order.');
    list.sort((a,b)=>edit.ids!.indexOf(a.id)-edit.ids!.indexOf(b.id)).forEach((r,i)=>r.sort=i);
  } else if(action==='add') {
    row={id:uuid(),project_id:p.project_id,sort:list.length,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),...foreign,...clean};
    if(entity==='sections'||entity==='scope_sections')row.lines=[];
    if(entity==='scope_sections')row.source_room_id=null;
    if(entity==='measurement_groups')row.measurements=[];
    if(entity==='lines')row={qty:1,rate_ex_gst:null,quoted_ex_gst:null,actual_paid_ex_gst:null,markup_pct:null,unit:'ea',quote_status:'NA',measurement_id:null,item_id:null,...row};
    if(entity==='items')row={quantity:1,unit:'ea',cost_scope:'direct',price_trade:null,price_rrp:null,markup_pct:DEFAULT_FFE_MARKUP_PERCENT,measurement_id:null,wastage_pct:0,coverage_per_unit:null,category:'OTHER',item_code:'NEW',name:'New item',...row};
    if(entity==='measurements')row={value:0,unit:'m²',...row};
    list.push(row);
  } else {
    const at=list.findIndex(r=>r.id===id);if(at<0)throw new Error('Row not found.');
    if(action==='delete'){
      list.splice(at,1);
      if(entity==='items'){
        p.item_rooms=p.item_rooms.filter(r=>r.item_id!==id);p.item_components=p.item_components.filter(r=>r.item_id!==id);
        for(const s of p.sections)for(const l of s.lines)if(l.item_id===id)l.item_id=null;
        for(const g of p.measurement_groups)for(const m of g.measurements)if(m.item_id===id)m.item_id=null;
      }
    }
    else if(action==='patch'){row={...list[at],...clean,updated_at:new Date().toISOString()};list[at]=row;}
    else throw new Error('Invalid action.');
  }
  validatePayload(p); return {payload:p,row};
}
