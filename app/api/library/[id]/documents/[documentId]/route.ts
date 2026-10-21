import {NextRequest,NextResponse} from 'next/server';
import {createClient} from '@/lib/supabase/server';
import {ASSET_BUCKET,SIGNED_URL_TTL_SECONDS} from '@/lib/storage';
export async function GET(_r:NextRequest,{params}:{params:Promise<{id:string;documentId:string}>}){
 const {id,documentId}=await params;const db=await createClient();
 if(!(await db.auth.getUser()).data.user)return NextResponse.json({error:'Unauthorized'},{status:401});
 const {data:doc}=await db.from('library_product_documents').select('storage_path').eq('id',documentId).eq('library_item_id',id).single();
 if(!doc?.storage_path)return NextResponse.json({error:'Stored document not found'},{status:404});
 const {data,error}=await db.storage.from(ASSET_BUCKET).createSignedUrl(doc.storage_path,SIGNED_URL_TTL_SECONDS);
 return error?NextResponse.json({error:'Could not open stored document'},{status:500}):NextResponse.redirect(data.signedUrl);
}
