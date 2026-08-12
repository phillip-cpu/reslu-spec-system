import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dialogFocusWrapTarget } from "./use-dialog-focus-boundary.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = readFileSync(resolve(root, "components/conversations/ConversationWorkspace.tsx"), "utf8");
const meeting = readFileSync(resolve(root, "components/conversations/MeetingMode.tsx"), "utf8");

test("Tab and Shift-Tab wrap only at modal boundaries", () => {
  assert.equal(dialogFocusWrapTarget(2, 3, false), 0);
  assert.equal(dialogFocusWrapTarget(0, 3, true), 2);
  assert.equal(dialogFocusWrapTarget(1, 3, false), null);
  assert.equal(dialogFocusWrapTarget(1, 3, true), null);
  assert.equal(dialogFocusWrapTarget(-1, 3, false), 0);
  assert.equal(dialogFocusWrapTarget(-1, 3, true), 2);
  assert.equal(dialogFocusWrapTarget(-1, 0, false), null);
});

test("every interactive conversation modal installs one focus boundary", () => {
  assert.match(workspace, /useDialogFocusBoundary\(\{ active: true, containerRef: newConversationDialogRef/);
  assert.match(workspace, /useDialogFocusBoundary\(\{ active: true, containerRef: forwardDialogRef/);
  assert.match(workspace, /useDialogFocusBoundary\(\{ active: true, containerRef: groupDialogRef/);
  assert.match(workspace, /active: messageSearchOpen,[\s\S]*containerRef: messageSearchDialogRef/);
  assert.match(workspace, /active: Boolean\(mediaViewer\),[\s\S]*containerRef: mediaViewerDialogRef/);
  assert.match(workspace, /active: callModal,[\s\S]*containerRef: callDialogRef/);
  assert.match(meeting, /useDialogFocusBoundary\(\{[\s\S]*containerRef: dialogRef/);
});

test("the desktop compact call remains a non-modal persistent companion", () => {
  assert.match(workspace, /const callModal = Boolean\(callOpening \|\| callId \|\| callError\)/);
  assert.match(workspace, /!\(drawer && callCompact && desktopViewport\)/);
  assert.match(workspace, /role=\{callModal \? "dialog" : "region"\}/);
});

test("Meeting Mode blocks Escape while recording or committing state", () => {
  assert.match(meeting, /escapeDisabled: recording \|\| paused \|\| busy/);
  assert.match(meeting, /onEscape: onClose/);
});
