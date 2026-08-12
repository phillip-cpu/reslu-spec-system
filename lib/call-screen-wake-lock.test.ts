import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseCallScreenWakeLock,
  requestCallScreenWakeLock,
  type CallScreenWakeLock,
} from "./call-screen-wake-lock.ts";

test("active calls request the browser screen wake lock", async () => {
  let requested: string | null = null;
  const sentinel: CallScreenWakeLock = { released: false, release: async () => undefined };
  const navigatorObject = {
    wakeLock: {
      request: async (type: "screen") => {
        requested = type;
        return sentinel;
      },
    },
  } as unknown as Navigator;
  assert.equal(await requestCallScreenWakeLock(navigatorObject), sentinel);
  assert.equal(requested, "screen");
});

test("unsupported or rejected wake locks never end a call", async () => {
  assert.equal(await requestCallScreenWakeLock({} as Navigator), null);
  const rejected = {
    wakeLock: { request: async () => { throw new Error("not allowed"); } },
  } as unknown as Navigator;
  assert.equal(await requestCallScreenWakeLock(rejected), null);
});

test("release is idempotent for browser-released sentinels", async () => {
  let releases = 0;
  await releaseCallScreenWakeLock({ released: false, release: async () => { releases += 1; } });
  await releaseCallScreenWakeLock({ released: true, release: async () => { releases += 1; } });
  await releaseCallScreenWakeLock(null);
  assert.equal(releases, 1);
});
