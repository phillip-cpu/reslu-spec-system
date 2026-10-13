import { createHash } from 'node:crypto';
import { assembleFrozenJob } from './baseline';
import { paymentValidation } from './model';
import type { ImportReview } from './import-reviews';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const digestBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function prepareReviewedImport(bytes: Uint8Array, review: ImportReview) {
  if(bytes.length !== review.archiveBytes || bytes.length > MAX_IMPORT_BYTES || digestBytes(bytes) !== review.archiveSha256)
    throw new Error('The archive does not match the reviewed file. Select the original reviewed JSON archive.');
  const input = JSON.parse(new TextDecoder().decode(bytes)) as Parameters<typeof assembleFrozenJob>[0];
  if(input.project?.id !== review.projectId || input.source_manifest_sha256 !== review.manifestHash ||
    input.sent_pdf?.sha256 !== review.pdf.sha256 || input.sent_pdf?.bytes !== review.pdf.bytes)
    throw new Error('The reviewed project, source manifest or original PDF does not match.');
  // The stored original is fixed by the reviewed release, never a client-supplied URL.
  input.sent_pdf = {...input.sent_pdf, storage_path:review.pdf.storage_path};
  const prepared = assembleFrozenJob(input);
  if(prepared.snapshot.wholeJob.combinedIncGst !== review.totalIncGst) throw new Error('The reviewed total changed.');
  const p=prepared.frozen.payload;
  return {...prepared,summary:{label:review.label,totalIncGst:review.totalIncGst,sections:p.sections.length,
    costLines:p.sections.flatMap(s=>s.lines).length,items:p.items.length,scopeSections:p.scope.sections.length,
    scopeLines:p.scope.sections.flatMap(s=>s.lines).length,paymentPercent:paymentValidation(p).total,
    pdfSha256:review.pdf.sha256,archiveSha256:review.archiveSha256}};
}
