import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { conversationMenuTargetIndex } from "./conversation-menu-keyboard.ts";

test("message menu navigation wraps and supports first/last shortcuts", () => {
  assert.equal(conversationMenuTargetIndex("ArrowDown", -1, 4), 0);
  assert.equal(conversationMenuTargetIndex("ArrowDown", 3, 4), 0);
  assert.equal(conversationMenuTargetIndex("ArrowUp", -1, 4), 3);
  assert.equal(conversationMenuTargetIndex("ArrowUp", 0, 4), 3);
  assert.equal(conversationMenuTargetIndex("Home", 2, 4), 0);
  assert.equal(conversationMenuTargetIndex("End", 1, 4), 3);
  assert.equal(conversationMenuTargetIndex("ArrowDown", 0, 0), null);
});

test("workspace closes message menus on Escape/outside press and restores trigger focus", () => {
  const workspace = readFileSync(
    new URL("../components/conversations/ConversationWorkspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(workspace, /event\.key !== "Escape"/);
  assert.match(workspace, /messageMenuTriggerRefs\.current\.get\(openMessageId\)\?\.focus\(\)/);
  assert.match(workspace, /document\.addEventListener\("pointerdown", onPointerDown, true\)/);
  assert.match(workspace, /querySelectorAll<HTMLElement>\('\[role="menuitem"\]'\)/);
});
