/**
 * Isolated Postgres-compatible SQL smoke tests, NOT a substitute for live schema verification.
 * No credentials/network/production writes. Install @electric-sql/pglite@0.5.8 in a temp folder,
 * then run PGLITE_MODULE_PATH=/absolute/node_modules/@electric-sql/pglite/dist/index.js node scripts/test-finance-payment-migrations.mjs.
 * The capability/auth functions below are explicit test stand-ins for existing production functions.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleName = process.env.PGLITE_MODULE_PATH
  ? pathToFileURL(process.env.PGLITE_MODULE_PATH).href : "@electric-sql/pglite";
const { PGlite } = await import(moduleName);
const db = new PGlite();
const actor = "00000000-0000-0000-0000-000000000001";
const commitment = "00000000-0000-0000-0000-000000000081";
const root = new URL("../", import.meta.url);
let checks = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { checks += 1; console.log(`PASS ${name}`); });

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('test.actor', true), '')::uuid;
  $$;
  create table public.profiles(id uuid primary key);
  create function public.has_finance_capability(p_capability text, p_project uuid) returns boolean
    language sql stable as $$ select auth.uid() is not null and
      case when p_capability = 'finance.edit_forecast' then current_setting('test.can_edit', true) = 'true'
        else current_setting('test.can_view', true) = 'true' end; $$;
  create table public.finance_recurring_commitments (
    id uuid primary key, name text not null, amount_minor bigint not null,
    first_due_date date not null, end_date date, frequency text not null,
    annual_escalation_bps integer not null default 0, status text not null default 'active',
    version integer not null default 1
  );
  create table public.finance_audit_events (
    actor_id uuid, source text, action text, object_type text, object_id uuid, payload jsonb
  );
  create table public.invoices (
    id uuid primary key, recurring_commitment_id uuid,
    status text not null default 'pending', payment_status text not null default 'unpaid',
    amount_paid numeric not null default 0, paid_at date, total numeric not null default 0,
    currency_code text default 'AUD'
  );
  insert into public.profiles values ('${actor}');
  insert into public.finance_recurring_commitments(id,name,amount_minor,first_due_date,frequency)
    values ('${commitment}', 'Monthly rent', 550000, '2026-01-31', 'monthly');
  insert into public.finance_recurring_commitments(id,name,amount_minor,first_due_date,frequency)
    values ('00000000-0000-0000-0000-000000000082', 'Legacy once', 100, '2026-01-01', 'once');
  insert into public.invoices(id,status,payment_status,amount_paid,paid_at,total) values
    ('00000000-0000-0000-0000-000000000199','approved','part_paid',40,'2026-09-04',200);
`);

const migrationNames = process.argv.slice(2);
if (migrationNames.length === 0) migrationNames.push("20260908073428_recurring_occurrence_payments.sql", "20260908073459_supplier_payment_history.sql");
for (const name of migrationNames) {
  const path = new URL(`supabase/migrations/${name}`, root);
  await db.exec(await readFile(path, "utf8"));
  console.log(`APPLIED locally ${fileURLToPath(path)}`);
}

await check("new overdue one-time records start at their explicit due date without backdating migrated rules", async () => {
  await db.exec(`insert into finance_recurring_commitments(id,name,amount_minor,first_due_date,frequency) values
    ('00000000-0000-0000-0000-000000000083','New overdue once',100,'2026-01-01','once'),
    ('00000000-0000-0000-0000-000000000084','New recurring anchor',100,'2026-01-01','weekly')`);
  const rows = (await db.query("select id, tracking_started_on=first_due_date as tracks_anchor, tracking_started_on=current_date as tracks_today from finance_recurring_commitments where id<>$1 order by id", [commitment])).rows;
  assert.deepEqual(rows.map((row) => [row.tracks_anchor, row.tracks_today]), [[false,true],[true,false],[false,true]]);
});

async function identity(role, canEdit, canView, user = actor) {
  await db.exec(`reset role; set role ${role};`);
  await db.query("select set_config('test.actor',$1,false),set_config('test.can_edit',$2,false),set_config('test.can_view',$3,false)",
    [user, String(canEdit), String(canView)]);
}
const pay = (overrides = {}) => {
  const args = { due: "2026-09-30", amount: 100000, paid: "2026-09-04", version: 0, commitmentVersion: 1, reason: "Test payment reference", ...overrides };
  return db.query("select * from public.record_finance_recurring_payment($1,$2,$3,$4,$5,$6,$7)",
    [commitment,args.due,args.amount,args.paid,args.version,args.commitmentVersion,args.reason]);
};

await check("anonymous role has neither table read nor payment RPC", async () => {
  await identity("anon", false, false, "");
  await assert.rejects(() => db.query("select * from finance_recurring_occurrence_payments"), /permission denied/);
  await assert.rejects(() => pay(), /permission denied/);
});
await check("authenticated users without capability cannot read or mutate", async () => {
  await identity("authenticated", false, false);
  assert.equal((await db.query("select * from finance_recurring_occurrence_payments")).rows.length, 0);
  await assert.rejects(() => pay(), /Missing finance.edit_forecast/);
});
await check("view-only user cannot record payment or bypass audited RPC", async () => {
  await identity("authenticated", false, true);
  await assert.rejects(() => pay(), /Missing finance.edit_forecast/);
  await assert.rejects(() => db.query("delete from finance_recurring_occurrence_payments"), /permission denied/);
});
await check("exact month-end schedule, invalid dates and future payments are checked in SQL", async () => {
  await identity("authenticated", true, true);
  const { rows } = await db.query("select finance_recurring_date_matches('2026-01-31','monthly',null,'2026-02-28') as feb, finance_recurring_date_matches('2026-01-31','monthly',null,'2026-03-31') as mar, finance_recurring_date_matches('2026-01-31','monthly',null,'2026-03-28') as wrong");
  assert.deepEqual(rows[0], { feb: true, mar: true, wrong: false });
  await assert.rejects(() => pay({ due: "2026-09-29" }), /not an occurrence/);
  await assert.rejects(() => pay({ paid: "2099-01-01" }), /future date/);
  await assert.rejects(() => pay({ commitmentVersion: 0 }), /Commitment changed/);
});
await check("first payment saves a stable occurrence snapshot and cash date", async () => {
  const row = (await pay()).rows[0];
  assert.equal(Number(row.amount_paid_minor), 100000);
  assert.equal(Number(row.scheduled_amount_minor), 550000);
  assert.equal(row.version, 1);
  assert.deepEqual(row.payment_entries, [{ amount_minor: 100000, paid_on: "2026-09-04" }]);
});
await check("concurrent same-version saves allow only one payment", async () => {
  const results = await Promise.allSettled([pay({ amount: 50000, paid: "2026-09-05", version: 1 }), pay({ amount: 50000, paid: "2026-09-05", version: 1 })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const row = (await db.query("select * from finance_recurring_occurrence_payments")).rows[0];
  assert.equal(Number(row.amount_paid_minor), 150000);
  assert.equal(row.version, 2);
  assert.deepEqual(row.payment_entries, [{ amount_minor: 100000, paid_on: "2026-09-04" }, { amount_minor: 50000, paid_on: "2026-09-05" }]);
});
await check("overpayment, duplicate retries and blank reference are rejected", async () => {
  await assert.rejects(() => pay({ version: 2, amount: 450000 }), /exceeds the outstanding/);
  await assert.rejects(() => pay({ version: 1 }), /Payment changed/);
  await assert.rejects(() => pay({ version: 2, reason: "  " }), /reference or note/);
});
await check("each successful payment has one audit event", async () => {
  await db.exec("reset role");
  assert.equal((await db.query("select * from finance_audit_events where source = 'recurring_occurrence_payment'")).rows.length, 2);
});
await check("approved linked company bill is the sole payment-entry location", async () => {
  await db.exec(`insert into invoices(id,recurring_commitment_id,recurring_due_date,status) values
    ('00000000-0000-0000-0000-000000000100','${commitment}','2026-09-30','approved')`);
  await identity("authenticated", true, true);
  await assert.rejects(() => pay({ version: 2 }), /linked to a company bill/);
});
await check("only one approved bill can replace an occurrence", async () => {
  await db.exec("reset role");
  await assert.rejects(() => db.exec(`insert into invoices(id,recurring_commitment_id,recurring_due_date,status) values
    ('00000000-0000-0000-0000-000000000101','${commitment}','2026-09-30','approved')`), /duplicate key/);
  await assert.rejects(() => db.exec("insert into invoices(id,recurring_due_date) values ('00000000-0000-0000-0000-000000000102','2026-09-30')"), /requires_commitment/);
  for (const currency of ["'USD'", "null"]) {
    await assert.rejects(() => db.exec(`insert into invoices(id,recurring_commitment_id,recurring_due_date,currency_code) values
      ('00000000-0000-0000-0000-000000000103','${commitment}','2026-10-31',${currency})`), /aud_only/);
  }
});
await check("payment evidence survives archiving and cannot be deleted via parent FK", async () => {
  await db.exec(`update finance_recurring_commitments set status = 'archived', version = 2 where id = '${commitment}'`);
  await assert.rejects(() => db.exec(`delete from finance_recurring_commitments where id = '${commitment}'`), /foreign key/);
  await identity("authenticated", false, true);
  assert.equal((await db.query("select * from finance_recurring_occurrence_payments")).rows.length, 1);
});

await check("undo is capability-gated and cannot edit an occurrence managed by a bill", async () => {
  const undo = () => db.query("select * from undo_finance_recurring_payment($1,'2026-09-30',2,2,'Correct mistaken record')", [commitment]);
  await assert.rejects(undo, /Missing finance.edit_forecast/);
  await identity("authenticated", true, true);
  await assert.rejects(undo, /linked to a company bill/);
});
await check("undo retains earlier dates, preserves zero-row version and audits removed evidence", async () => {
  await db.exec("reset role; update invoices set recurring_due_date=null where id='00000000-0000-0000-0000-000000000100'");
  await identity("authenticated", true, true);
  const first = (await db.query("select * from undo_finance_recurring_payment($1,'2026-09-30',2,2,'Correct second payment')", [commitment])).rows[0];
  assert.equal(Number(first.amount_paid_minor), 100000);
  assert.deepEqual(first.payment_entries, [{ amount_minor: 100000, paid_on: "2026-09-04" }]);
  const last = (await db.query("select * from undo_finance_recurring_payment($1,'2026-09-30',3,2,'Correct first payment')", [commitment])).rows[0];
  assert.equal(last.version, 4);
  assert.equal(Number(last.amount_paid_minor), 0);
  assert.equal(last.paid_on, null);
  assert.deepEqual(last.payment_entries, []);
  await assert.rejects(() => pay({ version: 0, commitmentVersion: 2 }), /Payment changed/);
  await assert.rejects(() => db.query("select * from undo_finance_recurring_payment($1,'2026-09-30',4,2,'No payment left')", [commitment]), /no payment to undo/);
  await db.exec("reset role");
  const audit = await db.query("select payload from finance_audit_events where action='undo_recorded_payment'");
  assert.equal(audit.rows.length, 2);
  assert.deepEqual(audit.rows[0].payload.removed_payment, { amount_minor: 50000, paid_on: "2026-09-05" });
});

if (migrationNames.includes("20260908073459_supplier_payment_history.sql")) {
  const invoiceId = "00000000-0000-0000-0000-000000000199";
  const readInvoice = async () => (await db.query("select * from invoices where id=$1", [invoiceId])).rows[0];
  await db.exec("reset role");
  await check("legacy aggregate remains unchanged until a payment edit", async () => {
    const row = await readInvoice();
    assert.equal(Number(row.amount_paid), 40);
    assert.equal(row.paid_at.toISOString().slice(0, 10), "2026-09-04");
    assert.deepEqual(row.payment_history, []);
  });
  await check("supplier total increase preserves the first payment and appends only the increment", async () => {
    await db.query("update invoices set amount_paid=100,paid_at='2026-09-08' where id=$1", [invoiceId]);
    assert.deepEqual((await readInvoice()).payment_history, [
      { amount_minor: 4000, paid_on: "2026-09-04" }, { amount_minor: 6000, paid_on: "2026-09-08" },
    ]);
  });
  await check("date-only supplier correction touches the latest payment only", async () => {
    await db.query("update invoices set paid_at='2026-09-07' where id=$1", [invoiceId]);
    assert.deepEqual((await readInvoice()).payment_history, [
      { amount_minor: 4000, paid_on: "2026-09-04" }, { amount_minor: 6000, paid_on: "2026-09-07" },
    ]);
  });
  await check("client-supplied payment history cannot manufacture payments or dates", async () => {
    await db.query("update invoices set payment_history=$1 where id=$2", [JSON.stringify([{ amount_minor: 10000, paid_on: "2000-01-01" }]), invoiceId]);
    assert.deepEqual((await readInvoice()).payment_history, [
      { amount_minor: 4000, paid_on: "2026-09-04" }, { amount_minor: 6000, paid_on: "2026-09-07" },
    ]);
  });
  await check("supplier downward correction removes last increment and restores remaining date", async () => {
    await db.query("update invoices set amount_paid=40 where id=$1", [invoiceId]);
    const row = await readInvoice();
    assert.deepEqual(row.payment_history, [{ amount_minor: 4000, paid_on: "2026-09-04" }]);
    assert.equal(row.paid_at.toISOString().slice(0, 10), "2026-09-04");
  });
  await check("linking an approved bill does not change existing payment history", async () => {
    await db.query("update invoices set recurring_commitment_id=$1,recurring_due_date='2026-10-31' where id=$2", [commitment, invoiceId]);
    assert.deepEqual((await readInvoice()).payment_history, [{ amount_minor: 4000, paid_on: "2026-09-04" }]);
  });
  await check("payment-history trigger does not change invoice RLS or grant mutation access", async () => {
    const row = (await db.query("select relrowsecurity from pg_class where oid='public.invoices'::regclass")).rows[0];
    assert.equal(row.relrowsecurity, false); // Harness baseline is unchanged; production policies are not replaced by migration.
    await identity("authenticated", true, true);
    await assert.rejects(() => db.query("update invoices set amount_paid=0"), /permission denied/);
    await assert.rejects(() => db.query("select preserve_supplier_payment_history()"), /permission denied/);
  });
}
await db.close();
console.log(`${checks} local SQL/RLS/RPC smoke checks passed. Production schema compatibility still requires verification.`);
