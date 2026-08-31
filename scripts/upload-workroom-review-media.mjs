import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function manifestRows(content) {
  if (!Array.isArray(content?.asset_manifest)) return [];
  return content.asset_manifest.flatMap((row) => {
    const file = typeof row?.file === "string" ? basename(row.file) : null;
    const hash = typeof row?.sha256 === "string" ? row.sha256.toLowerCase() : null;
    return file && /^[a-f0-9]{64}$/.test(hash ?? "") ? [{ file, sha256: hash }] : [];
  });
}

function dimensions(output) {
  const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error("Could not read preview dimensions");
  return { width, height };
}

const artifactId = required(argument("--artifact"), "Pass --artifact <uuid>");
const sourceRoot = required(argument("--root"), "Pass --root <hydrated image folder>");
required(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL is missing");
required(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY is missing");

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: artifact, error: artifactError } = await supabase
  .from("agent_task_artifacts")
  .select("id,task_id,status,content")
  .eq("id", artifactId)
  .single();
if (artifactError) throw artifactError;
if (artifact.status !== "draft") throw new Error("Review media can only be attached to a draft artifact");

const manifest = manifestRows(artifact.content);
if (!manifest.length) throw new Error("The artifact has no hash-bound asset_manifest");

const temporaryRoot = await mkdtemp(join(tmpdir(), "reslu-workroom-review-"));
const uploaded = [];
try {
  for (const row of manifest) {
    const sourcePath = join(sourceRoot, row.file);
    if (basename(sourcePath) !== row.file) throw new Error(`Unsafe asset name: ${row.file}`);
    const sourceBytes = await readFile(sourcePath);
    const actualSourceHash = sha256(sourceBytes);
    if (actualSourceHash !== row.sha256) throw new Error(`Source hash mismatch for ${row.file}`);

    const previewPath = join(temporaryRoot, `${row.sha256}.jpg`);
    await execFileAsync("sips", [
      "-s", "format", "jpeg",
      "-s", "formatOptions", "82",
      "-Z", "1600",
      sourcePath,
      "--out", previewPath,
    ]);
    const previewBytes = await readFile(previewPath);
    const previewHash = sha256(previewBytes);
    const previewStat = await stat(previewPath);
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", previewPath]);
    const size = dimensions(stdout);
    const storagePath = `workroom/review-media/${artifactId}/${row.sha256}-${previewHash.slice(0, 12)}.jpg`;

    const { error: uploadError } = await supabase.storage
      .from("assets")
      .upload(storagePath, previewBytes, {
        contentType: "image/jpeg",
        cacheControl: "31536000",
        upsert: true,
      });
    if (uploadError) throw uploadError;

    const { error: mediaError } = await supabase
      .from("agent_task_artifact_media")
      .upsert({
        artifact_id: artifactId,
        asset_key: row.file,
        preview_storage_path: storagePath,
        source_sha256: row.sha256,
        preview_sha256: previewHash,
        mime_type: "image/jpeg",
        width: size.width,
        height: size.height,
        byte_size: previewStat.size,
      }, { onConflict: "artifact_id,asset_key" });
    if (mediaError) throw mediaError;
    uploaded.push({ asset: row.file, source_sha256: row.sha256, preview_sha256: previewHash, ...size, bytes: previewStat.size });
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ artifact_id: artifactId, uploaded }, null, 2));
