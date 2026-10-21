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
 const {data,error}=await db.from('items').update({selection_scope:b.selection_scope,selection_key:b.selection_key?.trim()||null}).eq('id',b.item_id).eq('project_id',id).is('deleted_at',null).select('id,selection_scope,selection_key').single();
 return error ? NextResponse.json({error:'Could not update schedule item'},{status:400}) : NextResponse.json({item:data});
}
/** Library-first association. No job-only products, quantities or approvals inferred. */
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
 const {data:product}=await db.from('library_items').select('id,name,category,description,brand,supplier,supplier_email,colour,material,finish,product_url,default_image_url').eq('id',b.library_item_id).single();
 if(!product)return NextResponse.json({error:'Library product not found'},{status:404});
 const {id:libraryId,default_image_url,...fields}=product;
 const {data,error}=await db.from('items').insert({...fields,project_id:id,library_item_id:libraryId,selected_image_url:default_image_url,quantity:0,application_note:'Quantity to confirm. Zero is an unconfirmed placeholder, not a measured quantity.',selection_scope:'shared',client_approved:false,created_by:user.id,scrape_status:'skipped'}).select('id,library_item_id').single();
 return error?NextResponse.json({error:'Could not associate library product'},{status:400}):NextResponse.json({item:data},{status:201});
}
