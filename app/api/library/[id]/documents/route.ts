import {NextRequest,NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import {createClient} from '@/lib/supabase/server';
import {ASSET_BUCKET,slugFilename} from '@/lib/storage';
import {validateDocumentMetadata,verifyDocumentBytes,isProductDocumentPath} from '@/lib/library-document-upload';
export const runtime='nodejs';
export async function GET(_r:NextRequest,{params}:{params:Promise<{id:string}>}){
 const {id}=await params;const db=await createClient();
 if(!(await db.auth.getUser()).data.user)return NextResponse.json({error:'Unauthorized'},{status:401});
 const {data,error}=await db.from('library_product_documents').select('*').eq('library_item_id',id).order('created_at',{ascending:false});
 return error?NextResponse.json({error:'Could not load documentation'},{status:500}):NextResponse.json({documents:(data??[]).map(d=>({...d,download_url:d.storage_path?`/api/library/${id}/documents/${d.id}`:null}))});
}
/** Two-phase direct-to-private-storage upload avoids Vercel's request body limit. */
export async function POST(r:NextRequest,{params}:{params:Promise<{id:string}>}){
 const {id}=await params;const db=await createClient();
 if(!(await db.auth.getUser()).data.user)return NextResponse.json({error:'Unauthorized'},{status:401});
 const {data:product}=await db.from('library_items').select('id').eq('id',id).single();
 if(!product)return NextResponse.json({error:'Library product not found'},{status:404});
 const b=await r.json().catch(()=>null);
 if(!b||typeof b!=='object')return NextResponse.json({error:'Invalid JSON'},{status:400});
 const validation=validateDocumentMetadata(b);
 if(validation)return NextResponse.json({error:validation},{status:400});
 const {data:existing,error:lookupError}=await db.from('library_product_documents').select('id').eq('library_item_id',id).eq('kind',b.kind).eq('sha256',b.sha256).maybeSingle();
 if(lookupError)return NextResponse.json({error:'Could not check existing documentation'},{status:500});
 if(existing)return NextResponse.json({document:existing,duplicate:true});
 if(b.action==='prepare'){
  const path=`library/${id}/documents/${randomUUID()}-${slugFilename(b.filename)}`;
  const {data,error}=await db.storage.from(ASSET_BUCKET).createSignedUploadUrl(path);
  return error?NextResponse.json({error:'Could not prepare private upload'},{status:500}):NextResponse.json({path,token:data.token});
 }
 if(b.action!=='finalize'||!isProductDocumentPath(id,b.storage_path))return NextResponse.json({error:'Invalid upload action or product path'},{status:400});
 // A finalization retry returns the existing hash above; it never overwrites a revision.
 const {data:linkedDocument,error:linkedError}=await db.from('library_product_documents').select('id,sha256').eq('storage_path',b.storage_path).maybeSingle();
 if(linkedError)return NextResponse.json({error:'Could not check upload state'},{status:500});
 if(linkedDocument)return linkedDocument.sha256===b.sha256?NextResponse.json({document:linkedDocument,duplicate:true}):NextResponse.json({error:'Stored revisions cannot be replaced'},{status:409});
 const {data:file,error:downloadError}=await db.storage.from(ASSET_BUCKET).download(b.storage_path);
 if(downloadError||!file)return NextResponse.json({error:'Uploaded file is not available'},{status:400});
 const bytes=Buffer.from(await file.arrayBuffer());
 const mismatch=verifyDocumentBytes(bytes,b);
 if(mismatch)return NextResponse.json({error:mismatch},{status:400});
 const {data,error}=await db.from('library_product_documents').insert({library_item_id:id,kind:b.kind,label:b.label.trim(),url:b.url.trim(),version_note:b.version_note?.trim()||null,storage_path:b.storage_path,filename:b.filename,mime_type:b.mime_type,size_bytes:bytes.length,sha256:b.sha256,verified_on:b.verified_on||null,verification:b.verification&&typeof b.verification==='object'?b.verification:{}}).select().single();
 if(error){
  // Preserve uploaded bytes after an uncertain metadata write; retries are hash-idempotent.
  return NextResponse.json({error:'Could not save attachment metadata. Retry to check whether it completed.'},{status:409});
 }
 return NextResponse.json({document:data},{status:201});
}
