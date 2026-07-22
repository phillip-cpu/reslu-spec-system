import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { addIsoDays, adelaideDate, type OrganicOpportunity, type OrganicPagePerformance } from "@/lib/marketing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateOrganicActionBody {
  insight?: OrganicOpportunity;
  range?: { from?: string; to?: string };
  comparison?: { from?: string; to?: string };
  baseline?: OrganicPagePerformance[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= max ? cleaned : null;
}

function cleanPages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((page): page is string => typeof page === "string" && page.startsWith("/") && page.length <= 500)
    .map((page) => page.trim()))]
    .slice(0, 20);
}

function insightKey(insight: OrganicOpportunity): string {
  return createHash("sha256")
    .update(`${insight.kind}|${insight.title.trim().toLowerCase()}|${[...insight.affected_pages].sort().join("|")}`)
    .digest("hex");
}

async function requireAdmin() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  return { supabase, info };
}

export async function GET() {
  const { supabase, info } = await requireAdmin();
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("marketing_organic_actions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(
    { actions: data ?? [] },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } }
  );
}

export async function POST(request: NextRequest) {
  const { supabase, info } = await requireAdmin();
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: CreateOrganicActionBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const insight = body.insight;
  const title = cleanText(insight?.title, 240);
  const reason = cleanText(insight?.reason, 2000);
  const recommendedAction = cleanText(insight?.action, 3000);
  const predictedImpact = cleanText(insight?.predicted_impact, 1000);
  const affectedPages = cleanPages(insight?.affected_pages);
  const from = body.range?.from;
  const to = body.range?.to;
  const comparisonFrom = body.comparison?.from;
  const comparisonTo = body.comparison?.to;
  const score = Number(insight?.score);
  if (
    !insight || !title || !reason || !recommendedAction || !predictedImpact ||
    !affectedPages.length || !from || !to || !comparisonFrom || !comparisonTo ||
    ![from, to, comparisonFrom, comparisonTo].every((date) => ISO_DATE.test(date)) ||
    from > to || comparisonFrom > comparisonTo ||
    !Number.isInteger(score) || score < 0 || score > 100 ||
    !["blog", "page"].includes(insight.kind) ||
    typeof insight.page !== "string" || !affectedPages.includes(insight.page)
  ) {
    return NextResponse.json({ error: "The organic opportunity evidence is incomplete." }, { status: 400 });
  }

  const key = insightKey({ ...insight, title, reason, action: recommendedAction, predicted_impact: predictedImpact, affected_pages: affectedPages });
  const { data: existing, error: existingError } = await supabase
    .from("marketing_organic_actions")
    .select("*")
    .eq("insight_key", key)
    .eq("range_from", from)
    .eq("range_to", to)
    .maybeSingle();
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
  if (existing) return NextResponse.json({ action: existing, existing: true });

  const baseline = (body.baseline ?? [])
    .filter((row) => affectedPages.includes(row.page))
    .slice(0, 20)
    .map((row) => ({
      page: row.page,
      clicks: Number(row.clicks) || 0,
      impressions: Number(row.impressions) || 0,
      ctr: Number(row.ctr) || 0,
      position: Number(row.position) || 0,
      previous_clicks: Number(row.previous_clicks) || 0,
      previous_impressions: Number(row.previous_impressions) || 0,
      previous_position: row.previous_position == null ? null : Number(row.previous_position),
    }));

  const { data: action, error: actionError } = await supabase
    .from("marketing_organic_actions")
    .insert({
      insight_key: key,
      page: insight.page,
      affected_pages: affectedPages,
      page_kind: insight.kind,
      title,
      reason,
      recommended_action: recommendedAction,
      predicted_impact: predictedImpact,
      opportunity_score: score,
      range_from: from,
      range_to: to,
      comparison_from: comparisonFrom,
      comparison_to: comparisonTo,
      baseline,
      created_by: info.userId,
    })
    .select("*")
    .single();
  if (actionError || !action) {
    return NextResponse.json({ error: actionError?.message || "Could not create organic action." }, { status: 500 });
  }

  const { data: marketingGroup, error: groupError } = await supabase
    .from("office_groups")
    .select("id")
    .ilike("name", "Marketing")
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (groupError || !marketingGroup) {
    await supabase.from("marketing_organic_actions").delete().eq("id", action.id);
    return NextResponse.json({ error: "The Office Marketing group could not be found." }, { status: 500 });
  }

  const { data: maxRow } = await supabase
    .from("office_tasks")
    .select("sort")
    .eq("group_id", marketingGroup.id)
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  const description = [
    reason,
    `Recommended: ${recommendedAction}`,
    `Affected: ${affectedPages.join(", ")}`,
    `Baseline range: ${from} to ${to}; comparison: ${comparisonFrom} to ${comparisonTo}.`,
    "Review and approve any draft before changing the RESLU website.",
  ].join("\n\n");
  const { data: officeTask, error: taskError } = await supabase
    .from("office_tasks")
    .insert({
      group_id: marketingGroup.id,
      title: `Organic: ${title}`,
      description,
      kind: "task",
      due_date: addIsoDays(adelaideDate(), 7),
      sort: (maxRow?.sort ?? -1000) + 1000,
      created_by: info.userId,
    })
    .select("id")
    .single();
  if (taskError || !officeTask) {
    await supabase.from("marketing_organic_actions").delete().eq("id", action.id);
    return NextResponse.json({ error: taskError?.message || "Could not create the Office task." }, { status: 500 });
  }

  const { error: assigneeError } = await supabase
    .from("office_task_assignees")
    .insert({ task_id: officeTask.id, profile_id: info.userId });
  if (assigneeError) {
    await supabase.from("office_tasks").delete().eq("id", officeTask.id);
    await supabase.from("marketing_organic_actions").delete().eq("id", action.id);
    return NextResponse.json({ error: assigneeError.message }, { status: 500 });
  }

  const { data: linked, error: linkError } = await supabase
    .from("marketing_organic_actions")
    .update({ office_task_id: officeTask.id })
    .eq("id", action.id)
    .select("*")
    .single();
  if (linkError) {
    await supabase.from("office_tasks").delete().eq("id", officeTask.id);
    await supabase.from("marketing_organic_actions").delete().eq("id", action.id);
    return NextResponse.json({ error: linkError.message }, { status: 500 });
  }

  return NextResponse.json({ action: linked }, { status: 201 });
}
