import test from 'node:test';import assert from 'node:assert/strict';
import {scheduleProductNote} from './schedule-product-notes.ts';
test('audit data disappears from presentation while product constraints remain and source is unchanged',()=>{
 const raw='Reece reference code 42062. Source: 422108411_HARVARD.pptx; 2026-03-19. Both have drainer and no overflow. Cutout template is not a substitute for a complete installation manual. Installation manual missing/unverified. SHA256 '+ 'a'.repeat(64)+'. Photograph permanently stored in the existing product-image bucket: https://example.test/storage/v1/object/public/item-images/photo.jpg; verified by SHA256 abc.';
 const before=raw;const note=scheduleProductNote(raw)!;
 assert.match(note,/drainer and no overflow/);assert.match(note,/not a substitute/);assert.match(note,/Installation manual missing/);
 for(const hidden of ['SHA256','pptx','storage/v1','reference code','Photograph'])assert.ok(!note.includes(hidden));assert.equal(raw,before);
});
test('ordinary dimensions, installation restrictions and coordination issues survive',()=>{
 const note='Overall sink 900 x 430 mm; no taphole. D07 handing remains unconfirmed. Not installed unless participant requests.';
 assert.equal(scheduleProductNote(note),note);assert.equal(scheduleProductNote(null),null);
});
