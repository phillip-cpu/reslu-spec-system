import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentAdelaideWeekEnding, normalizeActionItems } from "@/lib/friday-review";
import type { FridayReview, FridayReviewProject } from "@/types/friday-review";

export const runtime = "nodejs";

const PROJECT_STATUSES = new Set(["not_started", "in_progress", "complete"]);
const TEXT_FIELDS = ["this_week", "next_week", "blockers", "client_update"] as const;

function addDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function loadReview(supabase: Awaited<ReturnType<typeof createClient>>, reviewId: string) {
  const { data: review, error } = await supabase
    .from("friday_reviews")
    .select("*")
    .eq("id", reviewId)
    .single();
  if (error || !review) throw new Error(error?.message ?? "Friday Review not found");

  const { data: entries, error: entryError } = await supabase
    .from("friday_review_projects")
    .select("*,project:projects!inner(id,name,client_name,address,job_number,status,deleted_at)")
    .eq("review_id", reviewId)
    .eq("project.status", "active")
    .is("project.deleted_at", null)
    .order("created_at", { ascending: true });
  if (entryError) throw new Error(entryError.message);

  const diaryIds = (entries ?? [])
    .map((entry) => entry.diary_update_id)
    .filter((id): id is string => typeof id === "string");
  const { data: diaryRows } = diaryIds.length
    ? await supabase.from("portal_updates").select("id,status").in("id", diaryIds)
    : { data: [] as { id: string; status: string }[] };
  const diaryStatus = new Map((diaryRows ?? []).map((row) => [row.id, row.status]));

  const projects: FridayReviewProject[] = (entries ?? []).map((entry) => ({
    ...entry,
    project: Array.isArray(entry.project) ? entry.project[0] : entry.project,
    diary_status: entry.diary_update_id ? diaryStatus.get(entry.diary_update_id) ?? null : null,
  })) as FridayReviewProject[];

  return { ...review, projects } as FridayReview;
}

async function startReview(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const weekEnding = currentAdelaideWeekEnding();
  let { data: review } = await supabase
    .from("friday_reviews")
    .select("*")
    .eq("week_ending", weekEnding)
    .maybeSingle();

  if (!review) {
    const inserted = await supabase
      .from("friday_reviews")
      .insert({ week_ending: weekEnding, created_by: userId })
      .select("*")
      .single();
    if (inserted.error || !inserted.data) {
      if (inserted.error?.code !== "23505") throw new Error(inserted.error?.message ?? "Could not start Friday Review");
      const reloaded = await supabase
        .from("friday_reviews")
        .select("*")
        .eq("week_ending", weekEnding)
        .single();
      if (reloaded.error || !reloaded.data) throw new Error(reloaded.error?.message ?? "Could not load Friday Review");
      review = reloaded.data;
    } else {
      review = inserted.data;
    }
  }

  const { data: projects, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("name");
  if (projectError) throw new Error(projectError.message);

  if ((projects ?? []).length > 0) {
    const { error: seedError } = await supabase
      .from("friday_review_projects")
      .upsert(
        (projects ?? []).map((project) => ({ review_id: review.id, project_id: project.id })),
        { onConflict: "review_id,project_id", ignoreDuplicates: true }
      );
    if (seedError) throw new Error(seedError.message);
  }
  return loadReview(supabase, review.id);
}

async function completeReview(
  supabase: Awaited<ReturnType<typeof createClient>>,
  reviewId: string,
  userId: string
) {
  const review = await loadReview(supabase, reviewId);
  if (review.status === "completed") return review;
  const incomplete = review.projects.filter((entry) => entry.review_status !== "complete");
  if (incomplete.length > 0) {
    throw new Error(`Review every active project first (${incomplete.length} remaining).`);
  }

  const { data: operations } = await supabase
    .from("office_groups")
    .select("id")
    .ilike("name", "Operations")
    .is("deleted_at", null)
    .maybeSingle();
  if (!operations) throw new Error("Operations group is missing from Office");

  const { data: maxTask } = await supabase
    .from("office_tasks")
    .select("sort")
    .eq("group_id", operations.id)
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  let nextSort = (maxTask?.sort ?? -1000) + 1000;

  for (const entry of review.projects) {
    const taskIds = [...(entry.office_task_ids ?? [])];
    for (const [index, title] of entry.action_items.entries()) {
      const marker = `automation:friday-review:${entry.id}:action:${index}`;
      const { data: existing } = await supabase
        .from("office_tasks")
        .select("id")
        .ilike("description", `%${marker}%`)
        .limit(1)
        .maybeSingle();
      if (existing) {
        if (!taskIds.includes(existing.id)) taskIds.push(existing.id);
        continue;
      }
      const { data: task, error: taskError } = await supabase
        .from("office_tasks")
        .insert({
          group_id: operations.id,
          title,
          description: `${entry.project.name} · Friday Review\n\n${marker}`,
          kind: "task",
          due_date: addDays(review.week_ending, 7),
          sort: nextSort,
          created_by: userId,
        })
        .select("id")
        .single();
      if (taskError || !task) throw new Error(taskError?.message ?? `Could not create task: ${title}`);
      nextSort += 1000;
      taskIds.push(task.id);
      await supabase.from("office_task_assignees").upsert(
        { task_id: task.id, profile_id: userId },
        { onConflict: "task_id,profile_id", ignoreDuplicates: true }
      );
    }

    let diaryUpdateId = entry.diary_update_id;
    let ariaQueueId = entry.aria_queue_id;
    if (entry.client_worthy && entry.client_update.trim() && !diaryUpdateId) {
      const { data: diary, error: diaryError } = await supabase
        .from("portal_updates")
        .insert({
          project_id: entry.project_id,
          title: `${entry.project.name} — weekly update`,
          body_richtext: entry.client_update.trim(),
          author_id: userId,
          draft_source: "manual",
          status: "draft",
        })
        .select("id")
        .single();
      if (diaryError || !diary) throw new Error(diaryError?.message ?? "Could not create diary draft");
      diaryUpdateId = diary.id;

      const { data: queued, error: queueError } = await supabase
        .from("aria_queue")
        .upsert(
          {
            kind: "diary_draft",
            payload: {
              project_id: entry.project_id,
              post_id: diary.id,
              friday_review_project_id: entry.id,
              instruction:
                "Use draft_diary_entry in fetch mode, write a concise warm client-facing update, then submit it for human approval. Never publish it.",
            },
            dedupe_key: `diary_draft:${diary.id}`,
            source: "friday-review",
          },
          { onConflict: "dedupe_key" }
        )
        .select("id")
        .single();
      if (queueError || !queued) throw new Error(queueError?.message ?? "Could not queue Aria diary draft");
      ariaQueueId = queued.id;
    }

    const { error: updateError } = await supabase
      .from("friday_review_projects")
      .update({
        office_task_ids: taskIds,
        diary_update_id: diaryUpdateId,
        aria_queue_id: ariaQueueId,
      })
      .eq("id", entry.id);
    if (updateError) throw new Error(updateError.message);
  }

  const { error: completeError } = await supabase
    .from("friday_reviews")
    .update({
      status: "completed",
      completed_by: userId,
      completed_at: new Date().toISOString(),
    })
    .eq("id", reviewId);
  if (completeError) throw new Error(completeError.message);
  return loadReview(supabase, reviewId);
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { action?: string; review_id?: string };
  try {
    const review =
      body.action === "complete" && body.review_id
        ? await completeReview(supabase, body.review_id, user.id)
        : await startReview(supabase, user.id);
    return NextResponse.json({ review });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update Friday Review" },
      { status: 400 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.entry_id !== "string") {
    return NextResponse.json({ error: "entry_id is required" }, { status: 400 });
  }

  const { data: entry } = await supabase
    .from("friday_review_projects")
    .select("id,review_id,friday_reviews!inner(status)")
    .eq("id", body.entry_id)
    .maybeSingle();
  if (!entry) return NextResponse.json({ error: "Project review not found" }, { status: 404 });
  const parent = Array.isArray(entry.friday_reviews) ? entry.friday_reviews[0] : entry.friday_reviews;
  if (parent?.status === "completed") {
    return NextResponse.json({ error: "This Friday Review is already complete" }, { status: 409 });
  }

  const update: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    if (typeof body[field] === "string") update[field] = (body[field] as string).trim().slice(0, 10000);
  }
  if (typeof body.review_status === "string" && PROJECT_STATUSES.has(body.review_status)) {
    update.review_status = body.review_status;
  }
  if (typeof body.client_worthy === "boolean") update.client_worthy = body.client_worthy;
  if (typeof body.no_update === "boolean") update.no_update = body.no_update;
  if (Array.isArray(body.action_items)) update.action_items = normalizeActionItems(body.action_items);
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No editable fields supplied" }, { status: 400 });
  }

  const { error } = await supabase.from("friday_review_projects").update(update).eq("id", body.entry_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  try {
    return NextResponse.json({ review: await loadReview(supabase, entry.review_id) });
  } catch (loadError) {
    return NextResponse.json({ error: loadError instanceof Error ? loadError.message : "Could not reload review" }, { status: 500 });
  }
}
