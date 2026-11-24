import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Exercise the actual POST handler and classifiers, substituting only the
// external services and NextResponse wrapper. This test cannot write to Spec.
const fakeDbModule = 'reslu-intake-test:database';
const stateKey = 'reslu.website-intake-route.test';
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/supabase/server') {
      return { url: fakeDbModule, shortCircuit: true };
    }
    const mocks = {
      'next/server': 'export const NextRequest = Request; export const NextResponse = Response;',
      '@/lib/report-error': 'export function reportError(...args) { throw new Error(JSON.stringify(args)); }',
      '@/lib/storage': 'export const ASSET_BUCKET = "test"; export const slugFilename = s => s;',
    };
    if (Object.hasOwn(mocks, specifier)) {
      return { url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL('../' + specifier.slice(2) + '.ts', import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === fakeDbModule) {
      return {
        format: 'module',
        source: 'export const createServiceRoleClient = () => globalThis[Symbol.for(' +
          JSON.stringify(stateKey) + ')];',
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const { POST } = await import('../app/api/leads/intake/route.ts').finally(() => hooks.deregister());

const cases = [
  ['extension form / renovate', 'Design + Renovate', ['Extension'], 'extension'],
  ['extension form / build', 'Design + Build', ['Extension'], 'extension'],
  ['extension form / mixed', 'Design + Renovate', ['Extension', 'Kitchen'], 'whole_home_renovation'],
  ['extension form / whole home plus extension', 'Design + Build', ['Whole home', 'Extension'], 'whole_home_renovation'],
  ['extension form / no room submitted', 'Design + Renovate', [], 'whole_home_renovation'],
  ['extension form / room changed', 'Design + Renovate', ['Kitchen'], 'whole_home_renovation'],
  ['generic form / normalized extension only', 'Design + Renovate', [' Extension ', 'Extension'], 'extension', '/begin'],
  ['generic form / whole home', 'Design + Renovate', ['Whole home'], 'whole_home_renovation', '/begin'],
  ['explicit new build', 'New Build', ['Extension'], 'new_build'],
  ['explicit whole-home code', 'whole_home_renovation', ['Extension'], 'whole_home_renovation'],
  ['explicit bathroom type', 'Main bathroom renovation', ['Extension'], 'single_room_renovation', '/begin', 'bathroom'],
  ['explicit extension label', 'Rear addition', ['Kitchen', 'Extension'], 'extension'],
];

test('website intake classifies only unambiguous extension scope and preserves acquisition fields', async (t) => {
  const previousSecret = process.env.LEAD_INTAKE_SECRET;
  process.env.LEAD_INTAKE_SECRET = 'intake-local-test-only';
  const state = Symbol.for(stateKey);
  try {
    for (const [i, [name, projectType, rooms, expected, page = '/begin/extensions', subtype = null]] of cases.entries()) {
      await t.test(name, async () => {
        const inserted = [];
        globalThis[state] = {
          from(table) {
            assert.equal(table, 'leads');
            return {
              insert(row) {
                inserted.push(row);
                return { select: () => ({ single: async () => ({ data: { id: 'synthetic-lead' }, error: null }) }) };
              },
            };
          },
        };
        const request = new Request('http://localhost/api/leads/intake', {
          method: 'POST',
          headers: { authorization: 'Bearer intake-local-test-only', 'x-forwarded-for': 'test-' + i },
          body: JSON.stringify({
            type: 'lead', source: 'reslu.com.au/begin', email: 'test@example.invalid',
            first_name: 'Test', last_name: 'Lead', project_type: projectType, rooms, page,
            gclid: 'test-gclid', utm_source: 'google', utm_medium: 'cpc',
            utm_campaign: 'test-campaign', utm_content: 'test-ad', utm_term: 'home extension',
            attribution_landing_page: page + '?utm_source=google',
          }),
        });
        const response = await POST(request);
        assert.equal(response.status, 201);
        assert.equal((await response.json()).lead_id, 'synthetic-lead');
        assert.equal(inserted.length, 1);
        const [row] = inserted;
        assert.equal(row.project_type_code, expected);
        assert.equal(row.project_subtype, subtype);
        assert.equal(row.project_type, projectType);
        assert.deepEqual(row.rooms, [...new Set(rooms.map(room => room.trim()))]);
        assert.equal(row.page, page);
        assert.equal(row.gclid, 'test-gclid');
        assert.equal(row.utm_source, 'google');
        assert.equal(row.utm_medium, 'cpc');
        assert.equal(row.utm_campaign, 'test-campaign');
        assert.equal(row.utm_content, 'test-ad');
        assert.equal(row.utm_term, 'home extension');
        assert.equal(row.attribution_landing_page, page);
      });
    }
  } finally {
    delete globalThis[state];
    if (previousSecret === undefined) delete process.env.LEAD_INTAKE_SECRET;
    else process.env.LEAD_INTAKE_SECRET = previousSecret;
  }
});
