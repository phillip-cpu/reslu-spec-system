import {createHash} from 'node:crypto';
import {sniffFileKind} from './file-sniff.ts';
export const MAX_LIBRARY_DOCUMENT_BYTES=25*1024*1024;
export const DOCUMENT_MIMES:Record<string,string>={pdf:'application/pdf',jpeg:'image/jpeg',png:'image/png',webp:'image/webp'};
export function validateDocumentMetadata(b:Record<string,unknown>):string|null {
 if(!['spec_sheet','install_manual','technical_drawing','cutout_template'].includes(String(b.kind)))return 'Choose a document type';
 if(typeof b.label!=='string'||!b.label.trim()||b.label.length>200)return 'Document label is required (200 characters maximum)';
 if(typeof b.url!=='string')return 'Verified source URL is required';
 try{if(new URL(b.url).protocol!=='https:')return 'Source URL must use HTTPS'}catch{return 'Invalid source URL'}
 if(typeof b.filename!=='string'||!b.filename.trim()||b.filename.length>240)return 'Filename is required';
 if(typeof b.size_bytes!=='number'||!Number.isInteger(b.size_bytes)||b.size_bytes<=0||b.size_bytes>MAX_LIBRARY_DOCUMENT_BYTES)return 'Document must be between 1 byte and 25 MiB';
 if(!Object.values(DOCUMENT_MIMES).includes(String(b.mime_type)))return 'Use PDF, JPEG, PNG or WebP';
 if(typeof b.sha256!=='string'||!/^[a-f0-9]{64}$/.test(b.sha256))return 'A SHA-256 content hash is required';
 if(b.version_note!=null&&(typeof b.version_note!=='string'||b.version_note.length>500))return 'Revision note is too long';
 if(b.verified_on!=null&&(typeof b.verified_on!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(b.verified_on)))return 'Invalid verification date';
 return null;
}
export function verifyDocumentBytes(bytes:Buffer,expected:{size_bytes:number;mime_type:string;sha256:string}):string|null {
 if(bytes.length!==expected.size_bytes||bytes.length>MAX_LIBRARY_DOCUMENT_BYTES)return 'Uploaded size does not match';
 if(DOCUMENT_MIMES[sniffFileKind(bytes)]!==expected.mime_type)return 'File content does not match document type';
 if(createHash('sha256').update(bytes).digest('hex')!==expected.sha256)return 'Uploaded SHA-256 does not match';
 return null;
}
export function isProductDocumentPath(productId:string,path:unknown):path is string {
 if(typeof path!=='string')return false;
 const prefix=`library/${productId}/documents/`;
 return path.startsWith(prefix)&&/^[a-f0-9-]{36}-[a-z0-9.-]+$/.test(path.slice(prefix.length));
}
