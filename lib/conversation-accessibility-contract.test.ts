import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const meetingMode = read("components/conversations/MeetingMode.tsx");
const globals = read("app/globals.css");
const acceptance = read("docs/WHATSAPP-REPLACEMENT-ACCEPTANCE.md");

test("chat, call, search and Meeting Mode expose modal semantics", () => {
  assert.match(workspace, /role=\{callModal \? "dialog" : "region"\}/);
  assert.match(workspace, /aria-modal=\{callModal \? true : undefined\}/);
  assert.match(workspace, /role="dialog" aria-modal="true" aria-label="Search messages and files"/);
  assert.match(workspace, /role="dialog" aria-modal="true" aria-labelledby="new-conversation-title"/);
  assert.match(meetingMode, /role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="meeting-mode-title"/);
});

test("dynamic call and meeting states are announced without interrupting speech", () => {
  assert.match(workspace, /id="active-call-agent"/);
  assert.match(workspace, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(meetingMode, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(meetingMode, /role="alert"/);
});

test("high-frequency mobile icon controls retain 44px touch targets", () => {
  assert.match(workspace, /aria-label="Record voice note"[\s\S]*className="flex h-11 w-11/);
  assert.match(workspace, /aria-label="Cancel reply" className="flex h-11 w-11/);
  assert.match(workspace, /aria-label="Add photos or files"[\s\S]*className="flex h-11 w-11/);
  assert.match(workspace, /aria-label="Send message"[\s\S]*className="flex h-11 min-w-11/);
  assert.match(workspace, /Actions for message from[\s\S]*h-11 w-11/);
});

test("keyboard focus and reduced-motion behavior are global conversation contracts", () => {
  assert.match(globals, /:where\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible/);
  assert.match(globals, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(globals, /\.conversation-accessible \*/);
  assert.match(globals, /\.meeting-mode-dialog \*/);
  assert.match(meetingMode, /useDialogFocusBoundary\(\{/);
  assert.match(meetingMode, /escapeDisabled: recording \|\| paused \|\| busy/);
});

test("iPhone conversations permit text scaling and keep operational metadata readable", () => {
  assert.match(globals, /-webkit-text-size-adjust: 100%/);
  assert.match(globals, /\.conversation-accessible \.conversation-meta \{[\s\S]*font-size: 12px/);
  assert.match(workspace, /conversation-meta[\s\S]*timeLabel\(message\.created_at\)/);
  assert.match(workspace, /conversation-meta[\s\S]*Waiting for connection/);
  assert.doesNotMatch(workspace, /text-\[9px\][\s\S]{0,120}(Delivered|Not sent|Voice transcript|Edited)/);
});

test("live acceptance still requires keyboard, screen reader, reduced-motion and physical touch evidence", () => {
  assert.match(acceptance, /keyboard-only/);
  assert.match(acceptance, /VoiceOver/);
  assert.match(acceptance, /Reduce Motion/);
  assert.match(acceptance, /44 px/);
});
