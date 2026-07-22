import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { addIsoDays, adelaideDate } from "@/lib/marketing";
import { canTransitionOrganicAction, isOrganicActionStatus } from "@/lib/organic-actions";

async function authAction(id: string) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info || info.role !== "admin") return { supabase, info, action: null };
  const { data: action } = await supabase
    .from("marketing_organic_actions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return { supabase, info, action };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { info, action } = await authAction(id);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!action) return NextResponse.json({ error: "Organic action not found" }, { status: 404 });
  return NextResponse.json({ action });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { supabase, info, action } = await authAction(id);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!action) return NextResponse.json({ error: "Organic action not found" }, { status: 404 });

  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const nextStatus = body.status;
  if (!isOrganicActionStatus(nextStatus)) {
    return NextResponse.json({ error: "A valid status is required." }, { status: 400 });
  }
  if (!isOrganicActionStatus(action.status) || !canTransitionOrganicAction(action.status, nextStatus)) {
    return NextResponse.json(
      { error: `Cannot move an organic action from ${action.status} to ${nextStatus}.` },
      { status: 409 }
    );
  }

  const update: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === "approved") {
    update.reviewed_by = info.userId;
    update.reviewed_at = new Date().toISOString();
  }
  if (nextStatus === "monitoring") update.recheck_on = addIsoDays(adelaideDate(), 28);
  if (["complete", "dismissed"].includes(nextStatus)) update.recheck_on = null;

  const { data: updated, error } = await supabase
    .from("marketing_organic_actions")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (action.office_task_id) {
    if (["complete", "dismissed"].includes(nextStatus)) {
      const [{ data: archived }, { data: officeTask }] = await Promise.all([
        supabase
          .from("office_groups")
          .select("id")
          .eq("name", "Archived")
          .is("deleted_at", null)
          .maybeSingle(),
        supabase
          .from("office_tasks")
          .select("group_id")
          .eq("id", action.office_task_id)
          .maybeSingle(),
      ]);
      if (archived && officeTask) {
        await supabase
          .from("office_tasks")
          .update({
            completed_at: new Date().toISOString(),
            prev_group_id: officeTask.group_id,
            group_id: archived.id,
            due_date: null,
          })
          .eq("id", action.office_task_id);
      }
    } else if (nextStatus === "monitoring") {
      await supabase
        .from("office_tasks")
        .update({ due_date: update.recheck_on, title: `Recheck organic: ${action.title}` })
        .eq("id", action.office_task_id);
    } else if (
      (action.status === "complete" && nextStatus === "in_progress") ||
      (action.status === "dismissed" && nextStatus === "new")
    ) {
      const { data: marketing } = await supabase
        .from("office_groups")
        .select("id")
        .eq("name", "Marketing")
        .is("deleted_at", null)
        .maybeSingle();
      if (marketing) {
        await supabase
          .from("office_tasks")
          .update({
            completed_at: null,
            prev_group_id: null,
            group_id: marketing.id,
            due_date: addIsoDays(adelaideDate(), 7),
            title: `Organic: ${action.title}`,
          })
          .eq("id", action.office_task_id);
      }
    }
  }

  return NextResponse.json({ action: updated });
}
