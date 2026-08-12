import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/110_conversation_attachment_search.sql");
const verifier = read("supabase/fixtures/110_conversation_attachment_search_verify.sql");
const route = read("app/api/conversations/[id]/search/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");

test("member-scoped search covers ready uploaded and forwarded file names", () => {
  assert.match(migration, /not is_conversation_member\(p_conversation_id\)/);
  assert.match(migration, /conversation_attachments attachment[\s\S]*attachment\.status = 'ready'[\s\S]*attachment\.filename ilike/);
  assert.match(migration, /conversation_forwarded_attachments attachment[\s\S]*attachment\.filename ilike/);
  assert.match(migration, /message\.deleted_at is null/);
  assert.match(migration, /coalesce\(p_limit, 0\) not between 1 and 50/);
  assert.match(migration, /replace\(escaped_query, '%', E'\\\\%'/);
});

test("private filename search is trigram indexed and rollback verified", () => {
  assert.match(migration, /conversation_attachments_filename_trgm_idx/);
  assert.match(migration, /conversation_forwarded_attachments_filename_trgm_idx/);
  assert.match(migration, /using gin \(filename gin_trgm_ops\)/);
  assert.match(verifier, /RESLU_VERIFY_110_PASS/);
  assert.match(verifier, /v_staged_message_id = any\(v_ids\)/);
  assert.match(verifier, /v_deleted_message_id = any\(v_ids\)/);
  assert.match(verifier, /all test changes rolled back/i);
});

test("the authenticated route returns matching names but no storage locations", () => {
  assert.match(route, /conversationParticipants\(supabase, conversationId, user\.id\)/);
  assert.match(route, /from\("conversation_attachments"\)[\s\S]*select\("message_id,filename"\)/);
  assert.match(route, /from\("conversation_forwarded_attachments"\)[\s\S]*select\("message_id,filename"\)/);
  assert.match(route, /search_match/);
  assert.doesNotMatch(route, /select\("message_id,filename,storage_path"\)/);
  assert.doesNotMatch(route, /createSignedUrl|serviceRole/);
});

test("search results explain file matches and open canonical message context", () => {
  assert.match(workspace, /Search messages and files/);
  assert.match(workspace, /Search messages and file names/);
  assert.match(workspace, /message\.search_match\?\.attachment_filenames/);
  assert.match(workspace, /File · \{filename\}/);
  assert.match(workspace, /openMessageSearchResult\(message\.id\)/);
});
