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
