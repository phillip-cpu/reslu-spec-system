export interface CallScreenWakeLock {
  readonly released: boolean;
  release(): Promise<void>;
}

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request(type: "screen"): Promise<CallScreenWakeLock>;
  };
};

/**
 * Keep an active browser call visible so iOS does not suspend WebRTC merely
 * because the normal display timeout elapsed. A deliberate side-button lock
 * still requires the native CallKit transport; rejection is therefore a safe
 * no-op rather than a reason to end the canonical call.
 */
export async function requestCallScreenWakeLock(
  navigatorObject?: Navigator,
): Promise<CallScreenWakeLock | null> {
  const resolved = navigatorObject ?? (typeof navigator === "undefined" ? undefined : navigator);
  const wakeLock = (resolved as WakeLockNavigator | undefined)?.wakeLock;
  if (!wakeLock) return null;
  try {
    return await wakeLock.request("screen");
  } catch {
    return null;
  }
}

export async function releaseCallScreenWakeLock(lock: CallScreenWakeLock | null) {
  if (!lock || lock.released) return;
  try {
    await lock.release();
  } catch {
    // The browser may release the sentinel itself while hiding the page.
  }
}
