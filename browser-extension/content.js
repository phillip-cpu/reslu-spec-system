(function installResluContentScript() {
  "use strict";
  const extension = globalThis.browser || globalThis.chrome;
  const host = location.hostname.toLowerCase();

  if (host === "spec.reslu.com.au") {
    const match = location.pathname.match(/^\/projects\/([^/]+)/);
    if (match) {
      const projectName = document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() || "";
      extension.storage.local.set({
        lastResluProject: {
          projectId: decodeURIComponent(match[1]),
          projectName: projectName.slice(0, 200),
          capturedAt: new Date().toISOString(),
        },
      });
    }
  }

  extension.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "RESLU_EXTRACT_PRODUCT") return undefined;
    if (!/(^|\.)bunnings\.com\.au$/i.test(host)) {
      sendResponse({ ok: false, error: "Open a supported Bunnings product page first." });
      return false;
    }
    sendResponse(globalThis.ResluProductExtractor.extractBunnings(document, location.href));
    return false;
  });
})();
