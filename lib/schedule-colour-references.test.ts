import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleColourReference} from './schedule-colour-references.ts';

test('the four existing Jasper identities use the verified Classic colour reference only', () => {
  for (const id of ['23303bed-85a1-46a8-a732-c92135ca32f9','8621dd28-0a6d-464d-8b68-e2d5a2cb12d4','59703871-a632-4ebf-88b7-248ac4c1433c','806c6447-7886-4eff-b69c-2024a6a4729f']) {
    const input = {id, brand:'COLORBOND', colour:'Jasper'};
    const before = {...input};
    const reference = scheduleColourReference(input);
    assert.equal(reference?.hex, '#6C6153');
    assert.equal(reference?.company, 'BlueScope / COLORBOND');
    assert.deepEqual(input, before);
    assert.equal(scheduleColourReference({...input,colour:'Monument'}), null);
  }
});
test('Natural Grain follows canonical identity for candidates and linked job items', () => {
  const library_item_id='0ea76bcd-4db7-4b0c-8004-b1f0757c6563';
  assert.equal(scheduleColourReference({id:'job-item',library_item_id,brand:'Dulux',colour:'Natural Grain'})?.hex,'#D6CDC2');
  assert.equal(scheduleColourReference({id:library_item_id,brand:'Dulux',colour:'Natural Green'}),null);
  assert.equal(scheduleColourReference({id:library_item_id,brand:'Other',colour:'Natural Grain'}),null);
  assert.equal(scheduleColourReference({id:'unrelated',brand:'Dulux',colour:'Natural Grain'}),null);
});
