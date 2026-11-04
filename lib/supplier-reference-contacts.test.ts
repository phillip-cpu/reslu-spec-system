import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleContactEmail} from './supplier-reference-contacts.ts';

test('a linked contact without email does not inherit a different supplier email', () => {
  assert.equal(scheduleContactEmail({email:null},null,'another-person@other-company.example'),null);
  assert.equal(scheduleContactEmail({email:''},null,'another-person@other-company.example'),'');
});
test('explicit, source-package and unassigned supplier emails retain their attribution', () => {
  assert.equal(scheduleContactEmail({email:'linked@example.com'},{email:'reference@example.com'},'supplier@example.com'),'linked@example.com');
  assert.equal(scheduleContactEmail(null,{email:'reference@example.com'},'supplier@example.com'),'reference@example.com');
  assert.equal(scheduleContactEmail(null,null,'supplier@example.com'),'supplier@example.com');
  assert.equal(scheduleContactEmail(null,null,null),null);
});
