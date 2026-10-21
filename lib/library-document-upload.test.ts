import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateDocumentMetadata,verifyDocumentBytes,isProductDocumentPath} from './library-document-upload.ts';
const bytes=Buffer.from('%PDF-1.7\nverified binary fixture');
const valid={kind:'install_manual',label:'Exact product manual',url:'https://manufacturer.example/manual.pdf',filename:'manual.pdf',size_bytes:bytes.length,mime_type:'application/pdf',sha256:createHash('sha256').update(bytes).digest('hex')};
test('stored content verifies actual bytes, size, MIME and digest, rejecting altered revisions',()=>{
 assert.equal(validateDocumentMetadata(valid),null);
 assert.equal(verifyDocumentBytes(bytes,valid),null);
 assert.match(verifyDocumentBytes(Buffer.from('%PDF-1.7\nmodified binary fixture'),valid)??'',/size|SHA-256/);
 assert.match(verifyDocumentBytes(bytes,{...valid,mime_type:'image/jpeg'})??'',/type/);
 assert.match(verifyDocumentBytes(bytes,{...valid,sha256:'0'.repeat(64)})??'',/SHA-256/);
});
test('large real manuals are supported without allowing empty/oversize files or unsafe sources',()=>{
 assert.equal(validateDocumentMetadata({...valid,size_bytes:6715246}),null);
 assert.match(validateDocumentMetadata({...valid,size_bytes:0})??'',/25 MiB/);
 assert.match(validateDocumentMetadata({...valid,size_bytes:30*1024*1024})??'',/25 MiB/);
 assert.match(validateDocumentMetadata({...valid,url:'javascript:alert(1)'})??'',/HTTPS/);
 assert.match(validateDocumentMetadata({...valid,mime_type:'text/html'})??'',/PDF/);
});
test('finalization is restricted to this canonical product and a generated document path',()=>{
 const product='12345678-1234-1234-1234-123456789abc';
 const path=`library/${product}/documents/abcdefab-1234-1234-1234-abcdefabcdef-manual.pdf`;
 assert.equal(isProductDocumentPath(product,path),true);
 assert.equal(isProductDocumentPath('another-product',path),false);
 assert.equal(isProductDocumentPath(product,`library/${product}/documents/../../invoice.pdf`),false);
});
