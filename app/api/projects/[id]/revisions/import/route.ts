import { NextRequest, NextResponse } from 'next/server';
import { revisionAccess } from '@/lib/revisions/access';
import { importReviews } from '@/lib/revisions/import-reviews';
import { digestBytes, MAX_IMPORT_BYTES, prepareReviewedImport } from '@/lib/revisions/import';
import { ASSET_BUCKET } from '@/lib/storage';

const headers={'Cache-Control':'private, no-store'};
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}) {
  const access=await revisionAccess();if(access.error)return access.error;
  // Cookie-authenticated mutation: reject cross-origin form submission.
  if(req.headers.get('origin')!==req.nextUrl.origin)return NextResponse.json({error:'Same-origin session required.'},{status:403,headers});
  const {id}=await params,review=importReviews[id];
  if(!review)return NextResponse.json({error:'No reviewed baseline import is available for this project.'},{status:404,headers});
  if(Number(req.headers.get('content-length')??0)>MAX_IMPORT_BYTES+16384)return NextResponse.json({error:'Archive is too large.'},{status:413,headers});
  try {
    const form=await req.formData(),file=form.get('archive'),mode=form.get('mode');
    if(!(file instanceof File)||file.size>MAX_IMPORT_BYTES||!['preview','commit'].includes(String(mode)))return NextResponse.json({error:'Select the reviewed JSON archive.'},{status:400,headers});
    const prepared=prepareReviewedImport(new Uint8Array(await file.arrayBuffer()),review);
    if(!review.pdf.storage_path.startsWith(`projects/${id}/files/`))throw Error('Original PDF project mismatch.');
    const {data:pdf,error:pdfError}=await access.db.storage.from(ASSET_BUCKET).download(review.pdf.storage_path);
    if(pdfError||!pdf)return NextResponse.json({error:'The original private PDF is unavailable. Nothing imported.'},{status:409,headers});
    const pdfBytes=new Uint8Array(await pdf.arrayBuffer());
    if(pdfBytes.length!==review.pdf.bytes||digestBytes(pdfBytes)!==review.pdf.sha256)return NextResponse.json({error:'Original PDF checksum mismatch. Nothing imported.'},{status:409,headers});
    if(mode==='preview')return NextResponse.json({summary:prepared.summary},{headers});
    // This pins confirmation to the previewed bytes; it conveys no authority itself.
    if(form.get('confirmed_archive_sha256')!==review.archiveSha256)return NextResponse.json({error:'Review the selected archive before importing.'},{status:400,headers});
    // The existing user-scoped client carries the real verified session. No service
    // client, claims override, selected actor ID, SQL execution or gate mutation.
    const {data,error}=await access.db.rpc('freeze_reviewed_job_revision',{project:id,label:review.label,
      snapshot:prepared.snapshot,frozen:prepared.frozen,expected_hash:review.frozenHash});
    if(error)return NextResponse.json({error:'Import stopped: release unavailable, source changed, or baseline conflict. Reload and review; nothing was overwritten.'},{status:409,headers});
    if(!data?.id||data.frozen_job_hash!==review.frozenHash)return NextResponse.json({error:'Import response could not be verified. Reload revisions before retrying.'},{status:502,headers});
    return NextResponse.json({version:{id:data.id,label:data.label,frozen_job_hash:data.frozen_job_hash},summary:prepared.summary},{headers});
  } catch {
    return NextResponse.json({error:'The archive is invalid or does not match the reviewed baseline. Nothing imported.'},{status:400,headers});
  }
}
