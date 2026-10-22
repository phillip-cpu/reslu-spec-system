/** Opt-in builder view on the existing PDF endpoint. No cache or data writes. */
import {scheduleProductNote} from '@/lib/schedule-product-notes';
import {NextResponse} from 'next/server';
import {renderToBuffer} from '@react-pdf/renderer';
import type {SupabaseClient} from '@supabase/supabase-js';
import {SchedulePdf,type PdfItem} from '@/components/pdf/SchedulePdf';
import {buildDocBundle,type BundleItemDoc} from '@/lib/pdf-bundle';
import {projectCandidates,projectLots,resolveLotSchedule,candidateAllocationsForScope,candidateRooms,resolveCandidateRoomNames} from '@/lib/builder-workspaces';
import {fetchItemRoomsMap} from '@/lib/portal-rooms';
import {safeFetch} from '@/lib/safe-fetch';
import {normalizePdfImage} from '@/lib/pdf-image';
import {parseCategoriesParam} from '@/lib/export-presets';
import type {Category,ItemFile} from '@/types';

// Explicit spec-only fields; no prices or approval values flow into proposed rows.
const productFields='id,name,category,description,supplier,brand,colour,material,finish,width_mm,height_mm,length_mm,depth_mm,default_image_url,application_note,spec_sheet_url,install_manual_url';
const itemFields='id,item_code,name,category,description,supplier,brand,quantity,cost_scope,unit,colour,material,finish,width_mm,height_mm,length_mm,depth_mm,selected_image_url,application_note,selection_scope,selection_key,library_item_id';

export async function renderBuilderScheduleExport(db:SupabaseClient,id:string,params:URLSearchParams) {
 const {data:project,error:projectError}=await db.from('projects').select('id,name,client_name,address,job_number,builder_id,settings').eq('id',id).is('deleted_at',null).single();
 if(projectError||!project?.builder_id)return NextResponse.json({error:'Builder project not found'},{status:404});
 const scope=params.get('scope')??'shared';const grouping=params.get('grouping')??'room';
 if(!['all','shared',...projectLots(project.settings).map(l=>l.key)].includes(scope)||!['room','type'].includes(grouping))return NextResponse.json({error:'Invalid schedule view'},{status:400});
 let candidates=projectCandidates(project.settings);
 if(candidates.some(c=>c.preliminary_allocations?.some(a=>a.room_id))){
  const {data:roomRows,error}=await db.from('rooms').select('id,name').eq('project_id',id).is('deleted_at',null);
  if(error)return NextResponse.json({error:'Could not load room names'},{status:500});
  candidates=candidates.map(c=>({...c,preliminary_allocations:resolveCandidateRoomNames(c.preliminary_allocations,roomRows??[])}));
 }
 const [itemResult,productResult,categoryResult]=await Promise.all([
  db.from('items').select(itemFields).eq('project_id',id).is('deleted_at',null).order('category').order('item_code'),
  candidates.length?db.from('library_items').select(productFields).in('id',candidates.map(c=>c.library_item_id)):Promise.resolve({data:[],error:null}),
  db.from('categories').select('*').order('sort_order'),
 ]);
 if(itemResult.error||productResult.error||categoryResult.error)return NextResponse.json({error:'Could not load the complete schedule'},{status:500});
 // Supabase's dynamic select strings are narrowed only at this read boundary.
 const items=(itemResult.data??[]) as unknown as (PdfItem&{selection_scope:string;selection_key:string|null;library_item_id:string|null})[];
 const products=(productResult.data??[]) as unknown as (Omit<PdfItem,'quantity'>&{default_image_url:string|null;spec_sheet_url:string|null;install_manual_url:string|null})[];
 if(candidates.some(c=>!products.some(p=>p.id===c.library_item_id)))return NextResponse.json({error:'A candidate product is unavailable; reload before exporting'},{status:409});
 const rooms=await fetchItemRoomsMap(db,id,items.map(i=>i.id));
 const realRows=items.map(i=>({...i,rooms:rooms.get(i.id)??[],location:(rooms.get(i.id)??[]).map(r=>r.name).join(' / '),is_candidate:false,preliminary_allocations:undefined}));
 const proposed=candidates.map(c=>{
  const p=products.find(p=>p.id===c.library_item_id)!;
  return {...p,...c,item_code:'Proposed',quantity:null,selected_image_url:p.default_image_url,is_candidate:true,rooms:candidateRooms(c),location:null};
 });
 const categories=parseCategoriesParam(params.get('categories'));
 const selected=resolveLotSchedule([...realRows,...proposed],scope).filter(i=>!categories.length||categories.includes(i.category));
 const pdfItems:PdfItem[]=[];
 const bundleDocs:BundleItemDoc[]=[];
 const includeDocs=params.get('docs')==='1';
 // Filter scope before reading any attachments, avoiding out-of-view documents.
 const realIds=selected.filter(i=>!i.is_candidate).map(i=>i.id);
 const libraryIds=[...new Set(selected.map(i=>i.library_item_id).filter((id):id is string=>!!id))];
 const [filesResult,libraryResult]=includeDocs?await Promise.all([
  realIds.length?db.from('item_files').select('*').in('item_id',realIds).in('kind',['spec_sheet','install_manual']).order('uploaded_at'):Promise.resolve({data:[],error:null}),
  libraryIds.length?db.from('library_product_documents').select('id,library_item_id,kind,storage_path,filename,created_at,label,url,version_note').in('library_item_id',libraryIds).in('kind',['spec_sheet','install_manual']).order('created_at'):Promise.resolve({data:[],error:null}),
 ]):[{data:[],error:null},{data:[],error:null}];
 if(filesResult.error||libraryResult.error)return NextResponse.json({error:'Could not load documents; retry or export without documents'},{status:500});
 const usedPaths=new Set<string>();
 for(const item of selected){
  let image:string|undefined;
  if(item.selected_image_url)try{const fetched=await safeFetch(item.selected_image_url,{maxBytes:10*1024*1024});image=await normalizePdfImage(fetched.bytes)}catch{/* Existing PDF missing-image placeholder remains visible. */}
  if(item.is_candidate){
   const allocations=candidateAllocationsForScope(item.preliminary_allocations,scope);
   // Export one explicitly identified room allocation per row, never a multiplied total.
   if(allocations.length)allocations.forEach((a,index)=>pdfItems.push({...item,id:`${item.id}:allocation:${index}`,resolvedImageUrl:image,rooms:candidateRooms({preliminary_allocations:[a]}),location:`${a.room}${a.lot_key?` / ${projectLots(project.settings).find(l=>l.key===a.lot_key)?.label??a.lot_key}`:''}`,quantity:null,displayNote:scheduleProductNote(a.note)??undefined,quantityLabel:`${a.quantity===null?'QTY TBC':`${a.quantity} ${a.unit}`}\n${a.lot_basis==='per_lot'?'per lot':a.lot_basis==='project_total'?'project total':'basis TBC'}\nPROPOSED / PRELIMINARY`}));
   else pdfItems.push({...item,rooms:[],location:'Room TBC',resolvedImageUrl:image,quantity:null,quantityLabel:'QTY TBC\nPROPOSED / PRELIMINARY'});
  }else pdfItems.push({...item,resolvedImageUrl:image});
  if(includeDocs){
   const files:ItemFile[]=[];const unavailableNotes:string[]=[];
   for(const f of (filesResult.data??[]) as ItemFile[])if(f.item_id===item.id&&!usedPaths.has(f.storage_path)){files.push(f);usedPaths.add(f.storage_path)}
   for(const d of libraryResult.data??[])if(d.library_item_id===item.library_item_id){
    if(d.storage_path&&!usedPaths.has(d.storage_path)){files.push({id:d.id,item_id:item.id,kind:d.kind,storage_path:d.storage_path,filename:d.filename??d.label,uploaded_at:d.created_at,uploaded_by:null});usedPaths.add(d.storage_path)}
    else if(!d.storage_path)unavailableNotes.push(`${d.kind==='spec_sheet'?'Spec sheet':'Install manual'}: stored PDF unavailable; see product library`);
   }
   const product=products.find(p=>p.id===item.library_item_id);
   for(const [kind,url] of [['spec_sheet',product?.spec_sheet_url],['install_manual',product?.install_manual_url]])if(url&&!(libraryResult.data??[]).some(d=>d.library_item_id===item.library_item_id&&d.kind===kind&&d.storage_path))unavailableNotes.push(`${kind==='spec_sheet'?'Spec sheet':'Install manual'} — source link only; see product library`);
   if(!files.length&&!unavailableNotes.length)unavailableNotes.push('No stored spec sheet or installation manual available');
   bundleDocs.push({itemId:item.id,itemCode:item.item_code,itemName:item.name,files,unavailableNotes});
  }
 }
 try{
  const buffer=await renderToBuffer(SchedulePdf({project,items:pdfItems,categories:(categoryResult.data??[]) as Category[],generatedAt:new Date().toLocaleDateString('en-AU'),grouping:grouping as 'room'|'type',scheduleSubtitle:`${scope==='all'?'All selections':scope==='shared'?'Shared interior':projectLots(project.settings).find(l=>l.key===scope)?.label} · Proposed quantities are preliminary; excluded from totals and orders`}));
  const bytes=includeDocs?await buildDocBundle(db,new Uint8Array(buffer),bundleDocs):new Uint8Array(buffer);
  const filename=`${project.name.replace(/[^a-z0-9]+/gi,'-')}-${scope}-${includeDocs?'Print-Bundle':'Schedule'}.pdf`;
  return new NextResponse(new Uint8Array(bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':`inline; filename="${filename}"`,'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'Could not generate the complete export. Please retry.'},{status:500})}
}
