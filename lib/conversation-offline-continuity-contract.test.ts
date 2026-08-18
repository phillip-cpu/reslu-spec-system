import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const layout = read("app/layout.tsx");
const registrar = read("components/ServiceWorkerRegistrar.tsx");
const serviceWorker = read("public/sw.js");
const offlineCache = read("lib/conversation-offline-cache.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");

test("every installed RESLU client registers the messaging service worker", () => {
  assert.match(layout, /<ServiceWorkerRegistrar \/>/);
  assert.match(registrar, /navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
});

test("the service worker caches only the generic chat shell and immutable public assets", () => {
  assert.match(serviceWorker, /request\.mode === "navigate" && url\.pathname === "\/messages"/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /responseUrl\.pathname === "\/messages"/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/_next\/static\/"\)/);
  assert.doesNotMatch(serviceWorker, /cache\.put\([^\n]*(?:\/api\/|notifications|attachments)/);
});

test("recent conversation data is bounded and scoped to the last signed-in profile", () => {
  assert.match(offlineCache, /MAX_CACHED_CONVERSATION_MESSAGES = 100/);
  assert.match(offlineCache, /conversationMessageCacheKey\(ownerProfileId, conversationId\)/);
  assert.match(offlineCache, /ownerProfileId: string/);
  assert.match(workspace, /saveCachedConversationList\(signedInProfileId, conversationData\)/);
  assert.match(workspace, /loadCachedConversationList\(cachedProfileId\)/);
  assert.match(workspace, /saveCachedConversationMessages/);
  assert.match(workspace, /loadCachedConversationMessages\(ownerProfileId, conversationId\)/);
  assert.match(workspace, /Offline — showing recent conversations saved on this device\./);
});
