"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Messaging remains fully online-capable when service workers are
      // unavailable or disabled by the browser.
    });
  }, []);

  return null;
}
