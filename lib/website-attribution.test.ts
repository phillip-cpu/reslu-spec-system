import test from 'node:test';
import assert from 'node:assert/strict';
import { websiteAttribution } from './website-attribution.ts';
test('retains alternate click IDs, search term, touch and distinct selected spaces', () => {
  assert.deepEqual(websiteAttribution({gbraid:'abc',wbraid:'def',utm_term:'home extension',attribution_landing_page:'/begin/extensions?utm_source=google',attribution_captured_at:'2026-09-08T00:00:00Z',rooms:['Extension','Kitchen','Extension']}),{gbraid:'abc',wbraid:'def',utm_term:'home extension',attribution_landing_page:'/begin/extensions',attribution_captured_at:'2026-09-08T00:00:00.000Z',rooms:['Extension','Kitchen']});
});
test('legacy callers remain valid with absent new fields', () => {
  assert.deepEqual(websiteAttribution({}),{gbraid:null,wbraid:null,utm_term:null,attribution_landing_page:null,attribution_captured_at:null,rooms:[]});
});
test('rejects malformed values and bounds stored user input', () => {
  const value=websiteAttribution({gbraid:{secret:'bad'},wbraid:'x'.repeat(300),utm_term:['wrong'],attribution_landing_page:'//example.test',attribution_captured_at:'invalid',rooms:[false,{},' Kitchen ',...Array(20).fill('Study')]});
  assert.equal(value.gbraid,null); assert.equal(value.wbraid?.length,200); assert.equal(value.utm_term,null); assert.equal(value.attribution_landing_page,null); assert.equal(value.attribution_captured_at,null); assert.deepEqual(value.rooms,['Kitchen','Study']);
});
