/** READ ONLY: validate a reviewed export locally. Never contacts a database.
 * Input: JSON with the exact assembleFrozenJob argument structure. Outputs only
 * counts/digests/totals. The full finance payload is never committed to Git.
 */
import {readFile} from 'node:fs/promises';import {createHash,randomUUID} from 'node:crypto';import assert from 'node:assert/strict';
import {assembleFrozenJob} from '../lib/revisions/baseline.ts';import {cloneRevision,revisionEstimate,ownedRows} from '../lib/revisions/model.ts';import {priceRevisionVariation} from '../lib/revisions/variation-pricing.ts';
const [file,pdf]=process.argv.slice(2);if(!file||!pdf)throw Error('Usage: node --experimental-strip-types scripts/verify-job-revision-archive.mjs <reviewed-input.json> <exact-sent.pdf>');
const input=JSON.parse(await readFile(file,'utf8')),bytes=await readFile(pdf);assert.equal(createHash('sha256').update(bytes).digest('hex'),input.sent_pdf.sha256);assert.equal(bytes.length,input.sent_pdf.bytes);
const {frozen,snapshot}=assembleFrozenJob(input),copy=cloneRevision(frozen.payload,randomUUID),restored=JSON.parse(JSON.stringify(copy));
assert.deepEqual(copy,restored);assert.equal(revisionEstimate(copy).wholeJob.combinedIncGst,snapshot.wholeJob.combinedIncGst);assert.equal(priceRevisionVariation(frozen.payload,copy).total_inc_gst,snapshot.wholeJob.combinedIncGst);
const oldIds=new Set(ownedRows(frozen.payload).map(r=>r.id));for(const row of ownedRows(copy)){assert(!oldIds.has(row.id));assert(oldIds.has(row.origin_id));}
console.log(JSON.stringify({verified:true,sections:copy.sections.length,cost_lines:copy.sections.flatMap(s=>s.lines).length,items:copy.items.length,scope_sections:copy.scope.sections.length,scope_lines:copy.scope.sections.flatMap(s=>s.lines).length,total_inc_gst:snapshot.wholeJob.combinedIncGst,sent_pdf_sha256:input.sent_pdf.sha256},null,2));
