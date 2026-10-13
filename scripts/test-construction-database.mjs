/** Real PostgreSQL in a disposable /tmp cluster. No external DB URLs accepted.
 * Install pinned embedded-postgres@18.4.0-beta.17 and pg@8.16.3 under
 * /tmp/reslu-construction-db-deps; hydrate its platform symlinks before running.
 * All accounts/passwords below exist only inside the disposable synthetic DB.
 */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { buildConstructionContent, buildConstructionVariation } from '../lib/construction-proposals.ts';
import { issueConstructionVersion, respondConstructionVersion } from '../lib/construction-lifecycle.ts';
import { fixture } from '../lib/construction-proposals.fixture.ts';
const deps = createRequire('/tmp/reslu-construction-db-deps/package.json');
const { default: EmbeddedPostgres } = await import(deps.resolve('embedded-postgres'));
const { Client } = deps('pg');
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
  const admin=await connect('authenticated',adminId), designer=await connect('authenticated',designerId), anon=await connect('anon');
  const service=await connect('service_role'), service2=await connect('service_role');
  function content(previous) {
    const f=fixture(); f.version.id=version;f.version.project_id=project;f.sow.id=sow;f.sow.project_id=project;
    f.selection.estimate_version_id=version;f.selection.sow_id=sow;
    return buildConstructionContent({...f,previous});
  }
  async function draft(c=content(),db=admin) {
    return (await db.query(`insert into proposals(id,project_id,content,total_inc,deposit_inc) values($1,$2,$3,$4,$5) returning *`,[randomUUID(),project,c,c.construction.total_inc,c.construction.payments[0]?.amount_inc ?? 0])).rows[0];
  }
  const rpcDb=db=>({rpc:async(name,args)=>{
    const keys=name==='issue_construction_proposal'?['p_project','p_proposal','p_digest','p_request','p_actor']:['p_project','p_proposal','p_token','p_digest','p_request','p_decision','p_evidence'];
    try{return {data:(await db.query(`select ${name}(${keys.map((_,i)=>'$'+(i+1)).join(',')}) result`,keys.map(k=>args[k]))).rows[0].result,error:null};}catch(e){return {data:null,error:{message:e.message}};}
  }});
  const issue=async(p,request=randomUUID(),db=service,overrides={})=>({rows:[{result:await issueConstructionVersion(rpcDb(db),{projectId:overrides.project??project,proposalId:p.id,digest:overrides.digest??p.construction_version_digest,requestId:request,actorId:overrides.actor??adminId})}]});
  const evidence={typed_name:'Synthetic Client',consent:true,drawn_data_url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',ip:'127.0.0.1',user_agent:'synthetic integration test'};
  const respond=async(p,request=randomUUID(),db=service,overrides={})=>({rows:[{result:await respondConstructionVersion(rpcDb(db),{projectId:overrides.project??project,proposalId:p.id,token:overrides.token??p.token,digest:overrides.digest??p.construction_version_digest,requestId:request,decision:overrides.decision??'accepted',evidence:overrides.evidence??evidence})}]});
  let first;
  await check('migration is repeatable, server digest is calculated, defaults deny release',async()=>{
    first=await draft();assert.match(first.construction_version_digest,/^[a-f0-9]{64}$/);
    await assert.rejects(()=>issue(first),/release is disabled/);
    await assert.rejects(()=>respond(first),/release is disabled/);
    assert.equal((await owner.query('select count(*)::int n from construction_proposal_private.events')).rows[0].n,0);
  });
  await check('RLS hides construction financial rows; own profile cannot grant admin; RPC/private tables denied',async()=>{
    assert.equal((await designer.query('select * from proposals')).rows.length,0);
    assert.equal((await anon.query('select * from proposals')).rows.length,0);
    assert.equal((await admin.query('select * from proposals')).rows.length,1);
    await assert.rejects(()=>draft(content(),designer),/Admin access|row-level security/);
    await assert.rejects(()=>designer.query("update profiles set role='admin' where id=$1",[designerId]),/existing administrator/);
    await assert.rejects(()=>designer.query('set role service_role'),/permission denied/);
    await assert.rejects(()=>issue(first,randomUUID(),admin),/permission denied/);
    await assert.rejects(()=>respond(first,randomUUID(),anon),/permission denied/);
    await assert.rejects(()=>service.query('update construction_proposal_private.release_gate set enabled=true'),/permission denied/);
    await assert.rejects(()=>service.query('insert into construction_proposal_private.transition_claims values(txid_current(),$1)',[first.id]),/permission denied/);
  });
  await check('content, totals, ownership, token, digest and deletion resist direct tampering even by service role',async()=>{
    for(const [sql,params] of [
      ["update proposals set content=jsonb_set(content,'{letter}','\"tampered\"') where id=$1",[first.id]],
      ['update proposals set total_inc=1 where id=$1',[first.id]],
      ['update proposals set project_id=$2 where id=$1',[first.id,otherProject]],
      ["update proposals set token='replacement' where id=$1",[first.id]],
      ["update proposals set construction_version_digest='forged' where id=$1",[first.id]],
      ["update proposals set status='accepted' where id=$1",[first.id]],
      ['delete from proposals where id=$1',[first.id]],
    ]) await assert.rejects(()=>service.query(sql,params),/immutable|atomic|cannot be deleted/);
    await service.query("select set_config('construction.transition','accepted',false)");
    await assert.rejects(()=>service.query("update proposals set status='sent' where id=$1",[first.id]),/atomic/);
  });
  await check('invalid totals, 95.5%, injected cost/margin and cross-project sources rejected in SQL',async()=>{
    for(const mutate of [c=>c.construction.payments[0].percentage=.5,c=>c.construction.total_inc=1,c=>c.construction.gst=null,c=>c.construction.prices[0].cost_ex_gst=80,c=>c.fees.stages[0].margin=20,c=>c.construction.estimate_version_id=randomUUID()]) {
      const c=content();mutate(c);await assert.rejects(()=>draft(c));
    }
    const c=content();c.construction.sow_id=randomUUID();await assert.rejects(()=>draft(c),/sources/);
    const stored=(await admin.query('select content from proposals where id=$1',[first.id])).rows[0].content;
    assert.doesNotMatch(JSON.stringify(stored),/SECRET-SUPPLIER|cost_ex_gst|markup|margin|actual_paid/);
  });
  // This affects only this disposable synthetic DB. No app flag can enable it.
  await owner.query('update construction_proposal_private.release_gate set enabled=true');
  await check('issue requires verified admin, exact project and version; replay is idempotent',async()=>{
    await assert.rejects(()=>issue(first,randomUUID(),service,{actor:designerId}),/Admin actor/);
    await assert.rejects(()=>issue(first,randomUUID(),service,{project:otherProject}),/Invalid construction/);
    await assert.rejects(()=>issue(first,randomUUID(),service,{digest:'wrong'}),/Invalid construction/);
    const request=randomUUID();const a=await issue(first,request);const b=await issue(first,request);
    assert.equal(a.rows[0].result.event_id,b.rows[0].result.event_id);assert.equal(b.rows[0].result.reused,true);
  });
  let second;
  await check('issuing a revision atomically supersedes the exact sent original; old token cannot approve',async()=>{
    const prior=(await admin.query('select * from proposals where id=$1',[first.id])).rows[0];
    second=await draft(content(prior));await issue(second);
    assert.equal((await admin.query('select status from proposals where id=$1',[first.id])).rows[0].status,'closed');
    await assert.rejects(()=>respond(first),/not available/);
  });
  await check('approval rejects token swapping, digest tampering, cross-project and missing consent',async()=>{
    for(const overrides of [{token:first.token},{project:otherProject},{digest:first.construction_version_digest},{evidence:{...evidence,consent:false}},{evidence:{...evidence,margin:100}}]) await assert.rejects(()=>respond(second,randomUUID(),service,overrides));
    await assert.rejects(()=>service.query("update proposals set signature=$2 where id=$1",[second.id,evidence]),/atomic/);
  });
  let acceptedReceipt;
  await check('two real connections contend on approval: one winner, one immutable receipt and held outbox record',async()=>{
    const request=randomUUID();
    await service.query('begin');const winner=await respond(second,request,service);
    let completed=false;
    const waiting=respond(second,request,service2).then(r=>{completed=true;return r;});
    // Verify PostgreSQL sees an actual lock wait, not an in-memory mock/serial queue.
    let lockSeen=false;
    for(let i=0;i<50;i++) {
      const r=await owner.query("select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like 'select respond_construction_proposal%'");
      if(r.rows[0].n>0){lockSeen=true;break;} await new Promise(r=>setTimeout(r,10));
    }
    assert.equal(lockSeen,true);assert.equal(completed,false);
    await service.query('commit');const replay=await waiting;
    acceptedReceipt=winner.rows[0].result;
    assert.equal(replay.rows[0].result.event_id,acceptedReceipt.event_id);assert.equal(replay.rows[0].result.reused,true);
    assert.equal((await owner.query("select count(*)::int n from construction_proposal_private.events where proposal_id=$1 and action='accepted'",[second.id])).rows[0].n,1);
    assert.equal((await owner.query('select count(*)::int n from construction_proposal_private.outbox')).rows[0].n,1);
    await assert.rejects(()=>respond(second,request,service,{evidence:{...evidence,typed_name:'Someone else'}}),/Conflicting lifecycle replay/);
    await assert.rejects(()=>respond(second),/not available/);
  });
  await check('accepted document/evidence cannot be rewritten; history projection excludes signatures, IP and token',async()=>{
    await assert.rejects(()=>service.query("update proposals set signed_name='Changed' where id=$1",[second.id]),/atomic/);
    await assert.rejects(()=>owner.query("update construction_proposal_private.events set evidence='{}' where id=$1",[acceptedReceipt.event_id]),/append-only/);
    await assert.rejects(()=>owner.query('delete from construction_proposal_private.outbox'),/append-only/);
    const h=(await service.query('select construction_proposal_history($1,$2) h',[project,second.id])).rows[0].h;
    assert.equal(h.filter(e=>e.action==='accepted').length,1);
    assert.doesNotMatch(JSON.stringify(h),/drawn_data_url|127.0.0.1|user_agent|token|cost_ex_gst/);
    assert.deepEqual((await service.query('select construction_proposal_history($1,$2) h',[otherProject,second.id])).rows[0].h,[]);
    await assert.rejects(()=>issue(first),/Only a draft/);
    await assert.rejects(()=>draft({...content(),construction:{...content().construction,previous_proposal_id:second.id}}),/accepted originals/);
  });
  let variation;
  await check('variation binds immutable accepted original plus package and explicit price/time effects',async()=>{
    const base=(await admin.query('select * from proposals where id=$1',[second.id])).rows[0];
    const pack={id:randomUUID(),project_id:project,label:'Extra door',amount_inc_gst:1100};
    await owner.query('insert into client_contract_variations(id,project_id,label,amount_inc_gst) values($1,$2,$3,$4)',[pack.id,project,pack.label,pack.amount_inc_gst]);
    const c=buildConstructionVariation({base,baseDigest:base.construction_version_digest,sourceDigest:'synthetic',package:pack,description:'Add door',time_effect_days:2,time_effect_note:'Two extra working days'});
    variation=await draft(c);await issue(variation);
    const tampered=structuredClone(c);tampered.construction.variation.accepted_version_digest='wrong';await assert.rejects(()=>draft(tampered),/accepted original version/);
    const noTime=structuredClone(c);delete noTime.construction.variation.time_effect_days;await assert.rejects(()=>draft(noTime),/time effect/);
    assert.equal((await admin.query('select total_inc from proposals where id=$1',[second.id])).rows[0].total_inc,'352.00');
  });
  await check('concurrent edit versus approval cannot change displayed variation content',async()=>{
    await service.query('begin');await service.query('select id from proposals where id=$1 for update',[variation.id]);
    const approval=respond(variation,randomUUID(),service2);
    await assert.rejects(()=>service.query("update proposals set content=jsonb_set(content,'{letter}','\"changed\"') where id=$1",[variation.id]),/immutable/);
    await service.query('rollback');await approval;
    assert.equal((await admin.query('select content->>\'letter\' letter from proposals where id=$1',[variation.id])).rows[0].letter,variation.content.letter);
  });
  await check('failed evidence/outbox transaction rolls back acceptance completely',async()=>{
    const base=(await admin.query('select * from proposals where id=$1',[second.id])).rows[0];
    const pack={id:randomUUID(),project_id:project,label:'Window',amount_inc_gst:220};
    await owner.query('insert into client_contract_variations(id,project_id,label,amount_inc_gst) values($1,$2,$3,$4)',[pack.id,project,pack.label,pack.amount_inc_gst]);
    const c=buildConstructionVariation({base,baseDigest:base.construction_version_digest,sourceDigest:'synthetic',package:pack,description:'Window',time_effect_days:0,time_effect_note:'No change'});
    const p=await draft(c);await issue(p);
    await owner.query("create function construction_proposal_private.fail_outbox() returns trigger language plpgsql as $$begin raise exception 'synthetic outbox fault';end$$;create trigger test_fail before insert on construction_proposal_private.outbox for each row execute function construction_proposal_private.fail_outbox()");
    await assert.rejects(()=>respond(p),/synthetic outbox fault/);
    assert.equal((await admin.query('select status,signature from proposals where id=$1',[p.id])).rows[0].status,'sent');
    assert.equal((await owner.query("select count(*)::int n from construction_proposal_private.events where proposal_id=$1 and action='accepted'",[p.id])).rows[0].n,0);
    await owner.query('drop trigger test_fail on construction_proposal_private.outbox');
    const request=randomUUID();await respond(p,request,service,{decision:'declined',evidence:{typed_name:'Synthetic Client',note:'Do not proceed'}});
    assert.equal((await admin.query('select status from proposals where id=$1',[p.id])).rows[0].status,'closed');
    await assert.rejects(()=>respond(p),/not available/);
  });
  await check('gate cannot be bypassed after shutdown; no public definer and no unintended execute grants',async()=>{
    await owner.query('update construction_proposal_private.release_gate set enabled=false');
    await assert.rejects(()=>respond(second),/release is disabled/);
    const functions=(await owner.query("select p.proname,p.prosecdef,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('issue_construction_proposal','respond_construction_proposal','construction_proposal_history')")).rows;
    assert.equal(functions.length,3);assert.ok(functions.every(f=>!f.prosecdef&&!f.anon&&!f.authenticated));
    assert.equal((await owner.query('select count(*)::int n from construction_proposal_private.transition_claims')).rows[0].n,0);
  });
  await check('room heading override is local, reversible, valid and immutable after scope issue',async()=>{
    await owner.query("alter table sow_documents add column status text default 'draft';create table sow_sections(id uuid primary key,sow_id uuid references sow_documents(id));");
    const headingSql=await readFile('supabase/migrations/20261013000529_sow_trade_display_heading_overrides.sql','utf8');await apply(headingSql);await apply(headingSql);
    const a=randomUUID(),b=randomUUID(),trade='Timber Floor Laying & Sanding';
    await owner.query('insert into sow_sections(id,sow_id) values($1,$3),($2,$3)',[a,b,sow]);
    const set=value=>owner.query('update sow_sections set trade_heading_overrides=$2 where id=$1',[a,JSON.stringify(value)]);
    await set({[trade]:'Timber Floor Laying'});
    assert.deepEqual((await owner.query('select trade_heading_overrides h from sow_sections where id=$1',[b])).rows[0].h,{});
    await set({});await set({[trade]:'Timber Floor Laying'});
    for(const invalid of [{[trade]:''},{constructor:'x'},['x'],{[trade]:'x\ny'}])await assert.rejects(()=>set(invalid),/Invalid trade|must be an object/);
    await owner.query("update sow_documents set status='issued' where id=$1",[sow]);
    await assert.rejects(()=>set({}),/immutable/);
    assert.equal((await owner.query('select trade_heading_overrides h from sow_sections where id=$1',[a])).rows[0].h[trade],'Timber Floor Laying');
  });
  console.log(`PASS ${checks} real PostgreSQL integration scenarios; independent-connection lock contention verified; release gate disabled.`);
} finally {
  await Promise.allSettled(clients.map(c=>c.end()));
  await cluster.stop().catch(()=>{});
  await rm(root,{recursive:true,force:true});
  console.log('Disposable cluster stopped and removed. No external database was contacted.');
}
