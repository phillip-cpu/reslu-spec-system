import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/095_conversation_push_delivery.sql");
const deliveryRoute = read("app/api/conversations/push/deliver/route.ts");
const exactNotificationRoute = read("app/api/notifications/[id]/route.ts");
const notificationRoute = read("app/api/notifications/latest-unread/route.ts");
const pushLibrary = read("lib/push.ts");
const serviceWorker = read("public/sw.js");
const bridge = read("scripts/conversation_agent_bridge.py");
const workspace = read("components/conversations/ConversationWorkspace.tsx");

test("every canonical message gets one durable job per subscribed device of each unmuted recipient", () => {
  assert.match(migration, /after insert on conversation_messages/);
  assert.match(migration, /unique \(message_id, recipient_profile_id, subscription_id\)/);
  assert.match(migration, /notifications_conversation_message_recipient_unique/);
  assert.match(migration, /source_message_id/);
  assert.match(migration, /from push_subscriptions subscription/);
  assert.match(migration, /not participant\.notifications_muted/);
  assert.match(migration, /participant\.profile_id is distinct from new\.author_profile_id/);
  assert.match(migration, /claim_conversation_push_jobs/);
  assert.match(migration, /delivery_token = gen_random_uuid\(\)/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /revoke all on function enqueue_conversation_push_jobs\(\) from public, anon, authenticated/);
});

test("private message previews are no longer team-readable notifications", () => {
  assert.match(migration, /drop policy if exists "team_all" on notifications/);
  assert.match(migration, /drop policy if exists "team_all" on push_subscriptions/);
  assert.match(migration, /push_subscription_owner_read/);
  assert.match(migration, /push_subscription_owner_update/);
  assert.match(migration, /user_id = auth\.uid\(\)/);
  assert.match(migration, /with check \(user_id is null\)/);
  assert.match(migration, /revoke update on notifications from authenticated/);
  assert.match(migration, /grant update\(read_at\) on notifications to authenticated/);
});

test("one-job tokens cannot send a push for a different job", () => {
  assert.match(migration, /delivery_token\s+uuid not null default gen_random_uuid\(\)/);
  assert.match(deliveryRoute, /\.eq\("id", body\.job_id\)/);
  assert.match(deliveryRoute, /\.eq\("delivery_token", deliveryToken\)/);
  assert.match(deliveryRoute, /job\.status !== "processing"/);
  assert.match(deliveryRoute, /\.eq\("status", "processing"\)/);
  assert.match(deliveryRoute, /Could not verify push (?:message|recipient|notification)/);
  assert.doesNotMatch(deliveryRoute, /SUPABASE_SERVICE_ROLE_KEY.*request|body.*service_role/i);
});

test("push delivery cannot block the Aria and Marco processing loop", () => {
  assert.match(bridge, /threading\.Thread\(/);
  assert.match(bridge, /daemon=True/);
  assert.match(bridge, /claim_push_jobs/);
  assert.match(bridge, /next_attempt_at/);
  assert.match(bridge, /"delivery_token": f"eq\.\{job\['delivery_token'\]\}"/);
});

test("notification taps reuse the app and open the exact canonical message", () => {
  assert.match(migration, /\/messages\?conversation=/);
  assert.match(serviceWorker, /client\.navigate\(destination\.href\)/);
  assert.match(workspace, /search\.get\("conversation"\)/);
  assert.match(workspace, /search\.get\("message"\)/);
  assert.match(workspace, /conversation-message-\$\{requestedMessageId\}/);
});

test("multi-device pushes carry only an opaque id and each device fetches its exact private row", () => {
  assert.match(pushLibrary, /JSON\.stringify\(\{ notification_id: notificationId \}\)/);
  assert.match(serviceWorker, /event\.data\.json\(\)/);
  assert.match(serviceWorker, /payload\.notification_id/);
  assert.match(serviceWorker, /\/api\/notifications\/\$\{encodeURIComponent\(payload\.notification_id\)\}/);
  assert.doesNotMatch(serviceWorker, /payload\.(?:body|title|link_href)/);
  assert.match(deliveryRoute, /job\.notification_id/);
  assert.match(deliveryRoute, /job\.subscription_id/);
  assert.match(pushLibrary, /sendPushToSubscription/);
  assert.match(pushLibrary, /\.eq\("id", subscriptionId\)/);
  assert.match(pushLibrary, /\.eq\("user_id", userId\)/);
  assert.match(exactNotificationRoute, /\.eq\("id", id\)/);
  assert.doesNotMatch(exactNotificationRoute, /read_at.*update|\.update\(/);
});

test("a removed participant cannot receive a queued conversation push", () => {
  assert.match(deliveryRoute, /Recipient is no longer a conversation member/);
  assert.match(deliveryRoute, /\.eq\("profile_id", job\.recipient_profile_id\)/);
  assert.match(deliveryRoute, /status: "skipped"/);
});

test("coalesced pushes cannot resurrect an older notification from the same chat", () => {
  assert.match(notificationRoute, /row\.kind\.startsWith\("conversation_message:"\)/);
  assert.match(notificationRoute, /\.eq\("kind", row\.kind\)/);
  assert.match(serviceWorker, /tag: notification\.tag/);
});
