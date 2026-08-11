import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const layout = read("app/(dashboard)/layout.tsx");
const messagesPage = read("app/(dashboard)/messages/page.tsx");
const messenger = read("components/conversations/GlobalMessenger.tsx");
const workspace = read("components/conversations/ConversationWorkspace.tsx");

test("the desktop messenger lives in the persistent dashboard layout", () => {
  assert.match(layout, /<GlobalMessenger \/>/);
  assert.match(messenger, /"fixed z-\[60\] flex flex-col/);
  assert.match(messenger, /"bottom-5 right-5 rounded-2xl"/);
  assert.match(messenger, /<ConversationWorkspace\s+presentation="drawer"/);
  assert.match(messenger, /Stays open while you move through RESLU/);
  assert.match(messenger, /onUnreadCountChange=\{setUnreadCount\}/);
  assert.match(workspace, /data\.conversations\.reduce\(\(total, conversation\) => total \+ conversation\.unread_count/);
  assert.match(messenger, /const workspaceInteractive = \(panelVisible && \(!minimized \|\| onMessagesPage\)\) \|\| callActive/);
  assert.match(messenger, /active=\{workspaceInteractive\}/);
  assert.match(workspace, /if \(!interactionActiveRef\.current \|\| document\.visibilityState !== "visible"\) return/);
  assert.match(messenger, /useSyncExternalStore\(subscribeDesktop, desktopSnapshot/);
  assert.match(messenger, /onMessagesPage \? "inset-y-0 left-56 right-0/);
  assert.match(messagesPage, /main className="min-h-0 min-w-0 flex-1 overflow-hidden md:hidden"/);
});

test("the messenger can minimise, close, resize and restore its saved dimensions", () => {
  assert.match(messenger, /reslu:desktop-messenger:v1/);
  assert.match(messenger, /setPointerCapture/);
  assert.match(messenger, /cursor-nwse-resize/);
  assert.match(messenger, /Minimise messenger/);
  assert.match(messenger, /Close messenger/);
  assert.match(messenger, /Open RESLU messages/);
});

test("a live call escapes hidden drawer chrome and reports its state", () => {
  assert.match(workspace, /onCallActiveChange\?\.\(Boolean\(callOpening \|\| callId \|\| callError\)\)/);
  assert.match(workspace, /visible pointer-events-auto fixed inset-x-0/);
  assert.match(messenger, /\(panelVisible \|\| onMessagesPage \|\| callActive\) && "invisible pointer-events-none"/);
});
