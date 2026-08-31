import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const meetingMode = read("components/conversations/MeetingMode.tsx");
const sidebar = read("components/layout/Sidebar.tsx");
const globals = read("app/globals.css");
const acceptance = read("docs/WHATSAPP-REPLACEMENT-ACCEPTANCE.md");

function relativeLuminance(hex: string) {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((channel) => parseInt(channel, 16) / 255) ?? [];
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

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
  assert.match(workspace, /min-h-11 bg-nearblack px-4 py-2 text-body[\s\S]*New chat/);
  assert.match(workspace, /min-h-11 px-3 py-2 text-body font-medium/);
  assert.match(workspace, /flex min-h-11 items-center gap-2[\s\S]*placeholder="Search chats"/);
  assert.match(sidebar, /mb-px flex min-h-11 items-center/);
  assert.match(sidebar, /min-h-11 w-full[\s\S]*Arrange menu/);
  assert.match(sidebar, /h-11 w-11[\s\S]*md:h-7 md:w-7/);
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

test("muted conversation text and labels retain WCAG AA contrast on every light messaging surface", () => {
  assert.match(globals, /\.conversation-accessible \.text-charcoal\\\/40,[\s\S]*color: #696865/);
  assert.match(globals, /\.meeting-mode-dialog \.text-charcoal\\\/65[\s\S]*color: #696865/);
  assert.match(globals, /\.conversation-accessible \.label-caps,[\s\S]*color: #76634f/);
  assert.match(globals, /\.conversation-accessible \.conversation-dark \.label-caps[\s\S]*color: #a08c72/);
  assert.match(workspace, /conversation-dark visible pointer-events-auto/);

  for (const background of ["f5f1e8", "ede8de", "ffffff"]) {
    assert.ok(contrastRatio("696865", background) >= 4.5, `muted text must pass on #${background}`);
    assert.ok(contrastRatio("76634f", background) >= 4.5, `light-surface labels must pass on #${background}`);
  }
  assert.ok(contrastRatio("a08c72", "1a1a1a") >= 4.5, "sand labels must pass on the dark call surface");
});

test("live acceptance still requires keyboard, screen reader, reduced-motion and physical touch evidence", () => {
  assert.match(acceptance, /keyboard-only/);
  assert.match(acceptance, /VoiceOver/);
  assert.match(acceptance, /Reduce Motion/);
  assert.match(acceptance, /44 px/);
});
