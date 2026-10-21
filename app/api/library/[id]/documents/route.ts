import {NextRequest,NextResponse} from 'next/server';
import {createClient} from '@/lib/supabase/server';
export async function GET(_r:NextRequest,{params}:{params:Promise<{id:string}>}){
 const {id}=await params;const db=await createClient();
 if(!(await db.auth.getUser()).data.user)return NextResponse.json({error:'Unauthorized'},{status:401});
 const {data,error}=await db.from('library_product_documents').select('*').eq('library_item_id',id).order('created_at',{ascending:false});
 return error?NextResponse.json({error:'Could not load documentation'},{status:500}):NextResponse.json({documents:data});
}
export async function POST(r:NextRequest,{params}:{params:Promise<{id:string}>}){
 const {id}=await params;const db=await createClient();
 if(!(await db.auth.getUser()).data.user)return NextResponse.json({error:'Unauthorized'},{status:401});
 let b;try{b=await r.json()}catch{return NextResponse.json({error:'Invalid JSON'},{status:400})}
 if(!b||!['spec_sheet','install_manual','technical_drawing'].includes(b.kind)||typeof b.label!=='string'||!b.label.trim()||b.label.length>200||typeof b.url!=='string'||(b.version_note!=null&&(typeof b.version_note!=='string'||b.version_note.length>500)))return NextResponse.json({error:'Choose a document type, label and HTTPS source URL'},{status:400});
 try{if(new URL(b.url).protocol!=='https:')throw Error()}catch{return NextResponse.json({error:'Document URL must use HTTPS'},{status:400})}
 const {data,error}=await db.from('library_product_documents').insert({library_item_id:id,kind:b.kind,label:b.label.trim(),url:b.url.trim(),version_note:b.version_note?.trim()||null}).select().single();
 return error?NextResponse.json({error:error.code==='23505'?'This document is already attached':'Could not save documentation'},{status:400}):NextResponse.json({document:data},{status:201});
}
