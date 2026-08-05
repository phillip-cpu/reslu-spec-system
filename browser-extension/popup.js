(function installPopup() {
  "use strict";
  const extension = globalThis.browser || globalThis.chrome;
  const contextEl = document.getElementById("context");
  const statusEl = document.getElementById("status");
  const button = document.getElementById("import");
  let context = null;

  function storageGet(key) {
    if (globalThis.browser) return extension.storage.local.get(key);
    return new Promise((resolve) => {
      extension.storage.local.get(key, (value) => resolve(value));
    });
  }

  function queryActiveTab() {
    if (globalThis.browser) return extension.tabs.query({ active: true, currentWindow: true });
    return new Promise((resolve) => {
      extension.tabs.query({ active: true, currentWindow: true }, resolve);
    });
  }

  function sendMessage(tabId, message) {
    if (globalThis.browser) return extension.tabs.sendMessage(tabId, message);
    return new Promise((resolve, reject) => {
      const callback = (response) => {
        const error = extension.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      };
      extension.tabs.sendMessage(tabId, message, callback);
    });
  }

  function createTab(url) {
    if (globalThis.browser) return extension.tabs.create({ url });
    return new Promise((resolve) => extension.tabs.create({ url }, resolve));
  }

  storageGet("lastResluProject").then((stored) => {
    context = stored?.lastResluProject || null;
    contextEl.textContent = context?.projectName
      ? `Project context: ${context.projectName}`
      : "You can choose the RESLU project during review.";
  });

  button.addEventListener("click", async () => {
    button.disabled = true;
    statusEl.className = "status";
    statusEl.textContent = "Reading product details from this open page…";
    try {
      const [tab] = await queryActiveTab();
      if (!tab?.id) throw new Error("The current browser tab could not be read.");
      const result = await sendMessage(tab.id, { type: "RESLU_EXTRACT_PRODUCT" });
      if (!result?.ok) throw new Error(result?.error || "No supported product was found.");
      const payload = result.payload;
      if (context?.projectId) {
        payload.context = {
          projectId: context.projectId,
          projectName: context.projectName || undefined,
        };
      }
      const fragment = encodeURIComponent(JSON.stringify(payload));
      await createTab(`https://spec.reslu.com.au/product-import#${fragment}`);
      window.close();
    } catch (reason) {
      statusEl.className = "status error";
      statusEl.textContent = reason instanceof Error ? reason.message : "The product could not be read.";
      button.disabled = false;
    }
  });
})();
