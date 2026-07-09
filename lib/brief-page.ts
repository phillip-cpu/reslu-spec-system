// ============================================================
// RESLU Spec System — Lead flow round (migration 048)
// Serves emails/brief/project-brief.html (the designer's self-contained
// pre-visit questionnaire) at GET /brief/[token]. Mirrors
// lib/visit-emails.ts's loadTemplate() convention exactly: read off
// disk once (process.cwd()-relative — correct both locally and on
// Vercel), cache in-module for the life of the warm serverless
// instance, never re-read per request.
//
// No runtime templating happens here — the shipped file already has
// its submit endpoint wired directly (see emails/brief/project-brief
// .html's own `form.addEventListener('submit', ...)` block: it posts
// to `/api/brief-submit/<token>`, reading the token from
// `location.pathname` client-side rather than needing it baked in
// server-side). The page also has no `{{placeholder}}` tokens at all
// (confirmed by grep before this round shipped — the designer's page
// fills itself in client-side as the client types), so ONE cached
// HTML string, read once, is correct for every lead's /brief/[token]
// URL — this function is a plain disk-read-plus-cache, nothing more.
// docs/RESLU-lead-flow-brief.md's own Rules section — "Do not modify
// the card HTML beyond inserting the endpoint URL and merge values" —
// is exactly what was done directly in the file itself, not here.
// ============================================================

import { readFile } from "fs/promises";
import path from "path";

let cached: string | null = null;

/**
 * Reads emails/brief/project-brief.html off disk, cached after first
 * read. Throws if the file is missing/unreadable — GET /brief/[token]
 * catches this and returns a 500 rather than crashing, same "never
 * silently degrade a public-facing page" posture as lib/visit-
 * emails.ts's loadTemplate().
 */
export async function loadBriefPageHtml(): Promise<string> {
  if (cached !== null) return cached;
  const filePath = path.join(process.cwd(), "emails", "brief", "project-brief.html");
  cached = await readFile(filePath, "utf8");
  return cached;
}
