import { NextRequest,NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { projectLots } from '@/lib/builder-workspaces';
export async function PATCH(r:NextRequest,{params}:{params:Promise<{id:string}>}) {
 const {id}=await params; const db=await createClient();
 if (!(await db.auth.getUser()).data.user) return NextResponse.json({error:'Unauthorized'},{status:401});
 const {data:project}=await db.from('projects').select('id,builder_id,settings').eq('id',id).is('deleted_at',null).single();
 if (!project?.builder_id) return NextResponse.json({error:'Builder project not found'},{status:404});
 let b;try{b=await r.json()}catch{return NextResponse.json({error:'Invalid JSON'},{status:400})}
 if (!b || typeof b.item_id!=='string' || !['shared',...projectLots(project.settings).map(l=>l.key)].includes(b.selection_scope) || (b.selection_key!=null && (typeof b.selection_key!=='string'||b.selection_key.trim().length>120))) return NextResponse.json({error:'Invalid item, lot or selection slot'},{status:400});
 const table=b.is_candidate===true?'project_library_candidates':'items';
 let update=db.from(table).update({selection_scope:b.selection_scope,selection_key:b.selection_key?.trim()||null}).eq('id',b.item_id).eq('project_id',id);
 if(table==='items')update=update.is('deleted_at',null);
 const {data,error}=await update.select('id,selection_scope,selection_key').single();
 return error ? NextResponse.json({error:'Could not update schedule item'},{status:400}) : NextResponse.json({item:data});
}
/** Library-first association. Creates an unconfirmed candidate, never a costable item or approval. */
export async function POST(r:NextRequest,{params}:{params:Promise<{id:string}>}) {
 const {id}=await params;const db=await createClient();const user=(await db.auth.getUser()).data.user;
 if(!user)return NextResponse.json({error:'Unauthorized'},{status:401});
 const {data:project}=await db.from('projects').select('id,builder_id').eq('id',id).is('deleted_at',null).single();
 if(!project?.builder_id)return NextResponse.json({error:'Builder project not found'},{status:404});
 let b;try{b=await r.json()}catch{return NextResponse.json({error:'Invalid JSON'},{status:400})}
 if(!b||typeof b.library_item_id!=='string')return NextResponse.json({error:'Choose a shared library product first'},{status:400});
 const {data:existing,error:lookupError}=await db.from('items').select('id').eq('project_id',id).eq('library_item_id',b.library_item_id).is('deleted_at',null).limit(1);
 if(lookupError)return NextResponse.json({error:'Could not check existing selections'},{status:500});
 if(existing?.length)return NextResponse.json({error:'This library product is already on this job. Organise its scope in the schedule.'},{status:409});
 const {data:product}=await db.from('library_items').select('id').eq('id',b.library_item_id).single();
 if(!product)return NextResponse.json({error:'Library product not found'},{status:404});
 const {data,error}=await db.from('project_library_candidates').insert({project_id:id,library_item_id:product.id,selection_scope:'shared'}).select('id,library_item_id').single();
 return error?NextResponse.json({error:error.code==='23505'?'This library product is already a candidate for this job':'Could not associate library product'},{status:409}):NextResponse.json({candidate:data,quantity_state:'unconfirmed',excluded_from_totals_and_procurement:true},{status:201});
}
