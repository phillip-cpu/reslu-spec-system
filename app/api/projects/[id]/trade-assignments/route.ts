import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type {
  ProjectTradeAssignment,
  ProjectTradeAssignmentsResponse,
} from "@/types/project-trade-assignments";

const ASSIGNMENT_SELECT =
  "id,project_id,trade_role,role_key,contact_id,created_at,updated_at,contact:contacts!project_trade_assignments_contact_id_fkey(id,company,contact_name,category)";

function cleanTradeRole(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const role = value.trim();
  return role && role.length <= 120 ? role : null;
}

async function projectExists(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  return !!data;
}

/** Project-level trade roster shared by Scope of Works and Work booking. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await projectExists(supabase, projectId))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("project_trade_assignments")
    .select(ASSIGNMENT_SELECT)
    .eq("project_id", projectId)
    .order("trade_role", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const body: ProjectTradeAssignmentsResponse = {
    assignments: (data ?? []) as unknown as ProjectTradeAssignment[],
  };
  return NextResponse.json(body);
}

/**
 * Set or replace a project's contractor for one trade role. The database RPC
 * also updates only unbooked board tasks that still inherit this project
 * default; manually overridden tasks and linked visits retain their history.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { trade_role?: unknown; contact_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const tradeRole = cleanTradeRole(body.trade_role);
  const contactId = typeof body.contact_id === "string" && body.contact_id ? body.contact_id : null;
  if (!tradeRole || !contactId) {
    return NextResponse.json(
      { error: "trade_role and contact_id are required" },
      { status: 400 }
    );
  }

  const [{ data: project }, { data: contact }] = await Promise.all([
    supabase.from("projects").select("id").eq("id", projectId).maybeSingle(),
    supabase
      .from("contacts")
      .select("id")
      .eq("id", contactId)
      .is("deleted_at", null)
      .maybeSingle(),
  ]);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 400 });

  const { error: setError } = await supabase.rpc("set_project_trade_assignment", {
    p_project_id: projectId,
    p_trade_role: tradeRole,
    p_contact_id: contactId,
  });
  if (setError) return NextResponse.json({ error: setError.message }, { status: 500 });

  const { data: assignment, error } = await supabase
    .from("project_trade_assignments")
    .select(ASSIGNMENT_SELECT)
    .eq("project_id", projectId)
    .eq("role_key", tradeRole.toLowerCase())
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ assignment: assignment as unknown as ProjectTradeAssignment });
}

/** Clear one project trade mapping without touching booked/manual contacts. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { trade_role?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const tradeRole = cleanTradeRole(body.trade_role);
  if (!tradeRole) return NextResponse.json({ error: "trade_role is required" }, { status: 400 });
  if (!(await projectExists(supabase, projectId))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { error } = await supabase.rpc("clear_project_trade_assignment", {
    p_project_id: projectId,
    p_trade_role: tradeRole,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

