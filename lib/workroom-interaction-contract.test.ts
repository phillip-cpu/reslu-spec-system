import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspace = new URL("../components/workroom/WorkroomWorkspace.tsx", import.meta.url);
const taskRoute = new URL("../app/api/conversations/[id]/tasks/[taskId]/route.ts", import.meta.url);
const migration = new URL("../supabase/migrations/20260831101104_workroom_review_feedback.sql", import.meta.url);
const worker = new URL("../scripts/conversation_agent_bridge.py", import.meta.url);

test("Workroom decisions lock before React can render a disabled button", async () => {
  const source = await readFile(workspace, "utf8");
  assert.match(source, /const actionLock = useRef<string \| null>\(null\)/);
  assert.match(source, /if \(actionLock\.current\) return;/);
  assert.match(source, /actionLock\.current = lockKey;/);
  assert.match(source, /actionLock\.current = null;/);
});

test("mobile review opens at its beginning and keeps the internal brief quiet", async () => {
  const source = await readFile(workspace, "utf8");
  assert.match(source, /window\.matchMedia\("\(max-width: 1023px\)"\)/);
  assert.match(source, /window\.scrollTo\(\{ top: 0, behavior: "auto" \}\)/);
  assert.match(source, /<details className="border-b[^>]*><summary[^>]*>Assignment brief<\/summary>/);
});

test("requesting changes returns the same durable assignment to its agent", async () => {
  const [route, sql, workerSource] = await Promise.all([
    readFile(taskRoute, "utf8"),
    readFile(migration, "utf8"),
    readFile(worker, "utf8"),
  ]);

  assert.match(route, /action === "request_changes"/);
  assert.match(route, /request_agent_task_artifact_changes/);
  assert.match(sql, /p_note text/);
  assert.match(sql, /char_length\(clean_note\) > 2000/);
  assert.match(sql, /approval_state = 'changes_requested'/);
  assert.match(sql, /status = 'queued'/);
  assert.match(sql, /approval_receipt_id = null/);
  assert.match(workerSource, /else "approved"\s+if task\.get\("approval_state"\) == "approved"\s+else "none"/);
});

test("review actions fail closed when evidence or authority is incomplete", async () => {
  const source = await readFile(workspace, "utf8");
  assert.match(source, /inaccessibleAssets\(artifact\)/);
  assert.match(source, /artifactHasUsefulPreview\(artifact\)/);
  assert.match(source, /request && !policy/);
  assert.match(source, /There is nothing safe to approve yet\./);
});
