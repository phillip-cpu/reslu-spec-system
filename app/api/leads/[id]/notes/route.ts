import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { LeadNote } from "@/types/round-d";

export const runtime = "nodejs";

/**
 * Same admin gate shape as app/api/leads/[id]/route.ts's own
 * requireAdmin() (not imported from there — that route doesn't export
 * it — but kept byte-for-byte equivalent in behaviour). Explicit
 * return type so `gate.info` is a valid access in the success branch
 * (a plain inferred union would make `.info`/`.error` unsound to read
 * across branches without a discriminant).
 */
async function requireAdmin(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<{ error: NextResponse; info: null } | { error: null; info: { userId: string; role: string } }> {
  const info = await getUserRole(supabase);
  if (!info) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }), info: null };
  }
  if (info.role !== "admin") {
    return { error: NextResponse.json({ error: "Only admins can access leads" }, { status: 403 }), info: null };
  }
  return { error: null, info };
}

/**
 * GET /api/leads/[id]/notes — attributed, timestamped notes for a
 * lead. Mirrors GET /api/items/[id]/notes exactly, except newest
 * first (the lead notes feed is explicitly newest-first per
 * BUILD-SPEC.md's migration 030 round spec — see
 * components/leads/LeadNotes.tsx) and admin-gated like every other
 * leads route (leads are "admin-only, financial-adjacent" — see
 * app/api/leads/[id]/route.ts's identical requireAdmin() gate).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const gate = await requireAdmin(supabase);
  if (gate.error) return gate.error;

  const { data: notes, error } = await supabase
    .from("lead_notes")
    .select("*")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ notes: (notes ?? []) as LeadNote[] });
}

/**
 * POST /api/leads/[id]/notes — body { text }. Mirrors POST
 * /api/items/[id]/notes exactly: text required/trimmed, author_name
 * denormalised from the caller's profile full name (falling back to
 * email, then "Team member"). Admin-gated, same as GET above.
 * MCP: add_lead_note (mcp/src/index.mjs).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const gate = await requireAdmin(supabase);
  if (gate.error) return gate.error;
  const { userId } = gate.info;

  const body = await request.json().catch(() => ({}));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Note text is required" }, { status: 400 });
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (leadError) {
    return NextResponse.json({ error: leadError.message }, { status: 500 });
  }
  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  // Denormalise the author name for display (lead_notes.author_name),
  // same fallback chain as POST /api/items/[id]/notes.
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", userId)
    .single();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const author_name = profile?.full_name || user?.email || "Team member";

  const { data: note, error } = await supabase
    .from("lead_notes")
    .insert({ lead_id: id, author_id: userId, author_name, text })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ note: note as LeadNote }, { status: 201 });
}
