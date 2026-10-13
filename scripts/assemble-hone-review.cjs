// Preserve the source archive. Copy its PDF pages unchanged; no overlays, redactions or header edits.
const fs=require('fs'),crypto=require('crypto'),assert=require('assert/strict'),{PDFDocument}=require('pdf-lib');
(async()=>{
 const data=JSON.parse(fs.readFileSync('../evidence/hone-proposal-pages.json','utf8'));const ref=data.scope_reference;assert.equal(ref.merge_ready,true,"Corrected V2 path/hash must be verified before merging");
 const source=fs.readFileSync(ref.local_archive_path);const hash=b=>crypto.createHash('sha256').update(b).digest('hex');assert.equal(hash(source),ref.local_archive_sha256);
 const proposal=await PDFDocument.load(fs.readFileSync('../evidence/hone-proposal-pages.pdf'));const scope=await PDFDocument.load(source);assert.equal(proposal.getPageCount(),3);assert.equal(scope.getPageCount(),25);
 const merged=await PDFDocument.create();for(const doc of [proposal,scope])for(const page of await merged.copyPages(doc,doc.getPageIndices()))merged.addPage(page);
 merged.setTitle('Hone — Construction Proposal and attached Scope of Works Version 2');assert.equal(merged.getPageCount(),28);
 const output='../evidence/hone-combined-single-total-v2-review.pdf';const bytes=await merged.save();fs.writeFileSync(output,bytes);assert.equal(hash(fs.readFileSync(ref.local_archive_path)),ref.local_archive_sha256);
 const manifest={output,pages:28,proposal_pages:[1,3],scope_pages:[4,28],scope_source:ref.local_archive_path,scope_sha256:ref.local_archive_sha256,combined_sha256:hash(bytes),native_scope_status:'unissued Draft T1',reviewer_pages_included:false};fs.writeFileSync('../evidence/hone-combined-single-total-v2-manifest.json',JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
