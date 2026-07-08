import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import type { LeadAttachment } from "@/types";

export const runtime = "nodejs";

/**
 * GET /api/leads/[id]/attachments — files stored on a lead (today:
 * intake photos from the reslu.com.au /begin form, written by
 * POST /api/leads/intake + migration 042). Admin-gated like every
 * other leads route (same requireAdmin shape as
 * app/api/leads/[id]/notes/route.ts — kept byte-for-byte equivalent
 * in behaviour, not imported, since none of these routes export it).
 *
 * Each row is returned with a short-TTL signed URL minted from the
 * private assets bucket per request (lib/storage.ts discipline —
 * nothing in that bucket ever gets a permanent public URL).
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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const gate = await requireAdmin(supabase);
  if (gate.error) return gate.error;

  const { data: rows, error } = await supabase
    .from("lead_attachments")
    .select("*")
    .eq("lead_id", id)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const attachments = await Promise.all(
    ((rows ?? []) as LeadAttachment[]).map(async (row) => {
      const { data, error: signError } = await supabase.storage
        .from(ASSET_BUCKET)
        .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
      return { ...row, url: signError ? null : (data?.signedUrl ?? null) };
    })
  );

  return NextResponse.json({ attachments });
}
