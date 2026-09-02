import type { createClient } from "@/lib/supabase/server";
import { assessSowQuality } from "@/lib/sow-quality";
import type { PlanDiscrepancy } from "@/types/phase-12a-a";
import type {
  SowQualityItemAllocation,
  SowQualityPlanAnalysis,
  SowQualityReport,
} from "@/types/sow-quality";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

interface SectionRow {
  id: string;
  heading: string;
  source_room_id: string | null;
  sow_lines: Array<{
    id: string;
    text: string;
    kind: "inclusion" | "exclusion" | "note";
    trade: string | null;
  }> | null;
}

interface AllocationRow {
  room_id: string;
  item_id: string;
  items: {
    id: string;
    item_code: string;
    name: string;
    deleted_at: string | null;
  } | null;
}

interface AnalysisRow {
  file_id: string;
  discrepancies: PlanDiscrepancy[] | null;
  analysed_at: string;
  project_files: {
    filename: string;
    deleted_at: string | null;
  } | null;
}

/** Loads all authoritative inputs used by the pre-issue quality gate. */
export async function loadSowQualityReport(
  supabase: ServerSupabaseClient,
  projectId: string,
  sowId: string
): Promise<SowQualityReport> {
  const [{ data: sections, error: sectionError }, { data: rooms, error: roomError }, { data: planFiles, error: planFileError }, { data: analyses, error: analysisError }] =
    await Promise.all([
      supabase
        .from("sow_sections")
        .select("id, heading, source_room_id, sow_lines(id, text, kind, trade)")
        .eq("sow_id", sowId)
        .order("sort", { ascending: true }),
      supabase
        .from("rooms")
        .select("id, name")
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("sort", { ascending: true }),
      supabase
        .from("project_files")
        .select("id, filename")
        .eq("project_id", projectId)
        .eq("kind", "plans")
        .is("deleted_at", null)
        .order("uploaded_at", { ascending: false }),
      supabase
        .from("plan_analyses")
        .select("file_id, discrepancies, analysed_at, project_files(filename, deleted_at)")
        .eq("project_id", projectId)
        .order("analysed_at", { ascending: false }),
    ]);

  const firstError = sectionError ?? roomError ?? planFileError ?? analysisError;
  if (firstError) throw new Error(firstError.message);

  const roomRows = (rooms ?? []).map((room) => ({ id: String(room.id), name: String(room.name) }));
  const roomIds = roomRows.map((room) => room.id);
  const { data: allocations, error: allocationError } = roomIds.length
    ? await supabase
        .from("item_rooms")
        .select("room_id, item_id, items(id, item_code, name, deleted_at)")
        .in("room_id", roomIds)
    : { data: [] as unknown[], error: null };
  if (allocationError) throw new Error(allocationError.message);

  const typedAllocations = (allocations ?? []) as unknown as AllocationRow[];
  const qualityAllocations: SowQualityItemAllocation[] = typedAllocations
    .filter((row) => row.items && !row.items.deleted_at)
    .map((row) => ({
      room_id: row.room_id,
      item_id: row.item_id,
      item_code: row.items?.item_code ?? "",
      name: row.items?.name ?? "",
    }));

  // Keep the newest analysis for EVERY current plan file. The project
  // can have separate internal works, joinery and external plan sets;
  // using only the newest analysis overall would silently hide the
  // other current drawings.
  const latestAnalysisByFile = new Map<string, SowQualityPlanAnalysis>();
  for (const row of (analyses ?? []) as unknown as AnalysisRow[]) {
    if (latestAnalysisByFile.has(row.file_id) || !row.project_files || row.project_files.deleted_at) continue;
    latestAnalysisByFile.set(row.file_id, {
      file_id: row.file_id,
      filename: row.project_files.filename,
      discrepancies: row.discrepancies ?? [],
    });
  }

  return assessSowQuality({
    sections: ((sections ?? []) as unknown as SectionRow[]).map((section) => ({
      id: section.id,
      heading: section.heading,
      source_room_id: section.source_room_id,
      lines: section.sow_lines ?? [],
    })),
    rooms: roomRows,
    allocations: qualityAllocations,
    plan_files: (planFiles ?? []).map((file) => ({ id: String(file.id), filename: String(file.filename) })),
    plan_analyses: [...latestAnalysisByFile.values()],
  });
}
