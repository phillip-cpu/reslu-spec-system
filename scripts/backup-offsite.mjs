#!/usr/bin/env node
// ============================================================
// RESLU Spec System — offsite weekly backup
// BUILD-SPEC.md Phase 14 "Backups": "offsite weekly export (DB +
// storage manifest)". Runs ON THE MINI (Aria's Mac mini — see
// BUILD-SPEC.md "Code home & dev machine migration"), NOT on Vercel —
// this is a scheduled local job (launchd example at the bottom of this
// file's header, and in docs/RUNBOOK.md), independent of Supabase's
// own managed backups (Dashboard → Database → Backups / PITR — see
// docs/RUNBOOK.md's disaster-recovery section). Two independent copies
// of the same data, on two different providers, is the point: if
// Supabase's own backup/PITR is ever unavailable (account issue,
// billing lapse, regional outage), this mirror is a second place to
// restore from.
//
// Plain Node, ESM (.mjs), ZERO new dependencies — mirrors
// scripts/import-monday-leads.mjs's own convention exactly
// (@supabase/supabase-js only, resolved from the app's own
// node_modules; no package.json of its own). pg_dump is invoked via
// child_process IF it's installed on the mini (`brew install
// libpq` or the full Postgres.app gives you `pg_dump` — see
// docs/RUNBOOK.md for the one-time mini setup); if it's not found,
// the DB-dump step is skipped with a loud warning rather than failing
// the whole run, since the storage mirror (the bigger, slower part —
// original product images, spec-sheet PDFs, signed contracts, site
// photos) is still valuable on its own.
//
// What this script does, per run:
//   1. pg_dump the whole Supabase Postgres database (schema + data) to
//      a timestamped .sql.gz in this week's backup folder, IF pg_dump
//      is available and SUPABASE_DB_URL is set.
//   2. Lists every object in every Storage bucket (assets, item-images
//      — see lib/storage.ts) via the Storage API (service-role key)
//      and downloads any object that's new or changed since the last
//      run (compared by size + etag, recorded in manifest.json) into a
//      local mirror directory — INCREMENTAL, so a weekly re-run only
//      transfers what changed, not the whole bucket every time.
//   3. Writes manifest.json (one per weekly folder) — bucket, path,
//      size, etag, downloaded-at — the CSV was considered but a single
//      JSON is easier for both a human and a future
//      restore/verification script to read.
//   4. Retention: keeps the last 8 weekly folders (~2 months), deletes
//      older ones. 8 was chosen to comfortably survive "nobody noticed
//      for a month" without the mini's disk filling up indefinitely —
//      revisit if the storage footprint grows a lot faster than
//      expected (see docs/RUNBOOK.md's disk-space note).
//
// Env required:
//   NEXT_PUBLIC_SUPABASE_URL       — same as the app's .env.local
//   SUPABASE_SERVICE_ROLE_KEY      — same as the app's .env.local
//   SUPABASE_DB_URL                — Postgres connection string for
//                                    pg_dump (Supabase Dashboard →
//                                    Settings → Database → Connection
//                                    string → "URI", the one with the
//                                    real password in it — NOT the
//                                    pooler URL if pg_dump complains
//                                    about it; direct connection is
//                                    simplest for a nightly/weekly
//                                    dump). Optional — DB step is
//                                    skipped (with a warning) if unset.
//   BACKUP_ROOT                    — local directory to write backups
//                                    into. Defaults to
//                                    ~/reslu-backups (a NORMAL folder,
//                                    never iCloud Drive — same
//                                    "iCloud chokes on lots of small
//                                    files" reasoning BUILD-SPEC.md
//                                    already gives for node_modules).
//
// Run manually:
//   NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=xxx \
//   SUPABASE_DB_URL="postgresql://postgres:...@...supabase.co:5432/postgres" \
//   node scripts/backup-offsite.mjs
//
// Scheduled (launchd, weekly) — see docs/RUNBOOK.md for the full plist
// example and installation steps.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.SUPABASE_DB_URL;
const BACKUP_ROOT = process.env.BACKUP_ROOT || path.join(os.homedir(), "reslu-backups");

// Buckets this app actually uses — see lib/storage.ts (ASSET_BUCKET =
// "assets") and lib/images.ts (PDF_IMAGE_BUCKET = "item-images").
// Hardcoded rather than "list all buckets" so a stray/test bucket
// created in the Supabase dashboard is never silently swept into a
// production backup without a deliberate code change here.
const BUCKETS = ["assets", "item-images"];

const RETENTION_WEEKS = 8;

function isoWeekFolderName(date = new Date()) {
  // ISO week-numbered folder, e.g. "2026-W27" — stable, sortable,
  // one folder per calendar week regardless of which day the job runs.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

async function commandExists(cmd) {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function dumpDatabase(weekDir) {
  if (!DB_URL) {
    console.warn(
      "[backup-offsite] SUPABASE_DB_URL not set — skipping database dump. " +
        "Storage mirror will still run. See docs/RUNBOOK.md to configure."
    );
    return { ran: false, reason: "SUPABASE_DB_URL not set" };
  }
  const hasPgDump = await commandExists("pg_dump");
  if (!hasPgDump) {
    console.warn(
      "[backup-offsite] pg_dump not found on PATH — skipping database dump. " +
        "Install via `brew install libpq` (and add it to PATH) or Postgres.app. " +
        "See docs/RUNBOOK.md."
    );
    return { ran: false, reason: "pg_dump not installed" };
  }

  const outPath = path.join(weekDir, `db-${Date.now()}.sql.gz`);
  console.log(`[backup-offsite] Running pg_dump -> ${outPath}`);

  // --no-owner/--no-privileges: a restore target (a fresh Supabase
  // project during a disaster-recovery drill) will have its own
  // roles/ownership; forcing this dump's original owners onto a
  // restore is a common source of "permission denied" restore
  // failures. --format=plain (default) piped through gzip ourselves
  // keeps this dependency-free (no need for pg_restore's custom format
  // tooling to inspect/verify the file later — `zcat file.sql.gz | less`
  // works with nothing but a text editor).
  const child = execFile("pg_dump", [
    DB_URL,
    "--no-owner",
    "--no-privileges",
    "--format=plain",
  ], { maxBuffer: 1024 * 1024 * 1024 });

  // Guard against the narrow race where commandExists() found pg_dump
  // on PATH a moment ago but the spawn itself still fails (ENOENT if
  // it was removed between the check and the spawn, EACCES, etc.) —
  // without this handler, that failure surfaces as an unhandled
  // 'error' event on the child process and crashes the whole script
  // instead of being caught by main()'s .catch(). Collected into the
  // same rejection path pipeline() below already throws into, so
  // dumpDatabase()'s caller (main()) sees one consistent failure mode
  // either way.
  const spawnError = new Promise((_, reject) => {
    child.on("error", reject);
  });

  const gzip = zlib.createGzip();
  const out = createWriteStream(outPath);

  await Promise.race([pipeline(child.stdout, gzip, out), spawnError]);

  const { code } = await new Promise((resolve) => {
    child.on("close", (code) => resolve({ code }));
    child.on("error", () => resolve({ code: -1 }));
  });
  if (code !== 0) {
    throw new Error(`pg_dump exited with code ${code}`);
  }

  const { size } = await stat(outPath);
  console.log(`[backup-offsite] Database dump complete: ${(size / 1024 / 1024).toFixed(1)} MB`);
  return { ran: true, path: outPath, sizeBytes: size };
}

async function loadPreviousManifest() {
  // "Incremental, skipping unchanged by size/etag" needs to know what
  // was already downloaded in an EARLIER run — read the most recent
  // prior week's manifest.json (if any) as the baseline. Falls back to
  // an empty baseline on the very first run, or if no prior manifest
  // parses cleanly (never blocks the backup over a corrupt old file).
  if (!existsSync(BACKUP_ROOT)) return new Map();
  const entries = await readdir(BACKUP_ROOT, { withFileTypes: true });
  const weekDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  for (const dir of weekDirs) {
    const manifestPath = path.join(BACKUP_ROOT, dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw);
      const map = new Map();
      for (const entry of parsed.objects ?? []) {
        map.set(`${entry.bucket}/${entry.path}`, entry);
      }
      return map;
    } catch {
      continue; // corrupt manifest — try an older one
    }
  }
  return new Map();
}

/** Recursively lists every object in a bucket (Supabase Storage's list() is one-level-at-a-time). */
async function listAllObjects(supabase, bucket, prefix = "") {
  const results = [];
  const { data, error } = await supabase.storage.from(bucket).list(prefix, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) {
    console.warn(`[backup-offsite] Could not list ${bucket}/${prefix}: ${error.message}`);
    return results;
  }
  for (const item of data ?? []) {
    const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id === null) {
      // A folder placeholder (no id, no metadata) — recurse into it.
      const nested = await listAllObjects(supabase, bucket, fullPath);
      results.push(...nested);
    } else {
      results.push({
        bucket,
        path: fullPath,
        size: item.metadata?.size ?? null,
        etag: item.metadata?.eTag ?? item.metadata?.etag ?? null,
        updated_at: item.updated_at ?? null,
      });
    }
  }
  return results;
}

async function mirrorStorage(supabase, weekDir, previousManifest) {
  const mirrorDir = path.join(weekDir, "storage");
  await mkdir(mirrorDir, { recursive: true });

  const manifestObjects = [];
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const bucket of BUCKETS) {
    console.log(`[backup-offsite] Listing bucket "${bucket}"...`);
    const objects = await listAllObjects(supabase, bucket);
    console.log(`[backup-offsite]   ${objects.length} objects found`);

    for (const obj of objects) {
      const key = `${obj.bucket}/${obj.path}`;
      const prior = previousManifest.get(key);
      const unchanged =
        prior &&
        prior.size === obj.size &&
        (obj.etag ? prior.etag === obj.etag : true);

      const localPath = path.join(mirrorDir, obj.bucket, obj.path);

      if (unchanged && existsSync(localPath)) {
        skipped += 1;
        manifestObjects.push({ ...obj, downloaded_at: prior.downloaded_at, skipped: true });
        continue;
      }

      try {
        const { data, error } = await supabase.storage.from(obj.bucket).download(obj.path);
        if (error || !data) throw error ?? new Error("empty download");
        await mkdir(path.dirname(localPath), { recursive: true });
        const bytes = Buffer.from(await data.arrayBuffer());
        await writeFile(localPath, bytes);
        downloaded += 1;
        manifestObjects.push({ ...obj, downloaded_at: new Date().toISOString(), skipped: false });
      } catch (err) {
        failed += 1;
        console.warn(`[backup-offsite]   FAILED to download ${key}: ${err?.message ?? err}`);
        // Never abort the whole run over one bad object — record it as
        // failed in the manifest so a human can spot-check afterwards,
        // and move on to the next object.
        manifestObjects.push({ ...obj, downloaded_at: null, skipped: false, error: String(err?.message ?? err) });
      }
    }
  }

  console.log(
    `[backup-offsite] Storage mirror complete: ${downloaded} downloaded, ${skipped} unchanged/skipped, ${failed} failed`
  );

  return { downloaded, skipped, failed, objects: manifestObjects };
}

async function applyRetention() {
  if (!existsSync(BACKUP_ROOT)) return;
  const entries = await readdir(BACKUP_ROOT, { withFileTypes: true });
  const weekDirs = entries
    .filter((e) => e.isDirectory() && /^\d{4}-W\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort(); // ascending — oldest first

  const toDelete = weekDirs.slice(0, Math.max(0, weekDirs.length - RETENTION_WEEKS));
  for (const dir of toDelete) {
    console.log(`[backup-offsite] Retention: removing old backup folder ${dir}`);
    await rm(path.join(BACKUP_ROOT, dir), { recursive: true, force: true });
  }
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error(
      "[backup-offsite] NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."
    );
    process.exit(1);
  }

  const weekName = isoWeekFolderName();
  const weekDir = path.join(BACKUP_ROOT, weekName);
  await mkdir(weekDir, { recursive: true });
  console.log(`[backup-offsite] Backup folder: ${weekDir}`);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const startedAt = new Date().toISOString();

  const dbResult = await dumpDatabase(weekDir).catch((err) => {
    console.error(`[backup-offsite] Database dump failed: ${err.message}`);
    return { ran: false, reason: err.message };
  });

  const previousManifest = await loadPreviousManifest();
  const storageResult = await mirrorStorage(supabase, weekDir, previousManifest);

  await writeFile(
    path.join(weekDir, "manifest.json"),
    JSON.stringify(
      {
        week: weekName,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        database: dbResult,
        storage_summary: {
          downloaded: storageResult.downloaded,
          skipped: storageResult.skipped,
          failed: storageResult.failed,
          total: storageResult.objects.length,
        },
        objects: storageResult.objects,
      },
      null,
      2
    )
  );

  await applyRetention();

  console.log(`[backup-offsite] Done. Manifest written to ${path.join(weekDir, "manifest.json")}`);
  if (storageResult.failed > 0) {
    console.warn(
      `[backup-offsite] ${storageResult.failed} object(s) failed to download this run — check manifest.json's "error" fields.`
    );
  }
}

main().catch((err) => {
  console.error("[backup-offsite] Fatal error:", err);
  process.exit(1);
});
