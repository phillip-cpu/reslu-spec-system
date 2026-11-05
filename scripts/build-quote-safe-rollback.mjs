/** Builds and checks a compatibility patch; does not modify any checkout or deploy. */
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const base='0252e3c9a0ad9c8acc1fc944b89311f1c4ddb756';
const retained=['app/proposal/[token]/page.tsx','app/api/proposal/[token]/accept/route.ts','app/api/proposals/[id]/send/route.ts','app/api/proposals/[id]/resend/route.ts','app/api/proposals/[id]/draft/route.ts','app/api/proposals/[id]/route.ts','app/api/proposals/[id]/pdf/route.ts','lib/construction-quotes.ts','lib/construction-quote-access.ts','types/proposals.ts'];
const dir=mkdtempSync(join(tmpdir(),'reslu-quote-rollback-'));
try {
 execFileSync('tar',['-x','-C',dir],{input:execFileSync('git',['archive',base],{maxBuffer:64*1024*1024})});
 // Include uncommitted reviewed local fixes too; no shell interpolation.
 const artifact=resolve('../evidence/quote-first/quote-safe-rollback.patch');
 let patch='';
 for(const p of retained){
  let exists=true,original;try{original=execFileSync('git',['show',base+':'+p],{stdio:['ignore','pipe','ignore']});}catch{exists=false;original=Buffer.alloc(0);}
  const before=join(dir,'before');writeFileSync(before,original);
  try{execFileSync('diff',['-u','--label',exists?'a/'+p:'/dev/null','--label','b/'+p,before,p]);}catch(e){if(e.status!==1)throw e;patch+=e.stdout.toString();}
 }
 writeFileSync(artifact,patch);
 execFileSync('git',['apply','--check',artifact],{cwd:dir});
 execFileSync('git',['apply',artifact],{cwd:dir});
 execFileSync(process.execPath,['--test','--test-name-pattern=quote send|public quote','scripts/test-construction-quotes.mjs'],{env:{...process.env,QUOTE_ROLLBACK_ROOT:dir},stdio:'inherit'});
 // Confirm sensitive quote paths remain in this old-UI compatibility source.
 for(const p of retained.filter(p=>p.startsWith('app/')))if(!readFileSync(join(dir,p),'utf8').includes('isConstructionQuote'))throw Error('Missing quote guard: '+p);
 console.log('PASS rollback compatibility source retains all quote guards; patch: '+artifact);
 console.log('Required deployment env: RESLU_CONSTRUCTION_QUOTES_ENABLED unset; retain database migration/policies/triggers.');
}finally{rmSync(dir,{recursive:true,force:true});}
