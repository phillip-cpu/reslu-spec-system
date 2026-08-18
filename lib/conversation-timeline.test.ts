import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONVERSATION_MESSAGE_LONG_PRESS_MS,
  conversationDayKey,
  conversationDayLabel,
  conversationLongPressMoved,
  mergeConversationTimelineMessages,
  preserveEqualConversationCollection,
  preservedConversationScrollTop,
} from "./conversation-timeline.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = readFileSync(resolve(root, "components/conversations/ConversationWorkspace.tsx"), "utf8");

test("timeline day labels use the viewer's local calendar day", () => {
  const now = new Date(2026, 7, 12, 12, 0, 0);
  const today = new Date(2026, 7, 12, 8, 30, 0).toISOString();
  const yesterday = new Date(2026, 7, 11, 22, 30, 0).toISOString();
  const priorYear = new Date(2025, 11, 31, 9, 0, 0).toISOString();
  assert.equal(conversationDayLabel(today, now), "Today");
  assert.equal(conversationDayLabel(yesterday, now), "Yesterday");
  assert.match(conversationDayLabel(priorYear, now), /2025/);
  assert.notEqual(conversationDayKey(today), conversationDayKey(yesterday));
});

test("touch long press opens deliberately and scrolling cancels it", () => {
  assert.equal(CONVERSATION_MESSAGE_LONG_PRESS_MS, 500);
  assert.equal(conversationLongPressMoved(10, 10, 20, 10), false);
  assert.equal(conversationLongPressMoved(10, 10, 21, 10), true);
  assert.match(workspace, /data-message-long-press=\{message\.id\}/);
  assert.match(workspace, /onPointerDown=\{\(event\) => startMessageLongPress\(message\.id, event\)\}/);
  assert.match(workspace, /onPointerMove=\{moveMessageLongPress\}/);
  assert.match(workspace, /closest\("button, a, input, textarea, audio, select"\)/);
});

test("each local date boundary renders an accessible sticky separator", () => {
  assert.match(workspace, /conversationDayKey\(previousMessage\.created_at\)/);
  assert.match(workspace, /role="separator" aria-label=\{conversationDayLabel\(message\.created_at\)\}/);
  assert.match(workspace, /sticky top-2/);
});

test("private conversation photos open inside a full-screen accessible viewer", () => {
  assert.match(workspace, /setMediaViewer\(\{ url: attachment\.url!/);
  assert.match(workspace, /aria-label=\{`View \$\{attachment\.filename\} full screen`\}/);
  assert.match(workspace, /aria-labelledby="conversation-media-viewer-title"/);
  assert.match(workspace, /aria-label="Close photo viewer"/);
  assert.match(workspace, /Open original/);
  assert.match(workspace, /active: Boolean\(mediaViewer\),[\s\S]*containerRef: mediaViewerDialogRef/);
});

test("long histories skip off-screen layout without hiding canonical messages", () => {
  const globalStyles = readFileSync(resolve(root, "app/globals.css"), "utf8");
  const route = readFileSync(resolve(root, "app/api/conversations/[id]/messages/route.ts"), "utf8");

  assert.match(route, /\.limit\(100\)/);
  assert.match(workspace, /conversation-timeline-item border-y/);
  assert.match(workspace, /"conversation-timeline-item flex gap-3"/);
  assert.match(globalStyles, /\.conversation-timeline-item\s*\{[\s\S]*content-visibility:\s*auto/);
  assert.match(globalStyles, /contain-intrinsic-size:\s*auto 112px/);
  assert.match(globalStyles, /\.conversation-timeline-item-active\s*\{[\s\S]*content-visibility:\s*visible/);
  assert.match(workspace, /messageMenuId === message\.id \|\| editingMessageId === message\.id/);
  assert.doesNotMatch(globalStyles, /content-visibility:\s*hidden/);
});

test("twenty keyset pages merge into 2,000 unique chronological messages", () => {
  const allMessages = Array.from({ length: 2_000 }, (_, index) => ({
    id: `message-${String(index).padStart(4, "0")}`,
    created_at: new Date(Date.UTC(2026, 7, 1, 0, Math.floor(index / 4), 0)).toISOString(),
    body: `Message ${index}`,
  }));
  let loaded = allMessages.slice(-100);
  for (let end = 1_900; end > 0; end -= 100) {
    const page = allMessages.slice(Math.max(0, end - 100), end);
    loaded = mergeConversationTimelineMessages(loaded, page);
  }

  assert.equal(loaded.length, 2_000);
  assert.deepEqual(new Set(loaded.map((message) => message.id)).size, 2_000);
  assert.deepEqual(loaded.map((message) => message.id), allMessages.map((message) => message.id));

  const corrected = { ...allMessages[1_999], body: "Canonical correction" };
  const duplicatePage = mergeConversationTimelineMessages(loaded, [allMessages[1_998], corrected]);
  assert.equal(duplicatePage.length, 2_000);
  assert.equal(duplicatePage.at(-1)?.body, "Canonical correction");
});

test("unchanged polling pages preserve long-history and metadata references", () => {
  const loaded = Array.from({ length: 2_000 }, (_, index) => ({
    id: `message-${String(index).padStart(4, "0")}`,
    created_at: new Date(Date.UTC(2026, 7, 1, 0, Math.floor(index / 4), 0)).toISOString(),
    body: `Message ${index}`,
    reactions: index % 10 === 0 ? [{ reaction: "like", count: 1 }] : [],
  }));
  const unchangedLatestPage = loaded.slice(-100).map((message) => ({
    ...message,
    reactions: message.reactions.map((reaction) => ({ ...reaction })),
  }));
  let polled = loaded;
  for (let poll = 0; poll < 100; poll += 1) {
    polled = mergeConversationTimelineMessages(polled, unchangedLatestPage);
    assert.equal(polled, loaded);
  }

  const participants = [{ id: "person-1", display_name: "Phillip" }];
  assert.equal(
    preserveEqualConversationCollection(participants, [{ id: "person-1", display_name: "Phillip" }]),
    participants,
  );

  const changed = mergeConversationTimelineMessages(loaded, [
    { ...unchangedLatestPage.at(-1)!, body: "Updated canonical message" },
  ]);
  assert.notEqual(changed, loaded);
  assert.equal(changed.at(-1)?.body, "Updated canonical message");
});

test("older page insertion preserves the same visible timeline anchor", () => {
  let scrollTop = 260;
  let scrollHeight = 11_200;
  for (let page = 0; page < 19; page += 1) {
    const anchorOffsetFromBottom = scrollHeight - scrollTop;
    const nextHeight = scrollHeight + 9_600 + (page % 3) * 137;
    scrollTop = preservedConversationScrollTop(scrollTop, scrollHeight, nextHeight);
    scrollHeight = nextHeight;
    assert.equal(scrollHeight - scrollTop, anchorOffsetFromBottom);
  }
  assert.equal(preservedConversationScrollTop(10, 100, 20), 0);
  assert.match(workspace, /mergeConversationTimelineMessages\(current, incoming\)/);
  assert.match(workspace, /preserveEqualConversationCollection\(current, incoming\)/);
  assert.match(workspace, /offlineMessageCacheSnapshotRef/);
  assert.match(workspace, /preservedConversationScrollTop\(/);
});
