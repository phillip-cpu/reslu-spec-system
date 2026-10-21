import { NextRequest,NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {randomUUID} from 'node:crypto';
import { projectLots,projectCandidates,withProjectCandidates,patchCandidate } from '@/lib/builder-workspaces';
export async function PATCH(r:NextRequest,{params}:{params:Promise<{id:string}>}) {
 const {id}=await params; const db=await createClient();
 if (!(await db.auth.getUser()).data.user) return NextResponse.json({error:'Unauthorized'},{status:401});
 const {data:project}=await db.from('projects').select('id,builder_id,settings,updated_at').eq('id',id).is('deleted_at',null).single();
 if (!project?.builder_id) return NextResponse.json({error:'Builder project not found'},{status:404});
 let b;try{b=await r.json()}catch{return NextResponse.json({error:'Invalid JSON'},{status:400})}
 if (!b || typeof b.item_id!=='string' || (b.selection_scope!==undefined && !['shared','shared_internal',...projectLots(project.settings).map(l=>l.key)].includes(b.selection_scope)) || (b.selection_key!=null && (typeof b.selection_key!=='string'||b.selection_key.trim().length>120))) return NextResponse.json({error:'Invalid item, lot or selection slot'},{status:400});
 if(b.is_candidate===true){
  const candidates=projectCandidates(project.settings);
  if(!candidates.some(c=>c.id===b.item_id))return NextResponse.json({error:'Candidate not found on this project'},{status:404});
  let next;
  try {next=candidates.map(c=>c.id===b.item_id?patchCandidate(c,b):c);
   const updated=next.find(c=>c.id===b.item_id)!;
   if(updated.preliminary_allocations?.some(a=>a.lot_key && (!projectLots(project.settings).some(l=>l.key===a.lot_key) || (!['shared','shared_internal'].includes(updated.selection_scope) && a.lot_key!==updated.selection_scope))))throw new Error('Allocation lot must exist and match the selection scope');
  } catch(e) {return NextResponse.json({error:e instanceof Error?e.message:'Invalid allocations'},{status:400})}
  const {data,error}=await db.from('projects').update({settings:withProjectCandidates(project.settings,next)}).eq('id',id).eq('updated_at',project.updated_at).select('id').single();
  return error?NextResponse.json({error:'Project changed. Reload and retry.'},{status:409}):NextResponse.json({project:data});
 }
 if(b.preliminary_allocations!==undefined || b.selection_scope===undefined || b.selection_scope==='shared_internal')return NextResponse.json({error:'Preliminary allocations are only supported on candidates; item scope is required'},{status:400});
 const {data,error}=await db.from('items').update({selection_scope:b.selection_scope,selection_key:b.selection_key?.trim()||null}).eq('id',b.item_id).eq('project_id',id).is('deleted_at',null).select('id,selection_scope,selection_key').single();
 return error?NextResponse.json({error:'Could not update schedule item'},{status:400}):NextResponse.json({item:data});
}
/** Library-first association. Creates an unconfirmed candidate, never a costable item or approval. */
export async function POST(r:NextRequest,{params}:{params:Promise<{id:string}>}) {
 const {id}=await params;const db=await createClient();const user=(await db.auth.getUser()).data.user;
 if(!user)return NextResponse.json({error:'Unauthorized'},{status:401});
 const {data:project}=await db.from('projects').select('id,builder_id,settings,updated_at').eq('id',id).is('deleted_at',null).single();
 if(!project?.builder_id)return NextResponse.json({error:'Builder project not found'},{status:404});
 let b;try{b=await r.json()}catch{return NextResponse.json({error:'Invalid JSON'},{status:400})}
 if(!b||typeof b.library_item_id!=='string')return NextResponse.json({error:'Choose a shared library product first'},{status:400});
 const {data:existing,error:lookupError}=await db.from('items').select('id').eq('project_id',id).eq('library_item_id',b.library_item_id).is('deleted_at',null).limit(1);
 if(lookupError)return NextResponse.json({error:'Could not check existing selections'},{status:500});
 if(existing?.length)return NextResponse.json({error:'This library product is already on this job. Organise its scope in the schedule.'},{status:409});
 const {data:product}=await db.from('library_items').select('id').eq('id',b.library_item_id).single();
 if(!product)return NextResponse.json({error:'Library product not found'},{status:404});
 const candidates=projectCandidates(project.settings);
 if(candidates.some(c=>c.library_item_id===product.id))return NextResponse.json({error:'This product is already a candidate for this job'},{status:409});
 const candidate={id:randomUUID(),library_item_id:product.id,selection_scope:'shared',selection_key:null};
 const {error}=await db.from('projects').update({settings:withProjectCandidates(project.settings,[...candidates,candidate])}).eq('id',id).eq('updated_at',project.updated_at).select('id').single();
 return error?NextResponse.json({error:'Project changed. Reload and retry.'},{status:409}):NextResponse.json({candidate,quantity_state:'unconfirmed',excluded_from_totals_and_procurement:true},{status:201});
}
