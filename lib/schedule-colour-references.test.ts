import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleColourReference} from './schedule-colour-references.ts';

const roofId='23303bed-85a1-46a8-a732-c92135ca32f9';
const accessoryIds=['8621dd28-0a6d-464d-8b68-e2d5a2cb12d4','59703871-a632-4ebf-88b7-248ac4c1433c','806c6447-7886-4eff-b69c-2024a6a4729f'];

test('the existing roof identity uses Surfmist and accessories use Gully without mutating selections', () => {
  for (const [id,colour,hex,source] of [[roofId,'Surfmist','#E4E2D5','https://colorbond.com/colours/surfmist'],...accessoryIds.map(id=>[id,'Gully','#857E73','https://colorbond.com/colours/gully'])]) {
    const input = {id,brand:'COLORBOND',colour};
    const before = {...input};
    const reference=scheduleColourReference(input);
    assert.equal(reference?.hex,hex);
    assert.equal(reference?.source,source);
    assert.equal(reference?.company,'BlueScope / COLORBOND');
    assert.deepEqual(input,before);
    assert.ok(reference && !('finish' in reference) && !('client_approved' in reference));
    assert.equal(scheduleColourReference({...input,colour:'Jasper'}),null);
  }
});
test('roof and accessory references do not bleed across identities or changed selections', () => {
  assert.equal(scheduleColourReference({id:roofId,brand:'COLORBOND',colour:'Gully'}),null);
  for(const id of accessoryIds) assert.equal(scheduleColourReference({id,brand:'COLORBOND',colour:'Surfmist'}),null);
  assert.equal(scheduleColourReference({id:'job-roof',library_item_id:roofId,brand:'COLORBOND',colour:'Surfmist'})?.hex,'#E4E2D5');
  assert.equal(scheduleColourReference({id:roofId,brand:'Other',colour:'Surfmist'}),null);
});
test('Natural Grain stays unchanged for candidates and linked job items', () => {
  const library_item_id='0ea76bcd-4db7-4b0c-8004-b1f0757c6563';
  assert.equal(scheduleColourReference({id:'job-item',library_item_id,brand:'Dulux',colour:'Natural Grain'})?.hex,'#D6CDC2');
  assert.equal(scheduleColourReference({id:library_item_id,brand:'Dulux',colour:'Natural Green'}),null);
  assert.equal(scheduleColourReference({id:library_item_id,brand:'Other',colour:'Natural Grain'}),null);
  assert.equal(scheduleColourReference({id:'unrelated',brand:'Dulux',colour:'Natural Grain'}),null);
});
