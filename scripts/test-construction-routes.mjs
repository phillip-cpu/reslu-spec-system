import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as core from '../lib/construction-proposals.ts';
import * as quotes from '../lib/construction-quotes.ts';
import * as lifecycle from '../lib/construction-lifecycle.ts';
import * as identity from '../lib/construction-proposal-identity.ts';
import * as headings from '../lib/sow-display-headings.ts';
import { fixture } from '../lib/construction-proposals.fixture.ts';
const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require('next/server');
function loadRoute(file, db, role, localEnabled=false) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const mocks = {
    'next/headers': { headers: async () => new Headers() },
    'next/navigation': { notFound: () => { throw new Error('NOT_FOUND'); } },
    '@/lib/supabase/server': { createClient: async () => db, createServiceRoleClient: () => db },
    '@/lib/auth': { getUserRole: async () => role === null ? null : { role, userId: 'synthetic-admin' } },
    '@/lib/construction-proposals': core,
    '@/lib/construction-quotes': quotes,
    '@/lib/sow-display-headings': headings,
    '@/lib/construction-proposal-identity': identity,
    '@/lib/construction-lifecycle': { ...lifecycle, localConstructionLifecycleEnabled: () => localEnabled },
    '@/lib/rate-limit': { rateLimit: () => ({ ok: true }) },
    '@/lib/signatures': { decodePngDataUrl: () => new Uint8Array([1]) },
  };
  new Function('require', 'exports', code)(name => {
    if (mocks[name]) return mocks[name];
    if (name.startsWith('@/')) return new Proxy({}, { get: (_, key) => () => { throw new Error(`Unexpected side effect: ${name}.${String(key)}`); } });
    return require(name);
  }, exports);
  return exports;
}
function database() {
  const f = fixture(); let reads = 0, writes = 0;
  const rows = { estimate_versions: [f.version], sow_documents: [f.sow], sow_sections: f.sections.map(s => ({ ...s, sow_id: f.sow.id, sow_lines: s.lines.map((l, i) => ({ ...l, id: `${s.id}-${i}`, sort: i })) })), proposals: [] };
  const db = { from(table) {
    reads++; let predicates = [], inserting;
    const q = {
      select() { return q; }, eq(k, v) { predicates.push(r => r[k] === v); return q; }, is(k, v) { predicates.push(r => (r[k] ?? null) === v); return q; }, order() { return q; },
      insert(value) { inserting = value; return q; },
      update() { throw new Error('Unexpected mutation'); },
      async single() { return run(true); }, async maybeSingle() { return run(true); }, then(resolve, reject) { return Promise.resolve(run(false)).then(resolve, reject); },
    };
    function run(single) {
      if (inserting) {
        if (rows[table].some(r => r.id === inserting.id)) return { data: null, error: { code: '23505' } };
        writes++; rows[table].push(structuredClone(inserting)); return { data: structuredClone(inserting), error: null };
      }
      const data = rows[table].filter(r => predicates.every(p => p(r)));
      return { data: single ? data[0] ?? null : data, error: null };
    }
    return q;
  }};
  return { db, rows, f, stats: () => ({ reads, writes }) };
}
const endpoint = 'app/api/projects/[id]/construction-proposals/route.ts';
const context = { params: Promise.resolve({ id: 'synthetic-project' }) };
const request = (body) => new NextRequest('http://localhost/api/construction', { method: 'POST', body: JSON.stringify(body) });
async function review(api, f) { return (await api.GET(new NextRequest(`http://localhost/api/construction?estimate_version_id=${f.version.id}&sow_id=${f.sow.id}`), context)).json(); }
test('authentication and financial permission denied before any database read', async () => {
  for (const role of [null, 'staff', 'builder', 'client']) {
    const state = database(); const api = loadRoute(endpoint, state.db, role);
    assert.equal((await api.GET(new NextRequest('http://localhost'), context)).status, role === null ? 401 : 403);
    assert.equal((await api.POST(request({}), context)).status, role === null ? 401 : 403);
    assert.equal(state.stats().reads, 0);
  }
});
test('review/cancel/back is read-only; stale source fails without saving', async () => {
  const s = database(); const api = loadRoute(endpoint, s.db, 'admin'); const r = await review(api, s.f);
  assert.equal(s.stats().writes, 0);
  assert.ok(!JSON.stringify(r).includes('SECRET-SUPPLIER'));
  assert.ok(!JSON.stringify(r).includes('cost_ex_gst'));
  s.rows.sow_sections[0].sow_lines[0].text = 'Changed since review';
  const result = await api.POST(request({ ...s.f.selection, source_digest: r.source_digest }), context);
  assert.equal(result.status, 409); assert.equal(s.stats().writes, 0);
});
test('repeated click and concurrent tabs converge; key order survives JSONB and back retry', async () => {
  const s = database(); const api = loadRoute(endpoint, s.db, 'admin'); const r = await review(api, s.f);
  const body = { ...s.f.selection, source_digest: r.source_digest };
  const responses = await Promise.all(Array.from({ length: 5 }, () => api.POST(request(body), context)));
  assert.deepEqual(responses.map(r => r.status).sort(), [200,200,200,200,201]);
  assert.equal(s.stats().writes, 1);
  s.rows.proposals[0].content = Object.fromEntries(Object.entries(s.rows.proposals[0].content).reverse());
  assert.equal((await api.POST(request(body), context)).status, 200);
  assert.equal(s.stats().writes, 1);
});
test('cross-project sources and invalid schedule cannot create a proposal', async () => {
  const s = database(); const api = loadRoute(endpoint, s.db, 'admin'); const r = await review(api, s.f);
  const body = { ...s.f.selection, source_digest: r.source_digest, payments: [{ label: 'Deposit', percentage: 95.5 }] };
  assert.equal((await api.POST(request(body), context)).status, 400);
  s.rows.estimate_versions[0].project_id = 'another-project';
  assert.equal((await api.POST(request(body), context)).status, 400);
  assert.equal(s.stats().writes, 0);
});
test('construction cannot be edited, drafted, sent, resent or accepted, even if status is forced to sent', async () => {
  const s = database(); const content = core.buildConstructionContent(s.f);
  s.rows.proposals.push({ id: 'proposal', token: 'token', status: 'sent', content });
  for (const file of ['app/api/proposals/[id]/route.ts', 'app/api/proposals/[id]/draft/route.ts', 'app/api/proposals/[id]/send/route.ts', 'app/api/proposals/[id]/resend/route.ts', 'app/api/proposal/[token]/accept/route.ts']) {
    const api = loadRoute(file, s.db, 'admin');
    const handler = api.PATCH || api.POST;
    const result = await handler(request({ consent: true, typed_name: 'Synthetic Test', drawn_data_url: 'test' }), { params: Promise.resolve({ id: 'proposal', token: 'token' }) });
    assert.equal(result.status, 409, file);
  }
  assert.equal(s.stats().writes, 0);
});
test('approval cannot bind a different version or modified content; exact match still does not release signing', () => {
  const p = { id: 'version-1', content: core.buildConstructionContent(fixture()), construction_version_digest: 'a'.repeat(64) };
  const input = { proposal_version_id: p.id, proposal_version_digest: p.construction_version_digest };
  assert.equal(identity.matchesConstructionApproval(p, input), true);
  assert.equal(identity.matchesConstructionApproval(p, { ...input, proposal_version_id: 'version-2' }), false);
  assert.equal(identity.matchesConstructionApproval({ ...p, construction_version_digest: 'b'.repeat(64) }, input), false);
});
test('separate variation route is permission-gated, idempotent and detects changed packages', async () => {
  const s = database(); const f = s.f;
  s.rows.proposals.push({ id: 'accepted', construction_version_digest: 'a'.repeat(64), project_id: f.version.project_id, status: 'accepted', content: core.buildConstructionContent(f), total_inc: 352, signed_name: 'Synthetic Client', signed_at: '2026-01-01T00:00:00Z' });
  s.rows.client_contract_variations = [{ id: 'pack-a', project_id: f.version.project_id, label: 'Extra door', amount_inc_gst: 1100, status: 'active', deleted_at: null }];
  const file = 'app/api/projects/[id]/construction-proposals/variation/route.ts';
  const denied = loadRoute(file, s.db, 'designer');
  assert.equal((await denied.POST(request({}), context)).status, 403);
  assert.equal(s.stats().reads, 0);
  const api = loadRoute(file, s.db, 'admin');
  const r = await (await api.GET(new NextRequest('http://localhost?base_id=accepted'), context)).json();
  const body = { base_id: 'accepted', package_id: 'pack-a', source_digest: r.source_digest, description: 'Add door', time_effect_days: 0, time_effect_note: 'No programme change' };
  assert.equal((await api.POST(request(body), context)).status, 201);
  assert.equal((await api.POST(request(body), context)).status, 200);
  assert.equal(s.stats().writes, 1);
  assert.equal(s.rows.proposals[0].total_inc, 352);
  s.rows.client_contract_variations[0].amount_inc_gst = 2200;
  assert.equal((await api.POST(request(body), context)).status, 409);
});

test('public construction token preview refuses anonymous and non-admin viewers before loading project details', async () => {
  for (const role of [null, 'designer', 'builder']) {
    const s = database();
    s.rows.proposals.push({ id: 'private-draft', token: 'secret-token', project_id: s.f.version.project_id, content: core.buildConstructionContent(s.f), status: 'draft' });
    const page = loadRoute('app/proposal/[token]/page.tsx', s.db, role);
    await assert.rejects(() => page.default({ params: Promise.resolve({ token: 'secret-token' }) }), /NOT_FOUND/);
    assert.equal(s.stats().reads, 1);
  }
});
test('PDF route rejects non-admin access before a financial query', async () => {
  for (const role of [null, 'designer']) {
    const s = database(); const api = loadRoute('app/api/proposals/[id]/pdf/route.ts', s.db, role);
    const res = await api.GET(new NextRequest('http://localhost'), context);
    assert.equal(res.status, role === null ? 401 : 403);
    assert.equal(s.stats().reads, 0);
  }
});

test('local-only issue and approval bind RPC inputs and never enter design delivery side effects',async()=>{
 const s=database(), calls=[];
 const p={id:'version',token:'token',project_id:'synthetic-project',construction_version_digest:'a'.repeat(64),content:core.buildConstructionContent(s.f),status:'draft'};s.rows.proposals.push(p);
 s.db.rpc=async(name,args)=>{calls.push({name,args});return {data:{status:name==='issue_construction_proposal'?'sent':'accepted'},error:null};};
 const ctx={params:Promise.resolve({id:p.id,token:p.token})};
 const issue=loadRoute('app/api/proposals/[id]/send/route.ts',s.db,'admin',true);
 assert.equal((await issue.POST(request({request_id:'request',proposal_version_digest:'wrong'}),ctx)).status,409);assert.equal(calls.length,0);
 const issued=await issue.POST(request({request_id:'request',proposal_version_digest:p.construction_version_digest}),ctx);
 assert.equal(issued.status,200);assert.equal((await issued.json()).delivery,'held');assert.equal(calls[0].args.p_actor,'synthetic-admin');
 const accept=loadRoute('app/api/proposal/[token]/accept/route.ts',s.db,null,true);
 const body={request_id:'accept-request',proposal_version_id:p.id,proposal_version_digest:p.construction_version_digest,consent:true,typed_name:'Synthetic Client',drawn_data_url:'synthetic'};
 assert.equal((await accept.POST(request({...body,proposal_version_id:'other'}),ctx)).status,409);assert.equal(calls.length,1);
 assert.equal((await accept.POST(request(body),ctx)).status,200);
 assert.equal(calls[1].args.p_token,p.token);assert.equal(calls[1].args.p_digest,p.construction_version_digest);assert.equal(calls[1].args.p_project,p.project_id);assert.equal(s.stats().writes,0);
 s.db.rpc=async()=>({data:null,error:{message:'release is disabled'}});
 assert.equal((await accept.POST(request(body),ctx)).status,409);
});
test('approval history is admin-only and degrades safely when candidate schema is absent',async()=>{
 const s=database(),file='app/api/proposals/[id]/history/route.ts';
 for(const role of [null,'designer'])assert.equal((await loadRoute(file,s.db,role).GET(request({}),context)).status,role===null?401:403);
 assert.equal(s.stats().reads,0);
 s.rows.proposals.push({id:'synthetic-project',project_id:'synthetic-project',content:core.buildConstructionContent(s.f)});
 s.db.rpc=async()=>({data:null,error:{message:'missing function'}});
 assert.equal((await loadRoute(file,s.db,'admin').GET(request({}),context)).status,503);
 s.db.rpc=async()=>({data:[{action:'accepted',proposal_id:'synthetic-project'}],error:null});
 const res=await loadRoute(file,s.db,'admin').GET(request({}),context);assert.equal(res.status,200);assert.match(res.headers.get('cache-control'),/no-store/);
});

test('room heading API rejects stale, issued, wrong-trade and anonymous edits; save/reset preserve trade identity',async()=>{
 const trade='Timber Floor Laying & Sanding';let signedIn=true,writes=0,concurrent=false;
 const section={id:'front',sow_id:'scope',updated_at:'v1',source_room_id:null,trade_heading_overrides:{},sow_documents:{status:'draft'}};
 const db={auth:{getUser:async()=>({data:{user:signedIn?{id:'staff'}:null}})},from(table){let update,filters=[];
 const run=()=>{if(table==='sow_lines')return {data:filters.some(([k,v])=>k==='trade'&&v!==trade)?[]:[{id:'line'}],error:null};if(update){if(concurrent)return {data:null,error:null};writes++;Object.assign(section,update);return {data:structuredClone(section),error:null};}return {data:structuredClone(section),error:null};};
 const q={select:()=>q,eq:(k,v)=>{filters.push([k,v]);return q;},limit:()=>q,update:value=>{update=value;return q;},single:async()=>run(),maybeSingle:async()=>run(),then:(a,b)=>Promise.resolve(run()).then(a,b)};return q;}};
 const api=loadRoute('app/api/sow/sections/[sectionId]/route.ts',db,'staff');const ctx={params:Promise.resolve({sectionId:'front'})};
 const body={trade_heading_override:{trade,heading:'Timber Floor Laying'},expected_updated_at:'v1'};
 signedIn=false;assert.equal((await api.PATCH(request(body),ctx)).status,401);signedIn=true;
 assert.equal((await api.PATCH(request({...body,expected_updated_at:'old'}),ctx)).status,409);
 assert.equal((await api.PATCH(request({...body,trade_heading_override:{trade:'Other trade',heading:'x'}}),ctx)).status,400);
 section.sow_documents.status='issued';assert.equal((await api.PATCH(request(body),ctx)).status,409);section.sow_documents.status='draft';
 concurrent=true;assert.equal((await api.PATCH(request(body),ctx)).status,409);concurrent=false;assert.equal(writes,0);
 assert.equal((await api.PATCH(request(body),ctx)).status,200);assert.deepEqual(section.trade_heading_overrides,{[trade]:'Timber Floor Laying'});
 assert.equal((await api.PATCH(request({...body,trade_heading_override:{trade,heading:null}}),ctx)).status,200);assert.deepEqual(section.trade_heading_overrides,{});assert.equal(writes,2);
});
