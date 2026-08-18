import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../supabase/migrations/20260818173619_repair_production_function_lint.sql"
  ),
  "utf8"
);

test("finance activation uses the named forecast-line uniqueness constraint", () => {
  assert.match(
    migration,
    /on conflict on constraint finance_forecast_lines_baseline_id_contribution_key_key do nothing/i
  );
  assert.match(migration, /conflict_target_count <> 3/i);
});

test("artifact approval schema-qualifies pgcrypto without widening search_path", () => {
  assert.match(
    migration,
    /computed_payload_sha := encode\(extensions\.digest\(/
  );
  assert.doesNotMatch(
    migration,
    /alter function public\.decide_agent_task_artifact[\s\S]*set search_path/i
  );
});

test("corrected SECURITY DEFINER functions remain authenticated-only", () => {
  assert.match(
    migration,
    /revoke all on function public\.activate_project_finance\([\s\S]*?from public, anon;/i
  );
  assert.match(
    migration,
    /grant execute on function public\.activate_project_finance\([\s\S]*?to authenticated;/i
  );
  assert.match(
    migration,
    /revoke all on function public\.decide_agent_task_artifact\([\s\S]*?from public, anon;/i
  );
  assert.match(
    migration,
    /grant execute on function public\.decide_agent_task_artifact\([\s\S]*?to authenticated;/i
  );
});
