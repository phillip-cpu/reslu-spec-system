import * as quoteAccess from '../lib/construction-quote-access.ts';
/** Real PostgreSQL in a disposable /tmp cluster. No external DB URLs accepted.
 * Install pinned embedded-postgres@18.4.0-beta.17 and pg@8.16.3 under
 * /tmp/reslu-construction-db-deps; hydrate its platform symlinks before running.
 * All accounts/passwords below exist only inside the disposable synthetic DB.
 */
import assert from 'node:assert/strict';
import ts from 'typescript';
import { quoteContent, emptyQuote } from '../lib/construction-quotes.ts';
import * as quotes from '../lib/construction-quotes.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { buildConstructionContent, buildConstructionVariation } from '../lib/construction-proposals.ts';
import { issueConstructionVersion, respondConstructionVersion } from '../lib/construction-lifecycle.ts';
import { fixture } from '../lib/construction-proposals.fixture.ts';
process.env.RESLU_CONSTRUCTION_QUOTES_ENABLED='1';
const deps = createRequire('/tmp/reslu-construction-db-deps/package.json');
const { default: EmbeddedPostgres } = await import(deps.resolve('embedded-postgres'));
const { Client, types } = deps('pg');
types.setTypeParser(1184, value => value); // Preserve PostgREST-style timestamp precision for optimistic saves.
const root = await mkdtemp(join(tmpdir(), 'reslu-construction-postgres-'));
const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const password = randomBytes(24).toString('hex');
const cluster = new EmbeddedPostgres({ databaseDir: join(root,'data'), user: 'postgres', password, port, persistent: false, createPostgresUser: false, postgresFlags: ['-h','127.0.0.1','-k',root], onLog: () => {}, onError: message => { if (/FATAL|PANIC/.test(String(message))) console.error(String(message)); } });
const clients = []; let owner; let checks = 0;
const check = async (name, action) => { await action(); checks++; console.log(`PASS ${name}`); };
const connect = async (role='postgres', actor='') => {
  const db = new Client({ host:'127.0.0.1',port,user:role,password,database:'postgres' });
  await db.connect(); clients.push(db);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
  return db;
};
const project = randomUUID(), otherProject=randomUUID(), adminId=randomUUID(), designerId=randomUUID(), version=randomUUID(), sow=randomUUID();
const migration = 'supabase/migrations/20261013000008_construction_proposal_lifecycle.sql';
try {
  await cluster.initialise(); await cluster.start(); owner=await connect();
  await owner.query(`create role anon login password '${password}'; create role authenticated login password '${password}'; create role service_role login bypassrls password '${password}';
    create schema auth;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table profiles(id uuid primary key,role text not null,full_name text);
    alter table profiles enable row level security;
    create policy read_profiles on profiles for select to authenticated using(true);
    create policy update_own_profile on profiles for update to authenticated using(auth.uid()=id);
    grant select,update on profiles to authenticated; grant all on profiles to service_role;
    create table projects(id uuid primary key);
    create table leads(id uuid primary key);
    create table estimate_versions(id uuid primary key,project_id uuid references projects(id));
    create table sow_documents(id uuid primary key,project_id uuid references projects(id));
    create table client_contract_variations(id uuid primary key,project_id uuid references projects(id),amount_inc_gst numeric,label text,status text default 'active',deleted_at timestamptz);
    create extension pgcrypto;
    create function set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;`);
  const original=await readFile('supabase/migrations/051_proposals.sql','utf8');
  await owner.query(original.slice(0,original.indexOf('-- PART 2 — email_sends')));
  await owner.query(`grant select,insert,update,delete on proposals to authenticated,service_role; grant select on proposals to anon; grant select on projects,estimate_versions,sow_documents,client_contract_variations to authenticated,service_role;`);
  await owner.query('insert into profiles(id,role) values($1,\'admin\'),($2,\'designer\')',[adminId,designerId]);
  await owner.query('insert into projects values($1),($2)',[project,otherProject]);
  await owner.query('insert into estimate_versions values($1,$2)',[version,project]);
  await owner.query('insert into sow_documents values($1,$2)',[sow,project]);
  const sql=await readFile(migration,'utf8');
  const apply=async sql=>{await owner.query('begin');try{await owner.query(sql);await owner.query('commit');}catch(e){await owner.query('rollback');throw e;}};
  await check('missing shared role guard aborts candidate transaction without partial objects',async()=>{
    await assert.rejects(()=>apply(sql),/shared profile role guard/);
    assert.equal((await owner.query("select to_regnamespace('construction_proposal_private') n")).rows[0].n,null);
  });
  await owner.query(await readFile('supabase/release-dependencies/reused_profile_role_guard.sql','utf8'));
  await check('changed shared guard fails closed',async()=>{
    await owner.query('alter table profiles disable trigger guard_profile_role_change');
    await assert.rejects(()=>apply(sql),/shared profile role guard/);
    await owner.query('alter table profiles enable trigger guard_profile_role_change');
  });
  await apply(sql); await apply(sql);
  const quoteSql=await readFile('supabase/migrations/20261024000458_construction_quote_authorisation.sql','utf8');
  await apply(quoteSql); await apply(quoteSql);
  const admin=await connect('authenticated',adminId), designer=await connect('authenticated',designerId), anon=await connect('anon');
  const service=await connect('service_role'), service2=await connect('service_role');
  await check('readiness rejects missing, disabled or drifted protections and non-admin actors',async()=>{
    const ready=async()=> (await admin.query('select public.construction_quote_runtime_ready() ready')).rows[0].ready;
    assert.equal(await ready(),true);
    assert.equal((await designer.query('select public.construction_quote_runtime_ready() ready')).rows[0].ready,false);
    await assert.rejects(()=>anon.query('select public.construction_quote_runtime_ready()'),/permission denied/);
    for(const statement of [
      'alter table proposals disable row level security',
      'alter table proposals disable trigger guard_construction_quote',
      'alter table profiles disable trigger guard_profile_role_change',
      'drop policy construction_quote_no_anonymous on proposals',
      "alter policy construction_quote_admin_only on proposals using(true)",
    ]) {
      await owner.query('begin');await owner.query(statement);
      // Evaluate as authenticated admin within the owner transaction, without bypass privileges.
      await owner.query('set local role authenticated');await owner.query("select set_config('request.jwt.claim.sub',$1,true)",[adminId]);
      assert.equal((await owner.query('select public.construction_quote_runtime_ready() ready')).rows[0].ready,false,statement);
      await owner.query('rollback');
    }
    assert.equal(await ready(),true);
  });
  function content(previous) {
    const f=fixture(); f.version.id=version;f.version.project_id=project;f.sow.id=sow;f.sow.project_id=project;
    f.selection.estimate_version_id=version;f.selection.sow_id=sow;
    return buildConstructionContent({...f,previous});
  }
  async function draft(c=content(),db=admin) {
    return (await db.query(`insert into proposals(id,project_id,content,total_inc,deposit_inc) values($1,$2,$3,$4,$5) returning *`,[randomUUID(),project,c,c.construction.total_inc,c.construction.payments[0]?.amount_inc ?? 0])).rows[0];
  }
  // Run the actual creation/save handlers, backed by PostgreSQL rather than row mocks.
  // This adapter implements only their query vocabulary, with all filters in SQL.
  const sqlAdapter = db => ({ async rpc(name){assert.equal(name,'construction_quote_runtime_ready');return {data:(await db.query('select public.construction_quote_runtime_ready() ready')).rows[0].ready,error:null};}, from(table) {
    assert.ok(['proposals','projects'].includes(table));
    let filters=[], inserted, updated, columns='*';
    const q={select(c='*'){columns=c;return q;},eq(k,v){assert.ok(['id','project_id','status','updated_at'].includes(k));filters.push([k,v]);return q;},insert(v){inserted=v;return q;},update(v){updated=v;return q;},single:()=>run(),maybeSingle:()=>run()};
    async function run(){
      const vals=[], param=v=>{vals.push(v);return '$'+vals.length;};
      let sql;
      if(inserted){const keys=Object.keys(inserted);sql=`insert into ${table} (${keys.join(',')}) values (${keys.map(k=>param(inserted[k])).join(',')}) returning *`;}
      else {const where=()=>filters.map(([k,v])=>`${k}=${param(v)}`).join(' and ')||'true';sql=updated?`update ${table} set ${Object.entries(updated).map(([k,v])=>`${k}=${param(v)}`).join(',')} where ${where()} returning *`:`select ${columns} from ${table} where ${where()}`;}
      try {const result=await db.query(sql,vals);return {data:result.rows[0]??null,error:null};}catch(e){return {data:null,error:{code:e.code,message:e.message}};}
    }
    return q;
  }});
  const nodeRequire=createRequire(import.meta.url);
  function route(file,db,role='admin'){
    const exports={};
    const source=ts.transpileModule(requireText(file),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const mocks={
      '@/lib/supabase/server':{createClient:async()=>sqlAdapter(db)},
      '@/lib/auth':{getUserRole:async()=>role?{role,userId:adminId}:null},
      '@/lib/construction-quote-access': quoteAccess,
    '@/lib/construction-quotes':quotes,
      '@/lib/construction-proposals':{isConstruction:c=>c?.kind==='construction'},
      '@/lib/construction-lifecycle':{localConstructionLifecycleEnabled:()=>false},
    };
    new Function('require','exports',source)(name=>mocks[name]||(name.startsWith('@/')?new Proxy({},{get:()=>()=>{throw Error('Unexpected dependency '+name);}}):nodeRequire(name)),exports);return exports;
  }
  function requireText(file){return nodeRequire('node:fs').readFileSync(file,'utf8');}
  const postFile='app/api/projects/[id]/construction-quotes/route.ts',patchFile='app/api/proposals/[id]/route.ts';
  const ctx={params:Promise.resolve({id:project})};
  const request=body=>new Request('http://127.0.0.1/synthetic',{method:'POST',body:JSON.stringify(body)});
  let quote;
  const requestId=randomUUID();
  await check('real route creates one draft, no SOW/estimate linkage or deposit',async()=>{
    const r=await route(postFile,admin).POST(request({request_id:requestId}),ctx);assert.equal(r.status,201,JSON.stringify(await r.clone().json()));quote=(await r.json()).proposal;
    assert.equal(quote.status,'draft');assert.equal(Number(quote.deposit_inc),0);assert.equal(quote.content.kind,'construction_quote');assert.equal(quote.construction_version_digest,null);
    assert.equal((await owner.query('select count(*)::int n from construction_proposal_private.events')).rows[0].n,0);
  });
  await check('duplicate creation and independent-connection retry return same record',async()=>{
    const second=await connect('authenticated',adminId);
    const result=await Promise.all([route(postFile,admin).POST(request({request_id:requestId}),ctx),route(postFile,second).POST(request({request_id:requestId}),ctx)]);
    for(const r of result){assert.equal(r.status,200);assert.equal((await r.json()).proposal.id,quote.id);}
    assert.equal((await owner.query('select count(*)::int n from proposals where id=$1',[quote.id])).rows[0].n,1);
  });
  await check('actual updated_at trigger and concurrent route saves admit exactly one writer',async()=>{
    const second=await connect('authenticated',adminId), context={params:Promise.resolve({id:quote.id})};
    const payload=label=>({expected_updated_at:quote.updated_at,content:quoteContent({...emptyQuote(),price_ex_gst:1234.56,scope_summary:label,drawing_references:'SYNTHETIC A102 / T1'})});
    const rs=await Promise.all([route(patchFile,admin).PATCH(request(payload('SYNTHETIC writer A')),context),route(patchFile,second).PATCH(request(payload('SYNTHETIC writer B')),context)]);
    assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);
    quote=(await rs.find(r=>r.status===200).json()).proposal;
    assert.equal(Number(quote.total_inc),1358.02);assert.equal(Number(quote.deposit_inc),0);
    assert.match(quote.content.scope_sections[0].bullets[0],/SYNTHETIC writer [AB]/);
  });
  await check('non-admin route denied and quote kind downgrade rejected',async()=>{
    const context={params:Promise.resolve({id:quote.id})};
    assert.equal((await route(patchFile,designer,'designer').PATCH(request({}),context)).status,403);
    assert.equal((await route(patchFile,admin).PATCH(request({expected_updated_at:quote.updated_at,content:{...quote.content,kind:'design'}}),context)).status,400);
  });
  await check('anonymous SQL cannot read quote rows',async()=>{assert.equal((await anon.query('select * from proposals where id=$1',[quote.id])).rows.length,0);});
  await check('RLS denies non-admin quote read/update/delete and creation',async()=>{
    assert.equal((await designer.query('select * from proposals where id=$1',[quote.id])).rows.length,0);
    assert.equal((await designer.query("update proposals set total_inc=1 where id=$1 returning id",[quote.id])).rows.length,0);
    assert.equal((await designer.query('delete from proposals where id=$1 returning id',[quote.id])).rows.length,0);
    await assert.rejects(()=>designer.query('insert into proposals(project_id,content) values($1,$2)',[project,quoteContent(emptyQuote())]),/Admin actor|row-level security/);
  });
  await check('admin cannot downgrade kind, change identity, issue, accept or set deposit/evidence',async()=>{
    const attempts=[
      ["content=jsonb_set(content,'{kind}','\"design\"')",[]],
      ["content=content-'kind'",[]],
      ["content=jsonb_set(content,'{kind}','null')",[]],
      ["status='sent'",[]],["status='accepted'",[]],["status='closed'",[]],
      ["deposit_inc=100",[]],["signed_name='SYNTHETIC'",[]],
      ["signature='{}'::jsonb",[]],["sent_at=now()",[]],["viewed_at=now()",[]],
      ["signed_pdf_path='synthetic.pdf'",[]],["construction_version_digest='synthetic'",[]],
      ["project_id=$2",[otherProject]],["token='replacement-token'",[]],
    ];
    for(const [set,args] of attempts) await assert.rejects(()=>admin.query(`update proposals set ${set} where id=$1`,[quote.id,...args]),/quote|construction|Digest/i);
    await assert.rejects(()=>admin.query('delete from proposals where id=$1',[quote.id]),/quote identity/i);
    assert.equal((await admin.query('select status,deposit_inc from proposals where id=$1',[quote.id])).rows[0].status,'draft');
  });
  await check('quote inserts cannot start sent/accepted or with invoice/evidence fields',async()=>{
    for(const status of ['sent','accepted','closed']) await assert.rejects(()=>admin.query('insert into proposals(project_id,content,status) values($1,$2,$3)',[project,quoteContent(emptyQuote()),status]),/unsigned drafts/);
    await assert.rejects(()=>admin.query('insert into proposals(project_id,content,deposit_inc) values($1,$2,1)',[project,quoteContent(emptyQuote())]),/zero deposit/);
  });
  await check('service-role bypass cannot mutate quote without admin actor or change its kind',async()=>{
    await assert.rejects(()=>service.query('update proposals set total_inc=5 where id=$1',[quote.id]),/Admin actor/);
    await assert.rejects(()=>service.query("update proposals set content=jsonb_set(content,'{kind}','\"design\"') where id=$1",[quote.id]),/kind cannot change/);
  });
  await check('design workflows remain editable but cannot be converted into quote records',async()=>{
    const id=randomUUID();await admin.query('insert into proposals(id,project_id,content) values($1,$2,$3)',[id,project,{kind:'design',letter:'SYNTHETIC'}]);
    await admin.query("update proposals set status='sent',deposit_inc=30 where id=$1",[id]);
    assert.equal((await admin.query('select status from proposals where id=$1',[id])).rows[0].status,'sent');
    await assert.rejects(()=>admin.query('update proposals set content=$2,status=\'draft\',deposit_inc=0 where id=$1',[id,quoteContent(emptyQuote())]),/kind cannot change/);
  });
  await check('existing frozen construction protection and disabled release gate remain intact',async()=>{
    assert.equal((await owner.query('select enabled from construction_proposal_private.release_gate where singleton')).rows[0].enabled,false);
    assert.equal((await owner.query('select count(*)::int n from construction_proposal_private.outbox')).rows[0].n,0);
    const p=await draft();assert.equal((await designer.query('select * from proposals where id=$1',[p.id])).rows.length,0);
    await assert.rejects(()=>admin.query("update proposals set content=jsonb_set(content,'{kind}','\"design\"') where id=$1",[p.id]),/immutable|construction|version/i);
    assert.equal((await owner.query('select count(*)::int n from construction_proposal_private.events')).rows[0].n,0);
  });
  console.log(`Completed ${checks} PostgreSQL scenarios. Quote authorisation enforced; original construction protections retained. No external database contacted.`);
} finally {
  await Promise.allSettled(clients.map(c=>c.end()));
  await cluster.stop().catch(()=>{});
  await rm(root,{recursive:true,force:true});
  console.log('Disposable cluster stopped and removed.');
}
