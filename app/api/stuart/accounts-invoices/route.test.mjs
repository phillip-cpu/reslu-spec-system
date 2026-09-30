import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Execute the real route with mocked persistence and invoice processors.
// Neither Supabase nor Xero clients are loaded or contacted by these tests.
const root = process.env.ACCOUNTS_CRON_SOURCE_ROOT ?? resolve(import.meta.dirname, "../../../..");
const require = createRequire(resolve(root, "package.json"));
const ts = require("typescript");
const { NextRequest, NextResponse } = require("next/server");

function loadSource(path, dependencies, environment) {
  const source = readFileSync(resolve(root, path), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const compiledModule = { exports: {} };
  runInNewContext(compiled, {
    Error,
    module: compiledModule,
    exports: compiledModule.exports,
    process: { env: environment },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected live dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return compiledModule.exports;
}

function harness({ user = null, rows = [], queryError = null, secret = "test-cron-secret", outcomes = {} } = {}) {
  const events = { auth: 0, service: 0, query: [], processed: [] };
  const query = {};
  for (const method of ["select", "contains", "in", "not", "order", "limit"]) {
    query[method] = (...args) => {
      events.query.push([method, ...structuredClone(args)]);
      return method === "limit" ? Promise.resolve({ data: rows, error: queryError }) : query;
    };
  }
  const access = loadSource("lib/stuart/access.ts", {}, { CRON_SECRET: secret });
  const route = loadSource("app/api/stuart/accounts-invoices/route.ts", {
    "next/server": { NextRequest, NextResponse },
    "@/lib/stuart/access": access,
    "@/lib/supabase/server": {
      async createClient() {
        events.auth += 1;
        return { auth: { async getUser() { return { data: { user } }; } } };
      },
      createServiceRoleClient() {
        events.service += 1;
        return { from(table) { events.query.push(["from", table]); return query; } };
      },
    },
    "@/lib/stuart/accounts-invoice-automation": {
      async processAccountsInvoice(id) {
        events.processed.push(id);
        if (outcomes[id] === "throw") throw new Error("Source needs review");
        return outcomes[id] ?? { outcome: "already_processed" };
      },
    },
  }, {});
  return { route, events };
}

function request(method, { token, body } = {}) {
  return new NextRequest("https://example.test/api/stuart/accounts-invoices", {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("scheduled GET uses the existing authorized oldest-first invoice batch", async () => {
  const { route, events } = harness({ rows: [{ id: "oldest" }, { id: "next" }] });
  assert.equal(typeof route.GET, "function");
  const response = await route.GET(request("GET", { token: "test-cron-secret" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    processed: 2,
    results: [
      { email_id: "oldest", outcome: "already_processed" },
      { email_id: "next", outcome: "already_processed" },
    ],
  });
  assert.equal(events.auth, 0);
  assert.deepEqual(events.query, [
    ["from", "emails"], ["select", "id"],
    ["contains", "ingested_mailboxes", ["accounts@reslu.com.au"]],
    ["in", "status", ["matched", "proposed", "review"]],
    ["not", "extraction->supplier_invoice", "is", null],
    ["order", "received_at", { ascending: true }], ["limit", 10],
  ]);
  assert.deepEqual(events.processed, ["oldest", "next"]);
});

test("GET and POST reject missing or invalid cron auth before any invoice access", async () => {
  for (const method of ["GET", "POST"]) {
    for (const options of [{}, { token: "invalid" }]) {
      const { route, events } = harness();
      const response = await route[method](request(method, options));
      assert.equal(response.status, 403);
      assert.equal(events.auth, method === "GET" ? 0 : 1);
      assert.equal(events.service, 0);
      assert.deepEqual(events.processed, []);
    }
  }
});

test("a missing CRON_SECRET never authorizes a guessed bearer value", async () => {
  const { route, events } = harness({ secret: null });
  const response = await route.GET(request("GET", { token: "undefined" }));
  assert.equal(response.status, 403);
  assert.equal(events.service, 0);
});

test("existing POST cron invocation retains its single-email behavior", async () => {
  const { route, events } = harness();
  const response = await route.POST(request("POST", { token: "test-cron-secret", body: { email_id: "selected" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { processed: 1, results: [{ email_id: "selected", outcome: "already_processed" }] });
  assert.equal(events.auth, 0);
  assert.deepEqual(events.query, []);
  assert.deepEqual(events.processed, ["selected"]);
});

test("existing Stuart session remains allowed and unrelated users remain forbidden", async () => {
  for (const [email, expected] of [["accounts@reslu.com.au", 200], ["other@example.test", 403]]) {
    const { route, events } = harness({ user: { email } });
    const response = await route.POST(request("POST", { body: { email_id: "selected" } }));
    assert.equal(response.status, expected);
    assert.equal(events.auth, 1);
    assert.equal(events.service, expected === 200 ? 1 : 0);
    assert.deepEqual(events.processed, expected === 200 ? ["selected"] : []);
  }
});

test("Stuart session alone cannot start invoice work through GET", async () => {
  for (const options of [{}, { token: "invalid" }]) {
    const { route, events } = harness({ user: { email: "accounts@reslu.com.au" } });
    const response = await route.GET(request("GET", options));
    assert.equal(response.status, 403);
    assert.equal(events.auth, 0);
    assert.equal(events.service, 0);
    assert.deepEqual(events.processed, []);
  }
});

test("GET ignores email_id query input and selects the scheduled batch", async () => {
  const { route, events } = harness({ rows: [{ id: "batch-id" }] });
  const response = await route.GET(new NextRequest("https://example.test/api/stuart/accounts-invoices?email_id=selected", {
    headers: { authorization: "Bearer test-cron-secret" },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(events.processed, ["batch-id"]);
  assert.ok(events.query.some(([method]) => method === "limit"));
});

test("authenticated HEAD cannot process invoices", async () => {
  const { route, events } = harness();
  const response = await route.HEAD(request("HEAD", { token: "test-cron-secret" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, POST");
  assert.equal(await response.text(), "");
  assert.equal(events.auth, 0);
  assert.equal(events.service, 0);
  assert.deepEqual(events.processed, []);
});

test("GET returns an empty batch and query failures without processing invoices", async () => {
  for (const [queryError, expected] of [[null, 200], [{ message: "Query failed" }, 500]]) {
    const { route, events } = harness({ queryError });
    const response = await route.GET(request("GET", { token: "test-cron-secret" }));
    assert.equal(response.status, expected);
    assert.deepEqual(await response.json(), queryError ? { error: "Query failed" } : { processed: 0, results: [] });
    assert.deepEqual(events.processed, []);
  }
});

test("GET retains manual review errors and continues the remaining batch", async () => {
  const { route, events } = harness({ rows: [{ id: "failed" }, { id: "next" }], outcomes: { failed: "throw" } });
  const response = await route.GET(request("GET", { token: "test-cron-secret" }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.processed, 2);
  assert.deepEqual(body.results[0], { email_id: "failed", outcome: "manual_review", reason: "Source needs review" });
  assert.deepEqual(events.processed, ["failed", "next"]);
});
