import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const searchRoute = read("app/api/conversations/[id]/search/route.ts");
const messageRoute = read("app/api/conversations/[id]/messages/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const timeline = read("lib/conversation-timeline.ts");
const migration = read("supabase/migrations/097_conversation_message_search.sql");
const verifier = read("supabase/fixtures/097_conversation_message_search_verify.sql");

test("full-history message search is authenticated and conversation-member scoped", () => {
  assert.match(searchRoute, /supabase\.auth\.getUser\(\)/);
  assert.match(searchRoute, /conversationParticipants\(supabase, conversationId, user\.id\)/);
  assert.match(searchRoute, /search_conversation_messages/);
  assert.match(migration, /auth\.uid\(\) is null or not is_conversation_member\(p_conversation_id\)/);
  assert.match(migration, /message\.deleted_at is null/);
});

test("search input and result volume are bounded, literal and trigram indexed", () => {
  assert.match(searchRoute, /query\.length < 2/);
  assert.match(searchRoute, /query\.length > 100/);
  assert.match(migration, /coalesce\(p_limit, 0\) not between 1 and 50/);
  assert.match(migration, /replace\(escaped_query, '%', E'\\\\%'\)/);
  assert.match(migration, /using gin \(body gin_trgm_ops\)/);
  assert.match(migration, /order by message\.created_at desc, message\.id desc/);
  assert.match(verifier, /wildcard characters were not searched literally/);
  assert.match(verifier, /a null result limit bypassed the search bound/);
});

test("an exact older result loads surrounding canonical context", () => {
  assert.match(messageRoute, /searchParams\.get\("around"\)/);
  assert.match(messageRoute, /\.eq\("id", around\)/);
  assert.match(messageRoute, /created_at\.lt\.\$\{targetData\.created_at\}[\s\S]*id\.lt\.\$\{around\}/);
  assert.match(messageRoute, /created_at\.gt\.\$\{targetData\.created_at\}[\s\S]*id\.gt\.\$\{around\}/);
  assert.match(messageRoute, /anchor_message_id: around/);
});

test("the interface searches chats and full message history, then returns to latest", () => {
  assert.match(workspace, /placeholder="Search chats"/);
  assert.match(workspace, /Search the full conversation history/);
  assert.match(workspace, /openMessageSearchResult/);
  assert.match(workspace, /Viewing an earlier message and its surrounding context/);
  assert.match(workspace, /returnToLatestMessages/);
});

test("polling preserves an anchored search result instead of snapping back to newest", () => {
  assert.match(workspace, /options\?\.around \?\? historyAnchorMessageIdRef\.current/);
  assert.match(workspace, /parameters\.set\("around", anchorMessageId\)/);
  assert.match(workspace, /historyAnchorMessageIdRef\.current = null/);
});

test("long conversations page backwards without losing scroll position or polling away history", () => {
  assert.match(messageRoute, /searchParams\.get\("before"\)/);
  assert.match(messageRoute, /searchParams\.get\("before_id"\)/);
  assert.match(messageRoute, /created_at\.lt\.\$\{before\}[\s\S]*id\.lt\.\$\{beforeId\}/);
  assert.match(messageRoute, /\.order\("id", \{ ascending: false \}\)/);
  assert.match(messageRoute, /\.limit\(100\)/);
  assert.match(workspace, /Load earlier messages/);
  assert.match(workspace, /before: \{ createdAt: oldestMessage\.created_at, id: oldestMessage\.id \}/);
  assert.match(workspace, /historyExpandedRef\.current/);
  assert.match(workspace, /currentScroller\.scrollTop = preservedConversationScrollTop\(/);
  assert.match(timeline, /Math\.max\(0, previousTop \+ currentHeight - previousHeight\)/);
});

test("message order has an id tie-breaker so equal timestamps cannot skip history", () => {
  assert.match(messageRoute, /\.order\("created_at", \{ ascending: false \}\)[\s\S]*\.order\("id", \{ ascending: false \}\)/);
  assert.match(workspace, /left\.created_at\.localeCompare\(right\.created_at\) \|\| left\.id\.localeCompare\(right\.id\)/);
});

test("the database verifier proves search behavior and rolls back", () => {
  assert.match(verifier, /do \$verify\$/);
  assert.match(verifier, /has_function_privilege\(\s*'anon'/);
  assert.match(verifier, /conversation_messages_body_trgm_idx/);
  assert.match(verifier, /when sqlstate 'P5097'/);
  assert.doesNotMatch(verifier, /create temporary table/);
});
