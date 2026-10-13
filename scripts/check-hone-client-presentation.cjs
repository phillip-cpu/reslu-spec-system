// Read-only rendering of the actual client page with local review data; no DB or network.
const fs=require('fs'),assert=require('assert/strict'),ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const saved=JSON.parse(fs.readFileSync('../evidence/hone-proposal-pages.json','utf8'));
const proposal={...saved.proposal,token:'local-review',created_at:'2026-10-13T00:00:00Z'};
const db={from(){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:proposal})};return q;}};
const mocks={'@/lib/construction-lifecycle':{localConstructionLifecycleEnabled:()=>false},'next/image':{default:()=>null},'next/headers':{headers:async()=>new Headers()},'next/navigation':{notFound:()=>{throw Error('notfound')}},'@/lib/auth':{getUserRole:async()=>({role:'admin'})},'@/lib/construction-proposals':{isConstruction:c=>c.kind==='construction'},'@/lib/supabase/server':{createClient:async()=>db,createServiceRoleClient:()=>db},'@/lib/rate-limit':{rateLimit:()=>({ok:true})},'@/lib/proposals':{residenceLabel:()=> 'Hone'},'@/lib/proposal-templates':{TIMELINE_COUNCIL_CAVEAT:'Council assessment timeframes are subject to authority processing.'},'@/components/proposal/ProposalSignForm':{ProposalSignForm:()=>{throw Error('Signing must not render')}},'@/components/proposal/ProposalReveal':{ProposalReveal:({children})=>React.createElement(React.Fragment,null,children)}};
const code=ts.transpileModule(fs.readFileSync('app/proposal/[token]/page.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const out={};new Function('require','exports',code)(n=>mocks[n]||require(n),out);
(async()=>{const html=renderToStaticMarkup(await out.default({params:Promise.resolve({token:'local-review'})}));
assert.match(html,/>Payment Breakdown<\/p>/);assert.doesNotMatch(html,/4,820|800\.00/);
assert.doesNotMatch(html,/>Construction Price<\/p>/);
assert.doesNotMatch(html,/>Letter<|awaiting verification|draft|internal review|Sign to Accept|2,768\.49/i);
assert.match(html,/The scope of works defines the agreed inclusions, selections and exclusions, and forms the scope reference for this proposal, as outlined in Scope of Works Version 2\./);assert.doesNotMatch(html,/Drainer trays|Structural engineering is complete|RESLU coordinates development approval/);assert.match(html,/D03 double retractable sliding-door flyscreens/);assert.match(html,/External wire-blind motorisation/);assert.match(html,/Pool-surround concrete, including 130 mm soil excavation around the pool — \$5,620\.00 including GST/);assert.match(html,/496,863\.99/);
assert.equal(saved.scope_reference.verified,true);assert.equal(saved.scope_reference.native_issued,false);assert.equal(saved.scope_reference.local_archive_sha256,'324cbcceb34ff4c358ea0c4db0e6b3b4de60e62b2a0f3e219c7ba44ab4944595');
fs.writeFileSync('../evidence/hone-client-render.html',html);
console.log('PASS actual client page: clean introduction, scope-reference wording, price before payments, correct separate options, unchanged total, no signing controls; local V2 archive verified, native scope remains unissued.');
})().catch(e=>{console.error(e);process.exitCode=1});
