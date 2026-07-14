import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { embedTexts } from "@/lib/second-brain/embeddings";
import {
  contentForProject,
  contentForLead,
  contentForItem,
  contentForDiary,
  contentForSow,
  contentForEmail,
  contentForMemory,
  type ContentEntityType,
  type IndexableProject,
  type IndexableLead,
  type IndexableItem,
  type IndexablePortalUpdate,
  type IndexableSowDocument,
  type IndexableEmail,
  type IndexableBrainNote,
} from "@/lib/second-brain/content-for";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/**
 * GET /api/second-brain/reindex — Vercel Cron entry point (hourly), also
 * the manual-trigger and future index_rebuild (Step 12) MCP tool target.
 *
 * RESLU Second Brain, Step 5 (docs/RESLU-second-brain-build-brief.md).
 * Populates workspace_index (migration 035, Step 4) from the core CRM
 * records plus email history and durable brain_notes:
 * projects, leads, items, portal_updates ("diary" — the brief assumed
 * a diary_entries table that doesn't exist), and sow_documents joined
 * through sow_sections/sow_lines (the brief assumed a single
 * sow_entries table that also doesn't exist — see lib/second-brain/
 * content-for.ts's header for both corrections). Local OpenClaw
 * `skill` files remain out of scope because Vercel
 * cannot reach Aria's Mac-mini filesystem.
 *
 * Auth mirrors app/api/digest/flush + app/api/leads/queue-sync exactly:
 * Bearer CRON_SECRET (real cron entry) or an authenticated team session
 * (manual trigger). Optional ?entity_type= scopes a run to one type —
 * costs nothing to support now, and is what Step 12's index_rebuild
 * tool will call.
 *
 * Email indexing is deliberately limited to one changed 500-row page
 * per invocation. In-process ONNX inference stays below Vercel's memory
 * limit with eight texts per batch, and the hourly schedule advances the
 * backlog without risking a five-minute timeout. Already-indexed pages
 * are hash-checked and skipped quickly on the next run.
 *
 * Chunking: an optional ?cursor= (JSON: {phase, entityTypeIndex,
 * offset}) lets a run that exceeds TIME_BUDGET_MS self-invoke and
 * continue rather than hit Vercel's function timeout. At this app's
 * actual data scale (a boutique studio — low hundreds of records
 * total across all 5 types) this is expected to complete in a single
 * invocation in practice; the mechanism exists because the brief asks
 * for it as a safety net, not because self-invocation is expected to
 * fire.
 */

const ALL_ENTITY_TYPES: ContentEntityType[] = ["project", "lead", "item", "diary", "sow", "memory", "email"];
const PAGE_SIZE = 500;
const TIME_BUDGET_MS = 4 * 60 * 1000; // 4 minutes — comfortable margin under Vercel's 300s default.

type Cursor = { phase: "index" | "cleanup"; entityTypeIndex: number; offset: number };

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { phase: "index", entityTypeIndex: 0, offset: 0 };
  try {
    const parsed = JSON.parse(raw);
    if (
      (parsed.phase === "index" || parsed.phase === "cleanup") &&
      typeof parsed.entityTypeIndex === "number" &&
      typeof parsed.offset === "number"
    ) {
      return parsed;
    }
  } catch {
    // Falls through to the default below.
  }
  return { phase: "index", entityTypeIndex: 0, offset: 0 };
}

type Row = { id: string; title: string; content: string };

async function fetchProjectPage(supabase: SupabaseClient, offset: number): Promise<Row[]> {
  const { data, error } = await supabase
    .from("projects")
    .select("id,name,client_name,address,status,alias,job_number")
    .is("deleted_at", null)
    .order("id")
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw new Error(`projects fetch failed: ${error.message}`);
  return (data as IndexableProject[]).map((p) => ({ id: p.id, ...contentForProject(p) }));
}

async function fetchLeadPage(supabase: SupabaseClient, offset: number): Promise<Row[]> {
  const { data, error } = await supabase
    .from("leads")
    .select("id,first_name,surname_project,stage,source,location,email,phone")
    .is("deleted_at", null)
    .order("id")
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw new Error(`leads fetch failed: ${error.message}`);
  return (data as IndexableLead[]).map((l) => ({ id: l.id, ...contentForLead(l) }));
}

async function fetchItemPage(supabase: SupabaseClient, offset: number): Promise<Row[]> {
  const { data, error } = await supabase
    .from("items")
    .select(
      "id,item_code,name,category,description,supplier,brand,location,colour,material,finish,status,price_rrp,price_trade"
    )
    .is("deleted_at", null)
    .order("id")
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw new Error(`items fetch failed: ${error.message}`);
  return (data as IndexableItem[]).map((i) => ({ id: i.id, ...contentForItem(i) }));
}

async function fetchDiaryPage(supabase: SupabaseClient, offset: number): Promise<Row[]> {
  const { data, error } = await supabase
    .from("portal_updates")
    .select("id,title,body_richtext")
    .is("deleted_at", null)
    .order("id")
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw new Error(`portal_updates fetch failed: ${error.message}`);
  return (data as IndexablePortalUpdate[]).map((d) => ({ id: d.id, ...contentForDiary(d) }));
}

async function fetchSowPage(supabase: SupabaseClient, offset: number): Promise<Row[]> {
  const { data: docs, error } = await supabase
    .from("sow_documents")
    .select("id,revision_label,project_id,projects(name)")
    .is("deleted_at", null)
    .order("id")
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw new Error(`sow_documents fetch failed: ${error.message}`);
  // projects(name) is a many-to-one embed (many sow_documents -> one
  // project) — PostgREST returns it as a single object, not an array,
  // confirmed against the live API (the generic supabase-js client's
  // own inferred type claims an array here, which is wrong for this
  // relationship direction; this repo has no generated Database type
  // to catch that mismatch at compile time).
  const typedDocs = (docs ?? []) as unknown as {
    id: string;
    revision_label: string | null;
    project_id: string;
    projects: { name: string } | null;
  }[];
  if (typedDocs.length === 0) return [];

  const docIds = typedDocs.map((d) => d.id);
  const { data: sections, error: secErr } = await supabase
    .from("sow_sections")
    .select("id,sow_id,heading,sort")
    .in("sow_id", docIds)
    .order("sort");
  if (secErr) throw new Error(`sow_sections fetch failed: ${secErr.message}`);
  const typedSections = (sections ?? []) as { id: string; sow_id: string; heading: string | null; sort: number }[];

  const sectionIds = typedSections.map((s) => s.id);
  const { data: lines, error: lineErr } = sectionIds.length
    ? await supabase.from("sow_lines").select("id,section_id,text,sort").in("section_id", sectionIds).order("sort")
    : { data: [], error: null };
  if (lineErr) throw new Error(`sow_lines fetch failed: ${lineErr.message}`);
  const typedLines = (lines ?? []) as { id: string; section_id: string; text: string; sort: number }[];

  const linesBySection = new Map<string, string[]>();
  for (const line of typedLines) {
    const arr = linesBySection.get(line.section_id) ?? [];
    arr.push(line.text);
    linesBySection.set(line.section_id, arr);
  }
  const sectionsByDoc = new Map<string, { heading: string | null; lines: string[] }[]>();
  for (const section of typedSections) {
    const arr = sectionsByDoc.get(section.sow_id) ?? [];
    arr.push({ heading: section.heading, lines: linesBySection.get(section.id) ?? [] });
    sectionsByDoc.set(section.sow_id, arr);
  }

  return typedDocs.map((d) => {
    const indexable: IndexableSowDocument = {
      id: d.id,
      revision_label: d.revision_label,
      project_name: d.projects?.name ?? "(unknown project)",
      sections: sectionsByDoc.get(d.id) ?? [],
    };
    return { id: d.id, ...contentForSow(indexable) };
  });
}

async function fetchEmailPage(supabase: SupabaseClient, offset: number): Promise<Row[]> {
  const { data, error } = await supabase
    .from("emails")
    .select("id,from_addr,subject,received_at,direction,clean_text,triage_label,status,matched_project_id")
    .order("id")
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw new Error(`emails fetch failed: ${error.message}`);
  const emails = (data ?? []) as Omit<IndexableEmail, "attachment_text">[];
  if (emails.length === 0) return [];

  const { data: attachments, error: attachmentsError } = await supabase
    .from("email_attachments")
    .select("email_id,filename,extracted_text")
    .in("email_id", emails.map((email) => email.id));
  if (attachmentsError) throw new Error(`email_attachments fetch failed: ${attachmentsError.message}`);

  const attachmentsByEmail = new Map<string, string[]>();
  for (const attachment of attachments ?? []) {
    if (!attachment.extracted_text) continue;
    const current = attachmentsByEmail.get(attachment.email_id) ?? [];
    current.push(`${attachment.filename || "Attachment"}: ${attachment.extracted_text}`);
    attachmentsByEmail.set(attachment.email_id, current);
  }

  return emails.map((email) => ({
    id: email.id,
    ...contentForEmail({
      ...email,
      attachment_text: attachmentsByEmail.get(email.id)?.join("\n\n") ?? null,
    }),
  }));
}

async function fetchMemoryPage(supabase: SupabaseClient, offset: number): Promise<Row[]> {
  const { data, error } = await supabase
    .from("brain_notes")
    .select("id,title,body,tags,source,source_ref,confidence,created_at")
    .order("id")
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw new Error(`brain_notes fetch failed: ${error.message}`);
  return (data as IndexableBrainNote[]).map((note) => ({
    id: note.id,
    ...contentForMemory(note),
  }));
}

const FETCHERS: Record<ContentEntityType, (supabase: SupabaseClient, offset: number) => Promise<Row[]>> = {
  project: fetchProjectPage,
  lead: fetchLeadPage,
  item: fetchItemPage,
  diary: fetchDiaryPage,
  sow: fetchSowPage,
  email: fetchEmailPage,
  memory: fetchMemoryPage,
};

async function fetchLiveIds(supabase: SupabaseClient, entityType: ContentEntityType): Promise<Set<string>> {
  const ids = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = await FETCHERS[entityType](supabase, offset);
    if (page.length === 0) break;
    for (const row of page) ids.add(row.id);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return ids;
}

async function indexPage(
  supabase: SupabaseClient,
  entityType: ContentEntityType,
  rows: Row[]
): Promise<{ embedded: number; skipped: number }> {
  if (rows.length === 0) return { embedded: 0, skipped: 0 };

  const hashes = new Map(rows.map((r) => [r.id, createHash("sha256").update(r.content).digest("hex")]));

  const { data: existing, error } = await supabase
    .from("workspace_index")
    .select("entity_id,content_hash")
    .eq("entity_type", entityType)
    .in(
      "entity_id",
      rows.map((r) => r.id)
    );
  if (error) throw new Error(`workspace_index hash lookup failed: ${error.message}`);
  const existingHashes = new Map((existing ?? []).map((e) => [e.entity_id as string, e.content_hash as string]));

  const changed = rows.filter((r) => existingHashes.get(r.id) !== hashes.get(r.id));
  if (changed.length === 0) return { embedded: 0, skipped: rows.length };

  const embeddings = await embedTexts(changed.map((r) => r.content));

  const upsertRows = changed.map((r, idx) => ({
    entity_type: entityType,
    entity_id: r.id,
    title: r.title,
    content: r.content,
    content_hash: hashes.get(r.id)!,
    embedding: `[${embeddings[idx].join(",")}]`,
    updated_at: new Date().toISOString(),
  }));

  const { error: upsertError } = await supabase
    .from("workspace_index")
    .upsert(upsertRows, { onConflict: "entity_type,entity_id" });
  if (upsertError) throw new Error(`workspace_index upsert failed: ${upsertError.message}`);

  return { embedded: changed.length, skipped: rows.length - changed.length };
}

async function cleanupEntityType(supabase: SupabaseClient, entityType: ContentEntityType): Promise<number> {
  const liveIds = await fetchLiveIds(supabase, entityType);

  const { data: existing, error } = await supabase
    .from("workspace_index")
    .select("entity_id")
    .eq("entity_type", entityType);
  if (error) throw new Error(`workspace_index cleanup lookup failed: ${error.message}`);

  const orphanIds = (existing ?? [])
    .map((e) => e.entity_id as string)
    .filter((id) => !liveIds.has(id));
  if (orphanIds.length === 0) return 0;

  const { error: delError } = await supabase
    .from("workspace_index")
    .delete()
    .eq("entity_type", entityType)
    .in("entity_id", orphanIds);
  if (delError) throw new Error(`workspace_index cleanup delete failed: ${delError.message}`);

  return orphanIds.length;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronCall) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const entityTypeFilter = request.nextUrl.searchParams.get("entity_type") as ContentEntityType | null;
  const entityTypes = entityTypeFilter ? [entityTypeFilter] : ALL_ENTITY_TYPES;
  if (entityTypeFilter && !ALL_ENTITY_TYPES.includes(entityTypeFilter)) {
    return NextResponse.json({ error: `Unknown entity_type: ${entityTypeFilter}` }, { status: 400 });
  }

  const cursor = parseCursor(request.nextUrl.searchParams.get("cursor"));
  const supabase = createServiceRoleClient();
  const start = Date.now();

  let embedded = 0;
  let skipped = 0;
  let deleted = 0;
  let phase = cursor.phase;
  let entityTypeIndex = cursor.entityTypeIndex;
  let offset = cursor.offset;

  try {
    if (phase === "index") {
      while (entityTypeIndex < entityTypes.length) {
        const entityType = entityTypes[entityTypeIndex];
        const page = await FETCHERS[entityType](supabase, offset);

        if (page.length === 0) {
          entityTypeIndex++;
          offset = 0;
        } else {
          const result = await indexPage(supabase, entityType, page);
          embedded += result.embedded;
          skipped += result.skipped;
          offset += PAGE_SIZE;

          if (entityType === "email" && result.embedded > 0) {
            return NextResponse.json({
              phase: "index",
              continued: true,
              reason: "email_page_budget",
              embedded,
              skipped,
              deleted,
            });
          }

          if (page.length < PAGE_SIZE) {
            entityTypeIndex++;
            offset = 0;
          }
        }

        if (Date.now() - start > TIME_BUDGET_MS && entityTypeIndex < entityTypes.length) {
          const nextCursor: Cursor = { phase: "index", entityTypeIndex, offset };
          void selfInvoke(request, nextCursor, entityTypeFilter);
          return NextResponse.json({ phase, continued: true, embedded, skipped, deleted });
        }
      }
      phase = "cleanup";
      entityTypeIndex = 0;
    }

    while (entityTypeIndex < entityTypes.length) {
      const entityType = entityTypes[entityTypeIndex];
      deleted += await cleanupEntityType(supabase, entityType);
      entityTypeIndex++;

      if (Date.now() - start > TIME_BUDGET_MS && entityTypeIndex < entityTypes.length) {
        const nextCursor: Cursor = { phase: "cleanup", entityTypeIndex, offset: 0 };
        void selfInvoke(request, nextCursor, entityTypeFilter);
        return NextResponse.json({ phase, continued: true, embedded, skipped, deleted });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown reindex error";
    console.error("second-brain/reindex failed:", message);
    return NextResponse.json({ error: message, phase, embedded, skipped, deleted }, { status: 500 });
  }

  console.log(`second-brain/reindex complete: embedded=${embedded} skipped=${skipped} deleted=${deleted}`);
  return NextResponse.json({ phase: "done", continued: false, embedded, skipped, deleted });
}

function selfInvoke(request: NextRequest, cursor: Cursor, entityTypeFilter: string | null): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
  const cronSecret = process.env.CRON_SECRET;
  const params = new URLSearchParams({ cursor: JSON.stringify(cursor) });
  if (entityTypeFilter) params.set("entity_type", entityTypeFilter);
  return fetch(`${appUrl}/api/second-brain/reindex?${params.toString()}`, {
    headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
  })
    .then(() => undefined)
    .catch((err) => {
      console.error("second-brain/reindex self-invoke failed:", err);
    });
}
