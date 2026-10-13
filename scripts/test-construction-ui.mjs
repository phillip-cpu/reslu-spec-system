/** Headless isolated Chrome; actual React components, synthetic API only.
 * Uses the host's existing esbuild binary and bundled Playwright; override paths
 * with ESBUILD_BINARY, PLAYWRIGHT_PACKAGE and CHROME_BINARY when needed.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '/Users/phillip/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const scratch = await mkdtemp(join(tmpdir(), 'construction-ui-'));
let browser, server;
try {
  await writeFile(join(scratch, 'navigation.js'), 'export function useRouter(){return {push:p=>{window.testPaths.push(p)}}}');
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {ConstructionProposalBuilder} from './components/proposals/ConstructionProposalBuilder';import {TradeDisplayHeadingEditor} from './components/sow/TradeDisplayHeadingEditor';window.testPaths=[];window.testPosts=[];window.failNext=false;window.fetch=async(url,options={})=>{if(options.method==='POST'){window.testPosts.push(JSON.parse(options.body));await new Promise(r=>window.releasePost=r);const fail=window.failNext;window.failNext=false;return {ok:!fail,json:async()=>fail?{error:'Source changed while reviewing. Reload.'}:{proposal:{id:'frozen-version'}}}}return {ok:true,json:async()=>String(url).includes('/construction-proposals?')?{source_digest:'digest',prices:[{key:'section:a',label:'Kitchen',selling_ex_gst:100}],scope:[{id:'scope-a',heading:'Kitchen scope'}]}:String(url).includes('/sow')?{sow_documents:[{id:'sow-a',revision_label:'S1',status:'issued'}]}:{proposals:[]}}};let root;window.mount=()=>{root=createRoot(document.getElementById('root'));root.render(<ConstructionProposalBuilder projectId='synthetic' versions={[{id:'version-a',label:'A'}]}/>)};window.back=()=>{root.unmount();window.mount()};window.mount();window.mountHeading=()=>{root.unmount();root=createRoot(document.getElementById('root'));window.headingSaves=[];function Heading(){const [heading,setHeading]=React.useState('Timber Floor Laying & Sanding');return <><TradeDisplayHeadingEditor trade='Timber Floor Laying & Sanding' heading={heading} overridden={heading!=='Timber Floor Laying & Sanding'} onSave={async value=>{window.headingSaves.push(value);await new Promise(r=>window.releaseHeading=r);if(window.headingFail){window.headingFail=false;throw Error('Section changed. Reload.')}setHeading(value??'Timber Floor Laying & Sanding')}}/><p>Other room: Timber Floor Laying & Sanding</p></>};root.render(<Heading/>)};`;
  execFileSync(process.env.ESBUILD_BINARY || '/tmp/reslu-construction-test-deps/node_modules/esbuild/bin/esbuild', ['--bundle','--platform=browser','--jsx=automatic','--loader=tsx',`--alias:next/navigation=${join(scratch, 'navigation.js')}`,`--outfile=${join(scratch, 'test.js')}`], { input: entry });
  server = createServer(async (req, res) => {
    res.setHeader('Content-Type', req.url === '/test.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/test.js' ? await readFile(join(scratch, 'test.js')) : '<!doctype html><html><body><div id="root"></div><script src="/test.js"></script></body></html>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: 'Prepare construction proposal' }).click();
  await page.getByLabel('Saved estimate').selectOption('version-a'); await page.getByLabel('Issued scope').selectOption('sow-a');
  await page.getByRole('button', { name: 'Review source prices' }).click();
  await page.getByLabel('Classify Kitchen').selectOption('internal'); await page.getByLabel('Scope Kitchen scope').selectOption('internal');
  await page.getByLabel('Stage 1 percentage').fill('95.5');
  assert.match(await page.locator('body').innerText(), /4.5% unallocated/);
  assert.equal(await page.getByRole('button', { name: 'Generate frozen draft' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => window.testPosts.length), 0);
  await page.getByRole('button', { name: 'Prepare construction proposal' }).click();
  assert.equal(await page.getByRole('button', { name: 'Generate frozen draft' }).count(), 0);
  await page.getByRole('button', { name: 'Review source prices' }).click();
  await page.getByLabel('Classify Kitchen').selectOption('internal'); await page.getByLabel('Scope Kitchen scope').selectOption('internal');
  await page.getByLabel('Stage 1 percentage').fill('100');
  await page.evaluate(() => { window.failNext = true; const b = [...document.querySelectorAll('button')].find(b => b.textContent === 'Generate frozen draft'); b.click(); b.click(); });
  assert.equal(await page.evaluate(() => window.testPosts.length), 1);
  await page.evaluate(() => window.releasePost());
  await page.getByRole('alert').filter({ hasText: 'Source changed' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.testPaths), []);
  await page.getByRole('button', { name: 'Generate frozen draft' }).click();
  await page.evaluate(() => window.releasePost());
  await page.waitForFunction(() => window.testPaths.length === 1);
  assert.deepEqual(await page.evaluate(() => window.testPaths), ['/proposals/frozen-version']);
  await page.evaluate(() => window.back());
  await page.getByRole('button', { name: 'Prepare construction proposal' }).waitFor();
  assert.equal(await page.evaluate(() => window.testPosts.length), 2);
  await page.evaluate(()=>window.mountHeading());
  await page.getByRole('button',{name:'Timber Floor Laying & Sanding',exact:true}).click();
  await page.getByLabel('Trade display heading').fill('Timber Floor Laying');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.headingSaves.length),0);
  await page.getByRole('button',{name:'Timber Floor Laying & Sanding',exact:true}).click();
  await page.getByLabel('Trade display heading').fill('Timber Floor Laying');
  await page.evaluate(()=>{window.headingFail=true;const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Save heading');b.click();b.click();});
  assert.equal(await page.evaluate(()=>window.headingSaves.length),1);
  await page.evaluate(()=>window.releaseHeading());await page.getByRole('alert').waitFor();
  await page.getByRole('button',{name:'Save heading',exact:true}).click();await page.evaluate(()=>window.releaseHeading());
  await page.getByRole('button',{name:'Timber Floor Laying',exact:true}).waitFor();
  assert.match(await page.locator('body').innerText(),/Other room: Timber Floor Laying & Sanding/);
  await page.getByRole('button',{name:'Timber Floor Laying',exact:true}).click();
  await page.getByRole('button',{name:'Reset heading',exact:true}).click();await page.evaluate(()=>window.releaseHeading());
  await page.getByRole('button',{name:'Timber Floor Laying & Sanding',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.headingSaves),['Timber Floor Laying','Timber Floor Laying',null]);
  console.log('PASS: actual heading editor cancel, repeated click, conflict, retry, room isolation and reset.');
  assert.deepEqual(errors, []);
  console.log('PASS: actual component cancel/back, 95.5% block, source conflict, repeat click, successful navigation; isolated Chrome, synthetic requests only.');
} finally {
  await browser?.close(); if (server) await new Promise(r => server.close(r)); await rm(scratch, { recursive: true, force: true });
}
