import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canStartConversationSwipeBack,
  conversationSwipeBackProgress,
} from "./conversation-swipe-back.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = readFileSync(resolve(root, "components/conversations/ConversationWorkspace.tsx"), "utf8");

test("swipe back starts only from the iPhone left edge while switching is safe", () => {
  assert.equal(canStartConversationSwipeBack(12, "touch", true), true);
  assert.equal(canStartConversationSwipeBack(40, "touch", true), false);
  assert.equal(canStartConversationSwipeBack(12, "mouse", true), false);
  assert.equal(canStartConversationSwipeBack(12, "touch", false), false);
  assert.match(workspace, /!sending[\s\S]*!voiceNoteRecording[\s\S]*!callOpening/);
});

test("horizontal intent commits while ordinary vertical scrolling cancels", () => {
  assert.deepEqual(conversationSwipeBackProgress(10, 100, 95, 108), {
    cancelled: false,
    offset: 85,
    committed: true,
  });
  assert.deepEqual(conversationSwipeBackProgress(10, 100, 35, 145), {
    cancelled: true,
    offset: 0,
    committed: false,
  });
  assert.equal(conversationSwipeBackProgress(10, 100, 60, 105).committed, false);
});

test("the canonical conversation selector owns the completed gesture", () => {
  assert.match(workspace, /onPointerDown=\{startConversationSwipeBack\}/);
  assert.match(workspace, /onPointerMove=\{moveConversationSwipeBack\}/);
  assert.match(workspace, /onPointerUp=\{finishConversationSwipeBack\}/);
  assert.match(workspace, /if \(progress\.committed\) selectConversation\(null\)/);
  assert.match(workspace, /Finish or cancel the voice note before changing chats/);
  assert.match(workspace, /Wait for the message to finish sending before changing chats/);
});
