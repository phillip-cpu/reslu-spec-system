import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = readFileSync(resolve(root, "scripts/install-ios-shell.sh"), "utf8");
const guide = readFileSync(resolve(root, "docs/IOS-NATIVE-SHELL.md"), "utf8");

test("the physical installer fails closed before signing an unavailable phone", () => {
  assert.match(installer, /devicectl list devices/);
  assert.match(installer, /developerModeStatus/);
  assert.match(installer, /tunnelState/);
  assert.match(installer, /paired but unavailable/);
});

test("the installer builds, installs and launches only the canonical native bundle", () => {
  assert.match(installer, /-destination "platform=iOS,id=\$device_udid"/);
  assert.match(installer, /devicectl device install app/);
  assert.match(installer, /devicectl device process launch/);
  assert.match(installer, /au\.com\.reslu\.spec/);
  assert.match(guide, /Run each case on the production backend/);
  assert.match(guide, /7\. Force one recoverable transport loss/);
});
