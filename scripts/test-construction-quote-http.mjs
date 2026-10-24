/** Actual Next HTTP + Supabase Auth/PostgREST + PostgreSQL. Local endpoints only. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createClient} from '@supabase/supabase-js';
import {createServerClient} from '@supabase/ssr';
import {quoteContent,emptyQuote} from '../lib/construction-quotes.ts';
const require=createRequire('/tmp/reslu-construction-db-deps/package.json');
const {Client}=require('pg');
const env=JSON.parse(await readFile('/tmp/reslu-quote-auth-credentials.json','utf8'));
const url=env.API_URL,dbUrl=env.DB_URL;
for(const u of [url,dbUrl])assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(u).hostname),'Local URLs only');
const service=createClient(url,env.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const db=new Client({connectionString:dbUrl});await db.connect();
let app;const project=randomUUID();let checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
try{
 await db.query(`create table profiles(id uuid primary key references auth.users(id),role text not null,full_name text);
 alter table profiles enable row level security;
 create policy read_profiles on profiles for select to authenticated using(true);
 create policy update_own_profile on profiles for update to authenticated using(auth.uid()=id);
 grant select,update on profiles to authenticated; grant all on profiles to service_role;
 create table projects(id uuid primary key,name text,alias text,address text,client_name text);
 create table leads(id uuid primary key);
 create table estimate_versions(id uuid primary key,project_id uuid references projects(id));
 create table sow_documents(id uuid primary key,project_id uuid references projects(id));
 create table client_contract_variations(id uuid primary key,project_id uuid references projects(id),amount_inc_gst numeric,label text,status text default 'active',deleted_at timestamptz);
 create extension if not exists pgcrypto;
 create function set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;`);
 const original=await readFile('supabase/migrations/051_proposals.sql','utf8');await db.query(original.slice(0,original.indexOf('-- PART 2 — email_sends')));
 await db.query('grant select,insert,update,delete on proposals to authenticated,service_role; grant select on proposals to anon; grant select on projects to authenticated,service_role;');
 for(const file of ['supabase/release-dependencies/reused_profile_role_guard.sql','supabase/migrations/20261013000008_construction_proposal_lifecycle.sql','supabase/migrations/20261024000458_construction_quote_authorisation.sql'])await db.query(await readFile(file,'utf8'));
 await db.query("insert into projects values($1,'SYNTHETIC QUOTE QA','SYNTHETIC', 'Not a real property','Synthetic Client')",[project]);
 if(process.env.QUOTE_BROWSER_QA==='1') {
  await db.query(await readFile('scripts/fixtures/quote-estimate-entry.sql','utf8'));
  await db.query("insert into cost_sections(project_id,name) values($1,'SYNTHETIC trade section')",[project]);
 }
 const sessions={};const creds={};
 for(const role of ['admin','designer']){
  const email=`synthetic-${role}-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('hex');
  const {data,error}=await service.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(error);
  await db.query('insert into profiles values($1,$2,$3)',[data.user.id,role,'SYNTHETIC '+role]);
  const client=createClient(url,env.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});const login=await client.auth.signInWithPassword({email,password});assert.ifError(login.error);sessions[role]={client,jwt:login.data.session.access_token};creds[role]={email,password};
 }
 await db.query("notify pgrst,'reload schema'");
 const appUrl='http://127.0.0.1:31847';
 app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','31847'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',RESLU_CONSTRUCTION_QUOTES_ENABLED:'1',NEXT_PUBLIC_SUPABASE_URL:url,NEXT_PUBLIC_SUPABASE_ANON_KEY:env.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:env.SERVICE_ROLE_KEY},stdio:['ignore','pipe','pipe']});
 let logs='';app.stdout.on('data',b=>logs+=b);app.stderr.on('data',b=>logs+=b);
 for(let i=0;i<100;i++){try{await fetch(appUrl+'/login');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 const api=(path,method='GET',body,role='admin',extra={})=>fetch(appUrl+path,{method,redirect:'manual',headers:{Authorization:'Bearer '+sessions[role].jwt,...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
 await check('actual HTTP create fails closed when migration readiness RPC is missing',async()=>{
  await db.query('alter function public.construction_quote_runtime_ready() rename to synthetic_temporarily_unavailable');
  await db.query("notify pgrst,'reload schema'");
  try {const r=await api(`/api/projects/${project}/construction-quotes`,'POST',{request_id:randomUUID()});assert.equal(r.status,503);assert.equal((await db.query('select count(*)::int n from proposals')).rows[0].n,0);}
  finally {await db.query('alter function public.synthetic_temporarily_unavailable() rename to construction_quote_runtime_ready');await db.query("notify pgrst,'reload schema'");
   let restored;for(let i=0;i<30;i++){restored=await sessions.admin.client.rpc('construction_quote_runtime_ready');if(restored.data===true&&!restored.error)break;await new Promise(r=>setTimeout(r,100));}assert.equal(restored.data,true,JSON.stringify(restored.error));}
 });
 let quote;
 await check('real GoTrue password sessions authorise admin and reject designer creation',async()=>{
  const r=await api(`/api/projects/${project}/construction-quotes`,'POST',{request_id:randomUUID()},'designer');assert.equal(r.status,403,await r.text());
  const id=randomUUID(),r1=await api(`/api/projects/${project}/construction-quotes`,'POST',{request_id:id});assert.equal(r1.status,201,await r1.clone().text());quote=(await r1.json()).proposal;
  const retry=await api(`/api/projects/${project}/construction-quotes`,'POST',{request_id:id});assert.equal(retry.status,200);assert.equal((await retry.json()).proposal.id,quote.id);
 });
 await check('HTTP save uses real PostgREST timestamp concurrency and GST',async()=>{
  const content=quoteContent({...emptyQuote(),price_ex_gst:1000.01,scope_summary:'SYNTHETIC work',drawing_references:'SYNTHETIC A102 / T1'});
  const rs=await Promise.all([api(`/api/proposals/${quote.id}`,'PATCH',{content,expected_updated_at:quote.updated_at}),api(`/api/proposals/${quote.id}`,'PATCH',{content,expected_updated_at:quote.updated_at})]);assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);quote=(await rs.find(r=>r.status===200).json()).proposal;assert.equal(Number(quote.total_inc),1100.01);
 });
 await check('real user JWTs cannot bypass RLS or lifecycle via REST',async()=>{
  const c=sessions.designer.client;const read=await c.from('proposals').select('*').eq('id',quote.id);assert.ifError(read.error);assert.deepEqual(read.data,[]);
  const update=await c.from('proposals').update({total_inc:1}).eq('id',quote.id).select();assert.ifError(update.error);assert.deepEqual(update.data,[]);
  const create=await c.from('proposals').insert({project_id:project,content:quoteContent(emptyQuote())});assert.ok(create.error);
  const tamper=await sessions.admin.client.from('proposals').update({content:{...quote.content,kind:'design'},status:'sent'}).eq('id',quote.id);assert.ok(tamper.error);
 });
 await check('admin cookie session works through real SSR authentication',async()=>{
  const jar=new Map();const c=createServerClient(url,env.ANON_KEY,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:items=>items.forEach(x=>jar.set(x.name,x.value))}});
  const login=await c.auth.signInWithPassword(creds.admin);assert.ifError(login.error);
  if(process.env.QUOTE_BROWSER_QA==='1') { const {verifyQuoteBrowser}=await import('./verify-construction-quote-browser.mjs');await verifyQuoteBrowser({appUrl,jar,quote,db,project}); }
  const r=await fetch(appUrl+`/api/proposals/${quote.id}`,{headers:{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')}});assert.equal(r.status,200);assert.equal((await r.json()).proposal.id,quote.id);
 });
 await check('PDF is admin-only; public quote token remains unavailable',async()=>{
  const r=await api(`/api/proposals/${quote.id}/pdf`);assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());assert.equal(bytes.subarray(0,4).toString(),'%PDF');await writeFile('../evidence/quote-first/authenticated-synthetic-quote.pdf',bytes);
  assert.equal((await api(`/api/proposals/${quote.id}/pdf`,'GET',undefined,'designer')).status,403);
  assert.equal((await fetch(appUrl+`/proposal/${quote.token}`)).status,404);
 });
 await check('send/resend/accept remain held through actual HTTP routes',async()=>{
  for(const action of ['send','resend'])assert.equal((await api(`/api/proposals/${quote.id}/${action}`,'POST',{})).status,409);
  const r=await fetch(appUrl+`/api/proposal/${quote.token}/accept`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({consent:true,typed_name:'Synthetic',drawn_data_url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='})});assert.equal(r.status,409,await r.text());
  assert.equal((await db.query('select count(*)::int n from construction_proposal_private.events')).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from construction_proposal_private.outbox')).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from sow_documents')).rows[0].n,0);
 });
 console.log(`PASS ${checks} real authenticated HTTP integration scenarios; native local Auth/PostgREST/PostgreSQL, synthetic only; browser checks run when QUOTE_BROWSER_QA=1.`);
 await writeFile('../evidence/quote-first/http-app.log',logs);
}finally{if(app){app.kill('SIGTERM');await new Promise(r=>app.once('exit',r));}await db.end();}
