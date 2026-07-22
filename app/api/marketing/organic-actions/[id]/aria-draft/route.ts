import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";

function cleanStringArray(value: unknown, maxItems = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 1000))
    .slice(0, maxItems);
}

async function authenticatedAction(id: string) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  const { data: action } = info
    ? await supabase.from("marketing_organic_actions").select("*").eq("id", id).maybeSingle()
    : { data: null };
  return { supabase, info, action };
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { supabase, info, action } = await authenticatedAction(id);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!action) return NextResponse.json({ error: "Organic action not found" }, { status: 404 });
  if (["complete", "dismissed"].includes(action.status)) {
    return NextResponse.json({ error: "Closed organic actions cannot be sent to Aria." }, { status: 409 });
  }

  const dedupeKey = `organic_review:${id}`;
  const { data: queued, error: queueError } = await supabase
    .from("aria_queue")
    .upsert({
      kind: "organic_review",
      status: "pending",
      payload: {
        organic_action_id: id,
        title: action.title,
        page: action.page,
        affected_pages: action.affected_pages,
        reason: action.reason,
        recommended_action: action.recommended_action,
        baseline: action.baseline,
        instruction: "Audit the evidence and prepare a draft only. Do not publish, edit the website, send messages or claim unrelated queue items.",
      },
      dedupe_key: dedupeKey,
      source: "marketing_dashboard",
      picked_up_at: null,
      resolved_at: null,
      attempts: 0,
      error: null,
    }, { onConflict: "dedupe_key" })
    .select("id")
    .single();
  if (queueError || !queued) {
    return NextResponse.json({ error: queueError?.message || "Could not queue Aria." }, { status: 500 });
  }

  const { data: updated, error } = await supabase
    .from("marketing_organic_actions")
    .update({
      status: action.status === "new" ? "approved" : action.status,
      reviewed_by: action.reviewed_by ?? info.userId,
      reviewed_at: action.reviewed_at ?? new Date().toISOString(),
      draft_status: "queued",
      aria_queue_id: queued.id,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ action: updated });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { supabase, info, action } = await authenticatedAction(id);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!action) return NextResponse.json({ error: "Organic action not found" }, { status: 404 });
  if (action.draft_status !== "queued") {
    return NextResponse.json({ error: "This organic draft was not requested by a human." }, { status: 409 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const summary = typeof body.summary === "string" ? body.summary.trim().slice(0, 4000) : "";
  if (!summary) return NextResponse.json({ error: "A grounded draft summary is required." }, { status: 400 });

  const draft = {
    summary,
    technical_findings: cleanStringArray(body.technical_findings),
    suggested_title: typeof body.suggested_title === "string" ? body.suggested_title.trim().slice(0, 240) : "",
    suggested_meta_description: typeof body.suggested_meta_description === "string" ? body.suggested_meta_description.trim().slice(0, 500) : "",
    content_changes: cleanStringArray(body.content_changes),
    internal_links: cleanStringArray(body.internal_links),
    evidence_sources: cleanStringArray(body.evidence_sources),
    prepared_at: new Date().toISOString(),
  };
  const { data: updated, error } = await supabase
    .from("marketing_organic_actions")
    .update({ aria_draft: draft, draft_status: "ready" })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ action: updated });
}
