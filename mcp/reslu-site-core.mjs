import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULT_SITE_ROOT = "/Users/vale/reslu-site";
const BLOCKED_SEGMENTS = new Set([".git", "node_modules", "dist", ".vercel"]);
const BLOCKED_BASENAMES = new Set([".env", ".env.local", ".env.production", ".env.development"]);

export function resolveSitePath(siteRoot, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("path is required");
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("path must stay inside the RESLU site repository");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => BLOCKED_SEGMENTS.has(part)) || BLOCKED_BASENAMES.has(parts.at(-1))) {
    throw new Error("path is not available through the RESLU site connector");
  }
  const root = fs.realpathSync(siteRoot);
  const target = path.resolve(root, ...parts);
  const parent = fs.existsSync(target) ? fs.realpathSync(target) : fs.realpathSync(path.dirname(target));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("path escapes the RESLU site repository");
  return { relative: parts.join("/"), absolute: target };
}

function run(command, args, { cwd, input, timeout = 180000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `${command} failed`).trim();
    throw new Error(detail.slice(0, 12000));
  }
  return (result.stdout || "").trim();
}

export function siteStatus(siteRoot = DEFAULT_SITE_ROOT) {
  return {
    root: siteRoot,
    branch: run("git", ["branch", "--show-current"], { cwd: siteRoot }),
    head: run("git", ["rev-parse", "HEAD"], { cwd: siteRoot }),
    status: run("git", ["status", "--short"], { cwd: siteRoot }).split("\n").filter(Boolean),
    tracking: trackingSourceStatus(siteRoot),
  };
}

export function trackingSourceStatus(siteRoot = DEFAULT_SITE_ROOT) {
  const formPath = resolveSitePath(siteRoot, "src/components/BeginForm.astro").absolute;
  const basePath = resolveSitePath(siteRoot, "src/layouts/Base.astro").absolute;
  const form = fs.readFileSync(formPath, "utf8");
  const base = fs.readFileSync(basePath, "utf8");
  return {
    beginFormCompletedLabelPresent: form.includes("AW-16784006257/hL8XCIOVl9gcEPG4nsM-"),
    obsoleteContactSubmitLabelPresent: form.includes("AW-16784006257/XsWNCM__r7AaEPG4nsM-"),
    generateLeadEventPresent: /gtag\(['\"]event['\"],\s*['\"]generate_lead['\"]/.test(form),
    metaLeadEventPresent: /fbq\(['\"]track['\"],\s*['\"]Lead['\"]/.test(form),
    globalAdsConfigPresent: base.includes("gtag('config', 'AW-16784006257')") || base.includes('gtag("config", "AW-16784006257")'),
    globalGtagExposed: base.includes("window.gtag = gtag"),
  };
}

export function readSiteFile(relativePath, siteRoot = DEFAULT_SITE_ROOT) {
  const resolved = resolveSitePath(siteRoot, relativePath);
  const stat = fs.statSync(resolved.absolute);
  if (!stat.isFile()) throw new Error("path is not a file");
  if (stat.size > 300000) throw new Error("file is too large for chat; use a narrower source file");
  return { path: resolved.relative, content: fs.readFileSync(resolved.absolute, "utf8") };
}

export function siteDiff(paths = [], siteRoot = DEFAULT_SITE_ROOT) {
  const safePaths = paths.map((item) => resolveSitePath(siteRoot, item).relative);
  const args = ["diff", "--"];
  if (safePaths.length) args.push(...safePaths);
  return { paths: safePaths, diff: run("git", args, { cwd: siteRoot }) };
}

function patchPaths(patchText) {
  if (typeof patchText !== "string" || !patchText.trim()) throw new Error("patch is required");
  const found = [];
  for (const line of patchText.split("\n")) {
    const match = /^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t ]+)/.exec(line);
    if (match && match[1] !== "/dev/null") found.push(match[1]);
  }
  if (!found.length) throw new Error("patch does not contain file headers");
  return [...new Set(found)];
}

export function applySitePatch(patchText, siteRoot = DEFAULT_SITE_ROOT) {
  const paths = patchPaths(patchText).map((item) => resolveSitePath(siteRoot, item).relative);
  run("git", ["apply", "--check", "-"], { cwd: siteRoot, input: patchText });
  run("git", ["apply", "--whitespace=fix", "-"], { cwd: siteRoot, input: patchText });
  return { changedPaths: paths, diff: siteDiff(paths, siteRoot).diff };
}

export function replaceSiteText({ path: relativePath, oldText, newText, expectedOccurrences = 1 }, siteRoot = DEFAULT_SITE_ROOT) {
  if (typeof oldText !== "string" || !oldText.length) throw new Error("oldText must be a non-empty string");
  if (typeof newText !== "string") throw new Error("newText must be a string");
  if (!Number.isInteger(expectedOccurrences) || expectedOccurrences < 1) {
    throw new Error("expectedOccurrences must be a positive integer");
  }
  const resolved = resolveSitePath(siteRoot, relativePath);
  const current = fs.readFileSync(resolved.absolute, "utf8");
  const occurrences = current.split(oldText).length - 1;
  if (occurrences !== expectedOccurrences) {
    throw new Error(`oldText occurrence mismatch: expected ${expectedOccurrences}, found ${occurrences}`);
  }
  fs.writeFileSync(resolved.absolute, current.split(oldText).join(newText), "utf8");
  return {
    changedPaths: [resolved.relative],
    replacements: occurrences,
    diff: siteDiff([resolved.relative], siteRoot).diff,
  };
}

export function runSiteChecks(siteRoot = DEFAULT_SITE_ROOT) {
  return { output: run("npm", ["run", "check"], { cwd: siteRoot, timeout: 600000 }) };
}

export function deploySiteFiles({ paths, commitMessage, confirm }, siteRoot = DEFAULT_SITE_ROOT) {
  if (confirm !== true) throw new Error("confirm must be true because this commits, pushes, and triggers the Vercel deployment");
  if (!Array.isArray(paths) || !paths.length) throw new Error("at least one explicit file path is required");
  if (typeof commitMessage !== "string" || commitMessage.trim().length < 8) throw new Error("a descriptive commitMessage is required");
  const safePaths = [...new Set(paths.map((item) => resolveSitePath(siteRoot, item).relative))];
  const branch = run("git", ["branch", "--show-current"], { cwd: siteRoot });
  if (!branch) throw new Error("cannot deploy from a detached HEAD");
  const changed = run("git", ["status", "--short", "--", ...safePaths], { cwd: siteRoot });
  if (!changed) throw new Error("none of the selected files has changes to deploy");
  const stagedBefore = run("git", ["diff", "--cached", "--name-only"], { cwd: siteRoot }).split("\n").filter(Boolean);
  const unrelatedStaged = stagedBefore.filter((item) => !safePaths.includes(item));
  if (unrelatedStaged.length) throw new Error(`unrelated staged files must be resolved first: ${unrelatedStaged.join(", ")}`);
  const checks = runSiteChecks(siteRoot).output;
  run("git", ["add", "--", ...safePaths], { cwd: siteRoot });
  run("git", ["commit", "-m", commitMessage.trim(), "--", ...safePaths], { cwd: siteRoot });
  const push = run("git", ["push", "origin", branch], { cwd: siteRoot, timeout: 300000 });
  return {
    branch,
    committedPaths: safePaths,
    head: run("git", ["rev-parse", "HEAD"], { cwd: siteRoot }),
    checks: checks.slice(-4000),
    push,
    deployment: "Vercel auto-deploy is triggered by the Git push.",
  };
}

export async function liveTrackingSurface(url = "https://www.reslu.com.au") {
  const parsed = new URL(url);
  if (!["reslu.com.au", "www.reslu.com.au"].includes(parsed.hostname) || parsed.protocol !== "https:") {
    throw new Error("url must be an HTTPS page on reslu.com.au");
  }
  const response = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(20000) });
  const html = await response.text();
  return {
    url: response.url,
    status: response.status,
    googleTagLoaderPresent: html.includes("googletagmanager.com/gtag/js"),
    adsAccountIdPresent: html.includes("AW-16784006257"),
    ga4LoaderPresent: /googletagmanager\.com\/gtag\/js\?id=G-/.test(html),
    note: "This verifies the deployed tag surface only. Use the browser request log during a controlled form submission to prove event emission.",
  };
}

export function summarizeTrackingRequests(requests) {
  const observed = [];
  for (const request of Array.isArray(requests) ? requests : []) {
    let parsed;
    try { parsed = new URL(request.url); } catch { continue; }
    const host = parsed.hostname;
    const pathName = parsed.pathname;
    let kind = null;
    if (host === "www.googletagmanager.com") kind = "google_tag_loader";
    else if (host.endsWith("google-analytics.com") && pathName.includes("/g/collect")) kind = "ga4_collect";
    else if (host === "googleads.g.doubleclick.net" && pathName.includes("viewthroughconversion")) kind = "google_ads_config";
    else if ((host === "www.google.com" || host === "www.google.com.au") && pathName.includes("/ccm/collect")) kind = "google_ads_page_view";
    else if (host === "www.googleadservices.com" && pathName.includes("/pagead/conversion/")) {
      kind = pathName.endsWith("/wcm") ? "google_ads_phone_swap" : "google_ads_conversion";
    } else if ((host === "www.facebook.com" || host === "facebook.com") && pathName === "/tr/") kind = "meta_pixel";
    if (!kind) continue;
    observed.push({
      kind,
      method: request.method,
      host,
      path: pathName,
      status: request.status ?? null,
      ok: request.ok ?? null,
      event: parsed.searchParams.get("en"),
      tagId: parsed.searchParams.get("tid"),
      conversionLabel: parsed.searchParams.get("label") || parsed.searchParams.get("cl"),
    });
  }
  return {
    requests: observed,
    pageLoadTagTrafficObserved: observed.some((item) => ["google_ads_config", "google_ads_page_view", "ga4_collect", "meta_pixel"].includes(item.kind)),
    conversionEventObserved: observed.some((item) => item.kind === "google_ads_conversion"),
    beginFormCompletedObserved: observed.some((item) => item.kind === "google_ads_conversion" && (item.conversionLabel === "hL8XCIOVl9gcEPG4nsM-" || item.path.includes("hL8XCIOVl9gcEPG4nsM-"))),
  };
}

export function captureLiveTagRequests(url = "https://www.reslu.com.au", { controlledSubmission = false, confirm = false } = {}) {
  const parsed = new URL(url);
  if (!["reslu.com.au", "www.reslu.com.au"].includes(parsed.hostname) || parsed.protocol !== "https:") {
    throw new Error("url must be an HTTPS page on reslu.com.au");
  }
  run("openclaw", ["browser", "start", "--headless", "--json"], { timeout: 60000 });
  const opened = JSON.parse(run("openclaw", ["browser", "--json", "open", parsed.href], { timeout: 60000 }));
  run("openclaw", ["browser", "--json", "wait", "--load", "networkidle"], { timeout: 60000 });
  if (controlledSubmission) {
    if (confirm !== true) throw new Error("confirm must be true for a controlled form submission");
    if (!parsed.pathname.startsWith("/begin")) throw new Error("controlledSubmission requires a /begin page");
    const script = `async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const calls = [];
      const testId = 'reslu-browser-test-' + Date.now();
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const raw = typeof input === 'string' ? input : (input && input.url) || '';
        const requestUrl = new URL(raw, location.href);
        if (requestUrl.pathname === '/api/enquiry') {
          return new Response(JSON.stringify({ ok: true, accepted: true, bot: false, event_id: testId, ec: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(input, init);
      };
      window.gtag = (...args) => calls.push({ platform: 'google', args });
      window.fbq = (...args) => calls.push({ platform: 'meta', args });
      const setValue = (selector, value) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error('missing form element: ' + selector);
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const service = document.querySelector('#service button[data-value]');
      if (!service) throw new Error('service choice unavailable');
      service.click();
      await wait(1800);
      const room = document.querySelector('#rooms button[data-room]');
      if (!room) throw new Error('room choice unavailable');
      room.click();
      document.querySelector('#rooms-continue')?.click();
      await wait(1200);
      setValue('#message', 'Synthetic browser wiring test — no enquiry delivered.');
      document.querySelector('.step.on [data-next]')?.click();
      await wait(300);
      setValue('#fn', 'Tracking');
      setValue('#ln', 'Test');
      setValue('#em', 'tracking-test@reslu.invalid');
      setValue('#suburb', 'Adelaide');
      document.querySelector('#begin-form')?.requestSubmit();
      await wait(2200);
      const conversion = calls.find((call) => call.platform === 'google' && call.args?.[0] === 'event' && call.args?.[1] === 'conversion');
      const generateLead = calls.find((call) => call.platform === 'google' && call.args?.[0] === 'event' && call.args?.[1] === 'generate_lead');
      const metaLead = calls.find((call) => call.platform === 'meta' && call.args?.[0] === 'track' && call.args?.[1] === 'Lead');
      return {
        testId,
        formAccepted: document.querySelector('#begin-form')?.style.visibility === 'hidden',
        conversion: conversion || null,
        generateLead: generateLead || null,
        metaLead: metaLead || null,
        interceptedEnquiry: true,
        providerRequestsSuppressed: true,
      };
    }`;
    const evaluation = JSON.parse(run("openclaw", ["browser", "--json", "evaluate", "--fn", script], { timeout: 60000 }));
    return {
      url: evaluation.url || opened.url || parsed.href,
      targetId: evaluation.targetId || opened.targetId || null,
      controlledSubmission: evaluation.result,
      note: "The live form UI and submit handler ran against an intercepted synthetic accepted response. No CRM lead, email, Google conversion, or Meta event was transmitted.",
    };
  }
  const log = JSON.parse(run("openclaw", ["browser", "--json", "requests"], { timeout: 60000 }));
  return {
    url: log.url || opened.url || parsed.href,
    targetId: log.targetId || opened.targetId || null,
    ...summarizeTrackingRequests(log.requests),
    note: "This reports observed network traffic for the page load. A form conversion requires a controlled submission and a second capture.",
  };
}
