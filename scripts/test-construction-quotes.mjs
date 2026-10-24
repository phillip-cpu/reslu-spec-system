import * as quoteAccess from '../lib/construction-quote-access.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as quotes from '../lib/construction-quotes.ts';
process.env.RESLU_CONSTRUCTION_QUOTES_ENABLED='1';
const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const context = { params: Promise.resolve({ id: 'project', token: 'token' }) };
const request = body => new NextRequest('http://localhost/api/test', { method: 'POST', body: JSON.stringify(body) });
function load(file, db, role = 'admin') {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(process.env.QUOTE_ROLLBACK_ROOT ? process.env.QUOTE_ROLLBACK_ROOT+'/'+file : file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mocks = {
    '@/lib/construction-quote-access': quoteAccess,
    '@/lib/construction-quotes': quotes,
    '@/lib/supabase/server': { createClient: async () => db, createServiceRoleClient: () => db },
    '@/lib/auth': { getUserRole: async () => role ? { role, userId: 'admin' } : null },
    '@/lib/construction-proposals': { isConstruction: c => c?.kind === 'construction' },
    '@/lib/construction-lifecycle': { localConstructionLifecycleEnabled: () => false },
    '@/lib/proposals': { validateProposalContent: () => null, computeProposalTotal: c => c.stages.reduce((n,s) => n+s.total_inc,0) },
    '@/lib/rate-limit': { rateLimit: () => ({ ok: true }) },
    '@/lib/signatures': { decodePngDataUrl: () => new Uint8Array([1]) },
    'next/headers': { headers: async () => new Headers() },
    'next/navigation': { notFound: () => { throw new Error('NOT_FOUND'); } },
  };
  new Function('require','exports',code)(name => mocks[name] || (name.startsWith('@/') ? new Proxy({}, {get: (_, key) => () => { throw new Error(`Forbidden side effect ${name}.${String(key)}`); }}) : require(name)),exports);
  return exports;
}
function database(seed = []) {
  const rows = structuredClone(seed); let writes = 0, reads = 0;
  return { rpc: async()=>({data:true,error:null}), rows, stats: () => ({ writes, reads }), from(table) {
    reads++; assert.ok(['projects','proposals'].includes(table), `Unexpected table ${table}`);
    const filters = []; let insert, update;
    const q = { select: () => q, eq(k,v) { filters.push(r => r[k] === v); return q; }, insert(v) { insert=v;return q; }, update(v) { update=v;return q; }, single: () => run(), maybeSingle: () => run() };
    async function run() {
      if (table === 'projects') return {data:{id:'project'},error:null};
      if (insert) { if (rows.some(r => r.id === insert.id)) return {error:{code:'23505'}}; const r={...insert,updated_at:'v1'};rows.push(r);writes++;return {data:structuredClone(r),error:null}; }
      const row=rows.find(r=>filters.every(f=>f(r)));
      if (row && update) { Object.assign(row,update,{updated_at:row.updated_at+'x'});writes++; }
      return {data:row?structuredClone(row):null,error:null};
    }
    return q;
  }};
}
const seed = () => ({id:'project',project_id:'project',token:'token',status:'draft',updated_at:'v1',content:quotes.quoteContent(quotes.emptyQuote()),deposit_inc:0,total_inc:0});
const createFile='app/api/projects/[id]/construction-quotes/route.ts';
const patchFile='app/api/proposals/[id]/route.ts';
test('selling fields are whitelisted; GST derives in cents; no imported financial fields', () => {
  const fields={...quotes.emptyQuote(),price_ex_gst:1234.56,drawing_references:'A102 / T1',scope_summary:'Synthetic works'};
  const content=quotes.quoteContent(fields);
  assert.equal(content.fees.stages[0].total_inc,1358.02);
  assert.match(content.fees.price_lines[1],/123.46/);
  for(const value of [-1,NaN,Infinity,1.111,'123']) assert.throws(()=>quotes.quoteContent({...fields,price_ex_gst:value}));
  for(const key of ['cost','margin','markup','supplier','estimate']) assert.throws(()=>quotes.quoteContent({...fields,[key]:'SECRET'}));
  assert.equal(content.kind,'construction_quote');
});
test('create requires admin before any data access; no scope read or issue', async () => {
  for(const role of [null,'staff','builder','client']) { const db=database();const r=await load(createFile,db,role).POST(request({request_id:crypto.randomUUID()}),context);assert.equal(r.status,role?403:401);assert.equal(db.stats().reads,0); }
});
test('repeated create retries converge without invoice, scope or queue writes', async () => {
  const db=database(), api=load(createFile,db), body={request_id:crypto.randomUUID()};
  const results=await Promise.all([api.POST(request(body),context),api.POST(request(body),context)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(db.rows.length,1);assert.equal(db.rows[0].deposit_inc,0);assert.equal(db.rows[0].status,'draft');
});
test('editing saves only quote fields, stale tabs cannot overwrite, kind/deposit bypass rejected', async () => {
  const db=database([seed()]), api=load(patchFile,db);
  const content=quotes.quoteContent({...quotes.emptyQuote(),scope_summary:'Revised scope',price_ex_gst:100});
  content.construction={cost:'SECRET'};
  const body={content,expected_updated_at:'v1'};
  assert.equal((await api.PATCH(request(body),context)).status,200);
  assert.equal(db.rows[0].total_inc,110);assert.ok(!JSON.stringify(db.rows).includes('SECRET'));
  assert.equal((await api.PATCH(request(body),context)).status,409);
  for(const payload of [{...body,deposit_inc:30},{...body,content:{...content,kind:'design'}},{...body,content:{...content,kind:'construction'}}]) assert.equal((await api.PATCH(request(payload),context)).status,400);
  assert.equal(db.stats().writes,1);
});
test('design cannot be changed into a quote; construction remains immutable', async () => {
  for(const kind of ['design','construction']) {const db=database([{...seed(),content:{kind}}]);assert.equal((await load(patchFile,db).PATCH(request({content:seed().content}),context)).status,kind==='construction'?409:400);assert.equal(db.stats().writes,0);}
});
test('quote send/resend/accept/Aria paths fail closed before side effects', async () => {
  for(const file of ['app/api/proposals/[id]/send/route.ts','app/api/proposals/[id]/resend/route.ts','app/api/proposal/[token]/accept/route.ts','app/api/proposals/[id]/draft/route.ts']) {
    const db=database([seed()]),api=load(file,db); const fn=api.POST||api.PATCH;
    const result=await fn(request({consent:true,typed_name:'Synthetic',drawn_data_url:'synthetic',letter:'x'}),context);
    assert.equal(result.status,409,file);assert.equal(db.stats().writes,0);
  }
});
test('public quote token is unavailable even to an admin', async () => {
  const db=database([seed()]);const page=load('app/proposal/[token]/page.tsx',db);
  await assert.rejects(()=>page.default(context),/NOT_FOUND/);assert.equal(db.stats().writes,0);
});
test('normal design draft edits still use original path', async () => {
  const s=seed();s.content.kind='design'; const db=database([s]);
  assert.equal((await load(patchFile,db).PATCH(request({content:{...s.content,letter:'Updated design'}}),context)).status,200);
  assert.equal(db.rows[0].content.letter,'Updated design');
});
test('writes fail closed with gate off, missing RPC, false readiness and RPC errors',async()=>{
 const id=crypto.randomUUID();
 for(const response of [{data:false,error:null},{data:null,error:{code:'PGRST202'}},{data:true,error:{message:'broken'}},'throw']){
  const db=database();db.rpc=async()=>{if(response==='throw')throw Error('offline');return response;};
  const r=await load(createFile,db).POST(request({request_id:id}),context);assert.equal(r.status,503);assert.equal(db.stats().writes,0);assert.equal(db.stats().reads,0);
 }
 const db=database();let called=false;db.rpc=async()=>{called=true;throw Error('must not call');};
 delete process.env.RESLU_CONSTRUCTION_QUOTES_ENABLED;
 try{assert.equal((await load(createFile,db).POST(request({request_id:id}),context)).status,503);assert.equal(called,false);}finally{process.env.RESLU_CONSTRUCTION_QUOTES_ENABLED='1';}
});
