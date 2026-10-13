import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { isStuartUser } from "./access.ts";
import { buildBankingEvidence } from "./banking-evidence.ts";

function route(options: { email?: string; connected?: boolean; error?: boolean } = {}) {
  const reads: Array<{ table: string; operations: Array<[string, ...unknown[]]> }> = [];
  const service = {
    from(table: string) {
      const read = { table, operations: [] as Array<[string, ...unknown[]]> };
      reads.push(read);
      const response = () => {
        if (table === "xero_connections") return {
          data: options.connected === false ? null : { id: "active-connection", scopes: [], last_sync_completed_at: "2026-10-06T20:00:34Z", last_sync_error: null }, error: null,
        };
        if (options.connected === false) return { data: [], count: 0, error: null };
        if (options.error) return { data: null, count: null, error: { message: "Cache query failed" } };
        if (table === "xero_bank_accounts") return {
          data: [{ xero_account_id: "bank", name: "Clearing", bank_account_type: "BANK", status: "ACTIVE", current_balance: null, balance_as_of: null, balance_source: null, balance_synced_at: null, synced_at: "2026-10-06T20:00:34Z" }], count: 1, error: null,
        };
        if (table === "xero_payments") return { data: [], count: 0, error: null };
        throw new Error(`Unexpected data read: ${table}`);
      };
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "order", "range"]) {
        builder[method] = (...args: unknown[]) => { read.operations.push([method, ...args]); return builder; };
      }
      builder.maybeSingle = async () => response();
      builder.then = (resolve: (r: unknown) => unknown) => Promise.resolve(response()).then(resolve);
      for (const method of ["insert", "update", "upsert", "delete", "rpc"]) {
        builder[method] = () => { throw new Error(`Forbidden mutation: ${method}`); };
      }
      return builder;
    },
  };
  const module = { exports: {} as { GET: (request: unknown) => Promise<{ body: ReturnType<typeof buildBankingEvidence>; status: number }> } };
  const source = readFileSync(new URL("../../app/api/stuart/brief/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mocks: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown, init: { status?: number } = {}) => ({ body, status: init.status ?? 200 }) } },
    "@/lib/supabase/server": {
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { email: options.email ?? "accounts@reslu.com.au" } } }) } }),
      createServiceRoleClient: () => service,
    },
    "@/lib/stuart/access": { isStuartUser },
    "@/lib/stuart/banking-evidence": { buildBankingEvidence },
    "@/lib/stuart/forecast": {
      buildThirteenWeekForecast: () => { throw new Error("Banking read must not build forecast"); },
      summariseProjectCosts: () => { throw new Error("Banking read must not read project costs"); },
    },
  };
  const require = (name: string) => {
    if (!(name in mocks)) throw new Error(`Unexpected import: ${name}`);
    return mocks[name];
  };
  new Function("require", "module", "exports", compiled)(require, module, module.exports);
  return { reads, get: (query = "response_format=banking") => module.exports.GET({ nextUrl: new URL(`https://example.invalid/api/stuart/brief?${query}`) }) };
}

test("banking endpoint rejects another identity before reading privileged cache", async () => {
  const subject = route({ email: "other@example.invalid" });
  assert.equal((await subject.get()).status, 403);
  assert.deepEqual(subject.reads, []);
});

test("banking endpoint reads active-connection cache only and leaves missing balances unavailable", async () => {
  const subject = route();
  const result = await subject.get();
  assert.equal(result.status, 200);
  assert.equal(result.body.cache_last_completed_at, "2026-10-06T20:00:34Z");
  assert.equal(result.body.accounts[0].ledger_balance.amount_decimal, null);
  assert.equal(result.body.accounts[0].unreconciled_statement_line_count, null);
  assert.deepEqual(subject.reads.map((r) => r.table), ["xero_connections", "xero_bank_accounts", "xero_payments"]);
  for (const read of subject.reads.slice(1)) {
    assert.ok(read.operations.some((op) => op[0] === "eq" && op[1] === "connection_id" && op[2] === "active-connection"));
    assert.equal(String(read.operations.find((op) => op[0] === "select")?.[1]).includes("BankAccountNumber"), false);
  }
  assert.ok(subject.reads[1].operations.some((op) => op[0] === "eq" && op[1] === "status" && op[2] === "ACTIVE"));
});

test("invalid pagination fails without reading accounts or payments", async () => {
  for (const query of ["offset=-1", "limit=6", "offset=1.1", "limit=0"]) {
    const subject = route();
    assert.equal((await subject.get(`response_format=banking&${query}`)).status, 400);
    assert.deepEqual(subject.reads.map((r) => r.table), ["xero_connections"]);
  }
});

test("disconnected and failed cache reads cannot produce a successful bank claim", async () => {
  const disconnected = await route({ connected: false }).get();
  assert.equal(disconnected.body.connected, false);
  assert.equal(disconnected.body.account_count, 0);
  assert.deepEqual(disconnected.body.accounts, []);
  assert.equal((await route({ error: true }).get()).status, 500);
});
