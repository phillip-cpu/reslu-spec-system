/** Disposable loopback PostgreSQL only. No external database URL is accepted. */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {createServer} from 'node:net';
import {revisionFixture} from '../lib/revisions/fixture.ts';
import {revisionSnapshot,revisionEstimate,editRevision,validatePayload} from '../lib/revisions/model.ts';
const deps=createRequire('/tmp/reslu-construction-db-deps/package.json');const {default:EmbeddedPostgres}=await import(deps.resolve('embedded-postgres'));const {Client}=deps('pg');
const root=await mkdtemp(join(tmpdir(),'job-revision-pg-'));const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const password=randomBytes(24).toString('hex');
const cluster=new EmbeddedPostgres({databaseDir:join(root,'data'),user:'postgres',password,port,persistent:false,createPostgresUser:false,postgresFlags:['-h','127.0.0.1','-k',root],onLog:()=>{},onError:()=>{}});
let owner,checks=0;const clients=[];const check=async(name,fn)=>{await fn();checks++;console.log('PASS',name)};
const connect=async(role='postgres',actor='')=>{const db=new Client({host:'127.0.0.1',port,user:role,password,database:'postgres'});await db.connect();clients.push(db);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);return db;};
const adminId=randomUUID(),designerId=randomUUID(),frozen=revisionFixture(),project=frozen.payload.project_id;
try{
 await cluster.initialise();await cluster.start();owner=await connect();
 await owner.query(`create role anon login password '${password}';create role authenticated login password '${password}';create role service_role login bypassrls password '${password}';create schema auth;grant usage on schema public,auth to anon,authenticated,service_role;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table profiles(id uuid primary key,role text not null);alter table profiles enable row level security;create policy read_profiles on profiles for select to authenticated using(true);create policy update_profiles on profiles for update to authenticated using(id=auth.uid());grant select,update on profiles to authenticated;
 create table projects(id uuid primary key);
 create table estimate_versions(id uuid primary key default gen_random_uuid(),project_id uuid references projects(id),label text,kind text,snapshot jsonb,note text,created_by uuid,created_at timestamptz default now(),updated_at timestamptz default now(),unique(project_id,label));
 alter table estimate_versions enable row level security;create policy team_all on estimate_versions to authenticated using(true) with check(true);grant select,insert,update,delete on estimate_versions to authenticated;
 create table invoices(id uuid primary key,amount numeric);create table payments(id uuid primary key,amount numeric);create table notifications(id uuid primary key);insert into invoices values(gen_random_uuid(),123);insert into payments values(gen_random_uuid(),45);
 `);
 await owner.query('insert into profiles values($1,\'admin\'),($2,\'designer\')',[adminId,designerId]);await owner.query('insert into projects values($1)',[project]);
 const sql=await readFile('supabase/migrations/20261013031531_job_revision_workspaces.sql','utf8');
 const apply=async()=>{await owner.query('begin');try{await owner.query(sql);await owner.query('commit')}catch(e){await owner.query('rollback');throw e;}};
 await check('shared role guard prerequisite rejects release and rolls back all objects',async()=>{await assert.rejects(apply,/shared profile role guard/);assert.equal((await owner.query("select to_regclass('public.job_revision_workspaces') n")).rows[0].n,null)});
 await owner.query(await readFile('supabase/release-dependencies/reused_profile_role_guard.sql','utf8'));await apply();
 const admin=await connect('authenticated',adminId),second=await connect('authenticated',adminId),designer=await connect('authenticated',designerId),anon=await connect('anon'),service=await connect('service_role');
 // Synthetic source tables only; no archived customer data enters this cluster.
 for(const table of ['cost_sections','cost_lines','items','sow_documents','rooms','measurement_groups','variations'])await owner.query(`create table ${table}(id uuid primary key,project_id uuid,description text)`);
 await owner.query(`create table sow_sections(id uuid primary key,sow_id uuid,trade_heading_overrides jsonb default '{}'::jsonb);create table sow_lines(id uuid primary key,section_id uuid);create table measurements(id uuid primary key,group_id uuid);create table item_rooms(id uuid primary key,item_id uuid);create table item_components(id uuid primary key,item_id uuid);`);
 await owner.query(await readFile('supabase/migrations/20261013050409_authenticated_revision_import_guard.sql','utf8'));
 const hash=(await owner.query('select job_revision_private.hash($1::jsonb) h',[frozen])).rows[0].h;
 const freeze=()=>admin.query('select freeze_reviewed_job_revision($1,$2,$3,$4,$5) r',[project,'V2',revisionSnapshot(frozen.payload),frozen,hash]);
 await check('release gate defaults OFF',async()=>{await assert.rejects(freeze,/disabled/);assert.equal((await owner.query('select count(*)::int n from estimate_versions')).rows[0].n,0);});
 await owner.query('update job_revision_private.release_gate set enabled=true');
 await check('unreviewed archive fails closed; review record is inaccessible to app roles',async()=>{
  await assert.rejects(freeze,/fingerprint/);
  for(const db of [admin,designer,anon,service])await assert.rejects(()=>db.query('select * from job_revision_private.import_reviews'),/permission denied/);
 });
 const registerReview=async()=>owner.query('insert into job_revision_private.import_reviews values($1,$2,$3,job_revision_private.hash($4::jsonb),job_revision_private.source_digests($1))',[project,'V2',hash,revisionSnapshot(frozen.payload)]);
 await registerReview();
 await check('changed source, changed snapshot, wrong PDF fingerprint and active writers prevent freeze atomically',async()=>{
  const changed=randomUUID();await owner.query("insert into cost_lines values($1,$2,'new source row')",[changed,project]);await assert.rejects(freeze,/Source changed/);await owner.query('delete from cost_lines where id=$1',[changed]);
  await assert.rejects(()=>admin.query('select freeze_reviewed_job_revision($1,$2,$3,$4,$5)',[project,'V2',{},frozen,hash]),/fingerprint/);
  const bad=structuredClone(frozen);bad.sent_pdf.sha256='0'.repeat(64);const badHash=(await owner.query('select job_revision_private.hash($1::jsonb) h',[bad])).rows[0].h;
  await assert.rejects(()=>admin.query('select freeze_reviewed_job_revision($1,$2,$3,$4,$5)',[project,'V2',revisionSnapshot(frozen.payload),bad,badHash]),/fingerprint/);
  await owner.query('begin');await owner.query("insert into cost_lines values($1,$2,'concurrent source writer')",[changed,project]);try{await assert.rejects(freeze,/lock/)}finally{await owner.query('rollback')}
  assert.equal((await owner.query('select count(*)::int n from estimate_versions')).rows[0].n,0);
 });
 await check('anonymous, non-admin and service roles cannot use reviewed freeze',async()=>{
  for(const db of [anon,service])await assert.rejects(()=>db.query('select freeze_reviewed_job_revision($1,$2,$3,$4,$5)',[project,'V2',revisionSnapshot(frozen.payload),frozen,hash]),/permission denied/);
  await assert.rejects(()=>designer.query('select freeze_reviewed_job_revision($1,$2,$3,$4,$5)',[project,'V2',revisionSnapshot(frozen.payload),frozen,hash]),/Admin access/);
 });
 let baseline,w;
 await check('frozen source is exact, idempotent and immutable even to owner writes/deletion',async()=>{
  const concurrent=await Promise.all([freeze(),second.query('select freeze_reviewed_job_revision($1,$2,$3,$4,$5) r',[project,'V2',revisionSnapshot(frozen.payload),frozen,hash])]);baseline=concurrent[0].rows[0].r;assert.equal(concurrent[1].rows[0].r.id,baseline.id);assert.deepEqual(baseline.snapshot.full_job_revision,frozen);assert.equal((await freeze()).rows[0].r.id,baseline.id);await owner.query("insert into cost_lines values(gen_random_uuid(),$1,'later live change')",[project]);assert.equal((await freeze()).rows[0].r.id,baseline.id);assert.equal(baseline.created_by,adminId);
  await assert.rejects(()=>owner.query('update estimate_versions set snapshot=\'{}\' where id=$1',[baseline.id]),/immutable/);await assert.rejects(()=>admin.query('delete from estimate_versions where id=$1',[baseline.id]),/immutable/);
 });
 await check('broad legacy version policy cannot expose frozen financial payload or allow forged full-job rows',async()=>{
  assert.equal((await designer.query('select count(*)::int n from estimate_versions where id=$1',[baseline.id])).rows[0].n,0);
  await assert.rejects(()=>designer.query("insert into estimate_versions(project_id,label,snapshot) values($1,'forged',$2)",[project,{full_job_revision:frozen}]),/row-level security/);
  await owner.query("insert into estimate_versions(project_id,label,snapshot) values($1,'legacy','{}')",[project]);
  assert.equal((await designer.query("select count(*)::int n from estimate_versions where label='legacy'")).rows[0].n,1);
 });
 const fork=(request=randomUUID(),db=admin,label='V3',sourceHash=hash)=>db.query('select fork_job_revision($1,$2,$3,$4,$5) r',[project,baseline.id,sourceHash,label,request]);
 await check('repeat and simultaneous fork produce one independently owned V3',async()=>{
  const request=randomUUID(),results=await Promise.all([fork(request),fork(request,second)]);w=results[0].rows[0].r;assert.equal(results[1].rows[0].r.id,w.id);assert.equal((await fork()).rows[0].r.id,w.id);assert.equal((await owner.query('select count(*)::int n from job_revision_workspaces')).rows[0].n,1);
  validatePayload(w.payload);assert.notEqual(w.payload.scope.document.id,frozen.payload.scope.document.id);assert.equal(w.payload.scope.document.status,'draft');assert.deepEqual(w.payload.scope.sections[0].trade_heading_overrides,frozen.payload.scope.sections[0].trade_heading_overrides);assert.equal(revisionEstimate(w.payload).wholeJob.combinedIncGst,revisionEstimate(frozen.payload).wholeJob.combinedIncGst);
  assert.deepEqual(w.payload.sections[0].lines[0].source_payments,[]);assert.equal(w.payload.items[0].ordered_at,null);
 });
 await check('non-admin/anonymous/service role cannot read or mutate financial workspace, self-promotion blocked',async()=>{
  assert.equal((await designer.query('select * from job_revision_workspaces')).rows.length,0);
  await assert.rejects(()=>anon.query('select * from job_revision_workspaces'),/permission denied/);
  await assert.rejects(()=>service.query('select * from job_revision_workspaces'),/permission denied/);
  await assert.rejects(()=>fork(randomUUID(),designer),/Admin access/);await assert.rejects(()=>fork(randomUUID(),anon),/permission denied/);
  await assert.rejects(()=>designer.query("update profiles set role='admin' where id=$1",[designerId]),/role/i);
  await assert.rejects(()=>admin.query("update job_revision_workspaces set payload='{}'"),/permission denied/);
 });
 const save=(payload,version=w.lock_version,request=randomUUID(),db=admin)=>db.query('select save_job_revision($1,$2,$3,$4,$5,$6) r',[project,w.id,hash,version,payload,request]);
 await check('atomic save retry, two-editor conflict, source remains unchanged',async()=>{
  const payload=editRevision(w.payload,{entity:'items',action:'patch',id:w.payload.items[0].id,values:{price_trade:99,quantity:8}}).payload;
  const request=randomUUID();const results=await Promise.all([save(payload,0,request),save(payload,0,request,second)]);assert.equal(results[0].rows[0].r.lock_version,1);assert.equal(results[1].rows[0].r.lock_version,1);
  await assert.rejects(()=>save(payload,0),/conflict/);w=results[0].rows[0].r;
  assert.deepEqual((await owner.query('select snapshot from estimate_versions where id=$1',[baseline.id])).rows[0].snapshot.full_job_revision,frozen);
 });
 await check('failed validation leaves payload, counter and request log untouched; same key may retry after rollback',async()=>{
  const bad=structuredClone(w.payload);bad.sections[0].lines[0].actual_paid_ex_gst=999;const request=randomUUID();await assert.rejects(()=>save(bad,w.lock_version,request),/Accounting/);
  assert.equal((await owner.query('select count(*)::int n from job_revision_private.requests where request_id=$1',[request])).rows[0].n,0);
  assert.deepEqual((await admin.query('select * from job_revision_workspaces where id=$1',[w.id])).rows[0].payload,w.payload);
  w=(await save(w.payload,w.lock_version,request)).rows[0].r;
 });
 await check('wrong source/project and reused key with changed intent rejected',async()=>{
  await assert.rejects(()=>fork(randomUUID(),admin,'V4','c'.repeat(64)),/changed/);
  const request=randomUUID();await fork(request);await assert.rejects(()=>fork(request,admin,'Different label'),/identity conflict/);
  await assert.rejects(()=>admin.query('select save_job_revision($1,$2,$3,$4,$5,$6)',[randomUUID(),w.id,hash,w.lock_version,w.payload,randomUUID()]),/not found/);
 });
 await check('forged origins, foreign measurement links and mutated source rooms fail atomically',async()=>{
  for(const mutate of [p=>p.items[0].origin_id=randomUUID(),p=>p.items[0].measurement_id=randomUUID(),p=>p.rooms[0].name='Forged room',p=>p.approved_variations=[{id:randomUUID(),status:'approved',cost_ex_gst:50}]]){
   const bad=structuredClone(w.payload);mutate(bad);await assert.rejects(()=>save(bad),/identity|link|references|project-owned/);
  }
  assert.equal((await admin.query('select lock_version from job_revision_workspaces where id=$1',[w.id])).rows[0].lock_version,w.lock_version);
 });
 await check('accounting, payments and notification records untouched; complete payload round-trip',async()=>{
  assert.equal((await owner.query('select amount from invoices')).rows[0].amount,'123');assert.equal((await owner.query('select amount from payments')).rows[0].amount,'45');assert.equal((await owner.query('select count(*)::int n from notifications')).rows[0].n,0);
  assert.deepEqual(JSON.parse(JSON.stringify(w.payload)),w.payload);validatePayload(w.payload);
 });
 console.log(`${checks} real PostgreSQL revision checks passed.`);
}finally{await Promise.allSettled(clients.map(c=>c.end()));await cluster.stop().catch(()=>{});await rm(root,{recursive:true,force:true});}
