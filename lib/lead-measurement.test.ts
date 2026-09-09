import test from 'node:test';
import assert from 'node:assert/strict';
import { measurementSummary, outcomeSummary, reviewedStatus, adelaideDate, sourceEvidence, type MeasurementLead, type ReviewStatus } from './lead-measurement.ts';

function lead(id: string, status?: ReviewStatus, duplicate_of: string | null = null): MeasurementLead {
  return { id, first_name: null, surname_project: 'Example', email: null, received_at: null, created_at: '2026-08-13T11:00:00Z', deleted_at: null, stage: 'Potential Lead', page: '/begin', gclid: null, utm_source: null, utm_medium: null, lead_measurement_reviews: status ? [{ id: 1, status, duplicate_of, reason: 'Reviewed evidence', reviewed_at: '2026-09-07T00:00:00Z' }] : [] };
}

test('counts seven receipts as two reviewed enquiries without deleting the evidence', () => {
  const rows = [lead('a','genuine'), lead('b','duplicate','a'), lead('c','genuine'), lead('d','test'), lead('e','test'), lead('f','test'), lead('g','spam')];
  rows[3].deleted_at = '2026-09-01T00:00:00Z';
  assert.deepEqual(measurementSummary(rows), {raw:7,genuine:2,qualified:0,unreviewed:0,test:3,spam:1,duplicate:1});
});
test('new receipts are unreviewed; source absence is not organic or direct', () => {
  assert.equal(measurementSummary([lead('a')]).unreviewed, 1);
  assert.equal(sourceEvidence(lead('a')), 'Source not recorded');
});
test('qualification is an explicit subset of genuine enquiries', () => {
  const row = lead('a', 'qualified');
  assert.equal(measurementSummary([row]).genuine, 1);
  assert.equal(measurementSummary([row]).qualified, 1);
});
test('a repeat with an original outside the date range is still a repeat', () => {
  const original = lead('a','genuine'), repeat = lead('b','duplicate','a');
  assert.equal(measurementSummary([repeat], [original,repeat]).duplicate, 1);
});
test('latest review wins and invalid repeat chains need review', () => {
  const original = lead('a','genuine'), repeat = lead('b','duplicate','a');
  original.lead_measurement_reviews.push({id:2,status:'spam',duplicate_of:null,reason:'Corrected review',reviewed_at:'2026-09-07T00:01:00Z'});
  assert.equal(reviewedStatus(repeat,[original,repeat]), 'unreviewed');
  assert.equal(reviewedStatus(lead('x','duplicate','x'),[]), 'unreviewed');
});
test('Adelaide dates account for standard and daylight saving time', () => {
  assert.equal(adelaideDate('2026-09-07T14:29:59Z'), '2026-09-07');
  assert.equal(adelaideDate('2026-09-07T14:30:00Z'), '2026-09-08');
  assert.equal(adelaideDate('2026-12-07T13:30:00Z'), '2026-12-08');
});

test('outcomes exclude unreviewed and test records and count each project once', () => {
  const rows = ['genuine', 'qualified', 'test', 'unreviewed'].map((status, i) => ({
    ...lead(String(i), status as ReviewStatus), project_id: i < 2 ? 'one' : String(i),
    site_visit_date: '2026-09-09T01:00:00Z', contract_recorded_signed: true,
  }));
  assert.deepEqual(outcomeSummary(rows), {reviewed:2,visits:2,projects:1,recordedSigned:1});
});
test('a completed stage does not invent a signed contract or project link', () => {
  const row = {...lead('a','genuine'), stage:'Complete'};
  assert.deepEqual(outcomeSummary([row]), {reviewed:1,visits:0,projects:0,recordedSigned:0});
});
