/** Synthetic PDF evidence through the existing ProposalPdf renderer. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const target = resolve('.construction-pdf-qa.cjs');
try {
  execFileSync(process.env.ESBUILD_BINARY || '/tmp/reslu-construction-test-deps/node_modules/esbuild/bin/esbuild', ['--bundle', '--packages=external', '--platform=node', '--format=cjs', '--jsx=automatic', '--loader=tsx', `--outfile=${target}`], { input: 'export {ProposalPdf} from "./components/pdf/ProposalPdf"; export {buildConstructionContent} from "./lib/construction-proposals"; export {fixture} from "./lib/construction-proposals.fixture";', stdio: ['pipe', 'inherit', 'inherit'] });
  const { ProposalPdf, buildConstructionContent, fixture } = createRequire(import.meta.url)(target);
  const { renderToBuffer } = await import('@react-pdf/renderer');
  const content = buildConstructionContent(fixture());
  const proposal = { id: 'synthetic-construction-version', status: 'draft', content, total_inc: content.construction.total_inc, deposit_inc: content.construction.payments[0].amount_inc, signature: null };
  const bytes = await renderToBuffer(ProposalPdf({ proposal, residence: 'Synthetic Residence', address: 'Example address for local testing', clientName: 'Synthetic Client', coverDateLabel: 'INTERNAL REVIEW DRAFT — NOT ISSUED', signedDateLabel: '' }));
  await mkdir(resolve('../evidence'), { recursive: true });
  await writeFile(resolve('../evidence/construction-preview.pdf'), bytes);
  console.log(`Rendered ${bytes.length} bytes using existing ProposalPdf; synthetic data only.`);
} finally { await rm(target, { force: true }); }
