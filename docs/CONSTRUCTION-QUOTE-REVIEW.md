# Pre-contract construction quote review

23 October 2026. Verified execution host: Phillip's Mac Studio (Mac14,13 / Apple M2 Max). Base: origin/main 0252e3c. Isolated branch: feat/precontract-construction-quotes. Existing checkout and unrelated duplicate files were not changed.

## Behaviour

Admin estimate Versions panel now offers **New construction quote**, separately from frozen construction proposals. It creates an empty internal draft; it does not read or issue a SOW, read an estimate, populate Reddy pricing, queue AI drafting, email, invoice, or change project stage. No live records were created during development.

Quote fields: introduction, editable scope summary, AUD selling price excluding GST, payment breakdown/terms, assumptions, exclusions, terms and conditions, drawing identifiers/revisions. GST is 10%, calculated in integer cents. Detailed SOW follows agreement on price. Terms begin blank; no contract wording or compliance claim is seeded.

Uses the existing proposals table/content, admin editor shell, RESLU style tokens and ProposalPdf renderer. New kind is construction_quote. The editor uses explicit Save and Discard, hides preview until saved, protects repeated save clicks and retains edits after errors. Saves compare updated_at and draft status atomically. Creation retries use one UUID and return only a matching project/quote.

Canonical content is rebuilt from allowed quote fields on save and PDF rendering. Unknown financial metadata is rejected; no cost/supplier/markup source is fetched. Human-authored text must still be reviewed; arbitrary prose cannot be guaranteed free of internal information.

Send, resend, acceptance, public token page and the design drafting endpoint reject quotes. Kind changes through the general edit endpoint are rejected. Deposit stays zero. Existing construction release gate and frozen-version lifecycle are unchanged. Existing design edit path and PDFs remain supported.

## Files

- `lib/construction-quotes.ts`: field validation, selling/GST projection, distinct kind.
- `types/proposals.ts`: quote content type.
- `app/api/projects/[id]/construction-quotes/route.ts`: admin, retry-safe blank draft creation.
- `app/api/proposals/[id]/route.ts`: draft-only optimistic save and kind guard.
- `app/api/proposals/[id]/pdf/route.ts`: admin PDF rendering of canonical quote content.
- Existing send/resend/draft/accept routes and public proposal page: explicit quote holds.
- `components/proposals/ConstructionQuoteEditor.tsx`, `ConstructionQuotesSection.tsx`: editor/list/create UI.
- `components/estimate/VersionsPanel.tsx`, `ProposalEditor.tsx`: entry and dispatch.
- `components/pdf/ProposalPdf.tsx`: quote labels, draft basis, GST, no deposit/signature/design timeline.
- Existing proposal list and editor shell: correct private preview and neutral builder header.
- `scripts/test-construction-quotes.mjs`, `test-construction-quote-editor.mjs`, `render-construction-quote-review.mjs`: synthetic verification.
- `scripts/test-construction-routes.mjs`: new helper in regression mocks.

## Verified

- 28/28 pricing/lifecycle/route tests: `node --experimental-strip-types --test scripts/test-construction-quotes.mjs scripts/test-construction-routes.mjs lib/construction-proposals.test.ts lib/construction-lifecycle.test.ts`.
- DOM test (no browser): all fields editable, discard no write, repeated save locked, conflict preserves text, preview only saved state, no release actions.
- Synthetic quote/design/construction PDFs rendered through shared renderer. Quote extraction confirms ex-GST 125,000 + GST 12,500 = 137,500, drawings and revisions, no signature/deposit/design fee text. All three quote pages visually inspected.
- `tsc --noEmit` passed. Final `npm run build -- --webpack` passed.
- Feature TS/TSX lint passed. Changed-file lint reports one existing `react-hooks/set-state-in-effect` error at ProposalsSection.tsx:68, independently reproduced against HEAD. No unrelated hook refactor was made.
- `git diff --check` passed.

Evidence and logs: sibling `../evidence/quote-first/` (quote.pdf, design.pdf, construction.pdf, QA renders, tests.log, editor-test.log, build.log, feature-lint.log, baseline-lint.log).

DOM/PDF test tools are isolated in /tmp/reslu-quote-test-tools (esbuild 0.25.12, jsdom 26.1.0), configurable through ESBUILD_BINARY and JSDOM_PACKAGE. Application package/lockfile unchanged; dependencies installed with npm ci --ignore-scripts.

## Remaining gates and limitations

No browser sessions or foreground apps were touched. No live Supabase read/write, migration, policy change, push, PR, merge, deployment, invoice, email, issue or acceptance was performed. No Reddy T1 issue or live pricing edit.

Update 24 October: actual PostgreSQL integration verified persistence and concurrency and identified two direct-access release blockers. A subsequent local quote-only migration draft fixes both, verified by 13 quote and 16 construction PostgreSQL scenarios; deployment is still unapproved. See `CONSTRUCTION-QUOTE-DATABASE-REVIEW.md`. The original route suite uses an in-memory query double. Before deployment: test draft creation, stale save and PDF access against an isolated database with the actual proposals triggers/RLS; review existing direct Data API access. This change does not strengthen or relax existing database policies. Real authenticated HTTP/Auth/PostgREST/cookie verification passed six scenarios on 24 October; see the database review. Interactive browser UI verification remains pending an available session. No production release should be inferred from the successful build.

Client quote delivery and acceptance remain intentionally unavailable; implement/review their exact meaning, version binding and commercial wording separately before enabling. Payment terms are free text for pre-contract drafting, not a validated contractual stage schedule. The existing construction contract workflow still requires its issued scope/frozen estimate and reviewed release gate.

## Website typography and editor review — 24 October 2026

Verified live reslu.com.au HTML and website repository `phillip-cpu/reslu-site` at
`a00e5222032be04f18b0bbe92fcc88484b68b96c`, `src/styles/global.css`:
body and menu use `'Helvetica Neue Light','Helvetica Neue',Helvetica,Arial,sans-serif`.
Website headings use Cormorant Garamond; the requested replacement uses its **body text** stack.
Quote editor uses that stack; desktop fields use two columns, mobile one. Labels and
inputs are enlarged. Save/discard/conflict handling and API behaviour are unchanged.
Quote PDF uses standard PDF Helvetica/Helvetica-Bold, a declared website fallback.
No Helvetica Neue embedding licence or redistributable asset was established; no
OS font was copied or embedded. Exact Neue PDF embedding requires a licensed asset.
Other proposal kinds retain their existing display-font registration and styling.

`node scripts/render-construction-quote-editor.mjs` produces actual-component SSR
screenshots with synthetic fixtures using a separate headless Chrome and no network.
It does not use the visible browser or authenticate against a live service. Desktop
1280px and mobile 390px have no horizontal overflow. These screenshots demonstrate
layout; the DOM suite verifies edit/save/discard/concurrency interactions separately.
Review artifacts are under `../evidence/quote-first/` (synthetic PDF and editor PNGs).

Validation: editor DOM suite passed; 8 quote route tests passed; TypeScript passed;
changed-component ESLint passed. PDF inspection: 3 quote pages, Helvetica and
Helvetica-Bold only; design and construction PDFs still contain Cormorant. Visual
review of all quote pages and desktop editor passed. Previous authenticated HTTP
and database evidence remains applicable to unchanged API/DB code; no live UI QA
or production migration was performed for this change.

Webpack production build passed (log `../evidence/quote-first/typography-build.log`).
Library writeback could not start: helper discovery failed DNS under sandbox, then
TLS with authorised network access. Existing Library version remains unchanged;
local revised artifacts are ready for attachment. No fallback write was attempted.

## Isolated interactive browser QA

The actual Next application and disposable local Auth/PostgREST/Postgres are exercised
by `QUOTE_BROWSER_QA=1 node --experimental-strip-types scripts/test-construction-quote-http.mjs`.
`verify-construction-quote-browser.mjs` uses a separate headless Chrome profile and
blocks non-loopback browser requests. It never connects to Runway or the visible browser.
Checks cover real persisted save/reload, invalid selling price, discard, native refresh
cancellation, two-tab conflict retention, keyboard order/focus, responsive overflow,
no release controls and clean navigation back. Sidebar links now also ask before
leaving unsaved quote edits, since Next client navigation does not unload the page.
The fixture database intentionally omits unrelated app tables: Estimate → Versions
entry navigation and broader app integrations are not claimed as tested here.

Library delivery recovered using the supported individual owned-file actions after
helper discovery reported prepare_uploads unavailable (no transfer had started).
Revised PDF: `libfile_084df77a9f4481918b47e4cbcef22118`, version 1.
Editor preview: `libfile_370d313b1b348191b572c95fa4f022cb`, version 0.
Full authenticated editor screenshot: `libfile_53a38eb3d2a081918e71541b2b61a77f`, version 0.
Final browser run passed all six HTTP scenarios and sidebar cancellation, persisted
save/reload, negative-price validation, discard, refresh cancellation, two-tab
conflict protection, keyboard focus/order, desktop/mobile overflow, clean back
navigation and absence of send/accept/issue controls. Evidence:
`../evidence/quote-first/browser-integration.log`. DOM regression, targeted ESLint
and webpack production build also passed after the navigation fix.

## Estimate → Versions entry-path closure

Expanded the disposable database with `scripts/fixtures/quote-estimate-entry.sql`:
synthetic project estimate settings, an empty trade section, measurement/item/variation
relations and estimate-version listing fields. These are local test fixtures, not
production migrations; read policies restrict fixture tables to the synthetic admin.
No request/response mocks are used for the entry path.

Verified actual Estimate page → Versions tab → New construction quote (double click)
→ editor → save → Versions list → reopen. Both default Estimate and direct
`?view=versions` navigation work; estimate/variation/measurement/version API calls
return 200. Exactly one additional quote exists after the repeated click. Saved
scope persists on reopening. SOW and frozen estimate-version counts remain zero.
This closes the previously recorded Estimate entry-path limitation. Broader unrelated
app integrations remain outside this quote QA scope.
Final fuller-fixture run passed all HTTP and browser scenarios; evidence is
`../evidence/quote-first/entry-path-integration.log`. Synthetic stack destroyed after
verification. Ready for code/security review. Production release still requires
approval of the quote-authorisation migration and its existing profile-role-guard
prerequisite, merge approval, controlled deployment and post-deploy admin smoke QA.
Customer send/acceptance remain deliberately unsupported and fail closed.
