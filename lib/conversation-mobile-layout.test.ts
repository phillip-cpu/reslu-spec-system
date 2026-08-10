import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = readFileSync(
  resolve(root, "components/conversations/ConversationWorkspace.tsx"),
  "utf8"
);
const messagesPage = readFileSync(resolve(root, "app/(dashboard)/messages/page.tsx"), "utf8");

test("mobile chat follows the iPhone visual viewport without a desktop minimum height", () => {
  assert.match(workspace, /window\.visualViewport/);
  assert.match(workspace, /--conversation-vh/);
  assert.match(workspace, /md:min-h-\[560px\]/);
  assert.doesNotMatch(workspace, /(?<!md:)min-h-\[560px\]/);
  assert.match(messagesPage, /hidden md:block/);
});

test("call controls account for notches, browser chrome and the home indicator", () => {
  assert.match(workspace, /--conversation-vtop/);
  assert.match(workspace, /h-\[var\(--conversation-vh,100dvh\)\]/);
  assert.match(workspace, /safe-area-inset-top/);
  assert.match(workspace, /safe-area-inset-bottom/);
});

test("mobile composer and dialogs are allowed to shrink and scroll", () => {
  assert.match(workspace, /max-h-full w-full max-w-lg overflow-y-auto/);
  assert.match(workspace, /min-h-12 min-w-0 flex-1 resize-none/);
  assert.match(workspace, /shrink-0 bg-nearblack/);
});

test("mobile chat keeps its native-style header and call action visible", () => {
  assert.match(workspace, /messagesScrollerRef/);
  assert.match(workspace, /scroller\.scrollTo/);
  assert.doesNotMatch(workspace, /messagesEndRef\.current\?\.scrollIntoView/);
  assert.match(workspace, /shouldStickToBottomRef/);
  assert.match(workspace, /pane\.scrollHeight - pane\.scrollTop - pane\.clientHeight < 96/);
  assert.match(workspace, /sticky top-0 z-10/);
  assert.match(workspace, /aria-label=\{`Call \$\{callAgent\.display_name\}`\}/);
  assert.match(workspace, /overscroll-contain overflow-y-auto/);
});

test("failed calls offer mobile recovery instead of disabled repeat controls", () => {
  assert.match(workspace, /Call interrupted/);
  assert.match(workspace, /Back to chat/);
  assert.match(workspace, /Try again/);
  assert.match(workspace, /await endCall\(\);\s+await startCall\(\);/);
});
