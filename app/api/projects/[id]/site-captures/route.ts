import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { withCaptureUrl } from "@/lib/site-captures";
import type { SiteCapture, SiteCaptureListResponse } from "@/types/site-captures";

export const runtime = "nodejs";

/**
 * GET /api/projects/[id]/site-captures
 * Site capture + mobile QoL round (r21), BUILD-SPEC.md item 4. The
 * project's "Site diary" feed — every photo/note/audio capture for
 * this project, reverse-chronological, signed URLs for media. Team-
 * authenticated (not admin-gated — captures carry no pricing).
 *
 * Each row's `author` is resolved here (profiles.full_name for a
 * /capture row, contacts.company for a /trade/[token] row) via two
 * batched lookups — never persisted on site_captures itself, which
 * only stores the FK (author_user_id XOR author_contact_id, see
 * migration 050's chk_site_captures_one_author).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: rows, error } = await supabase
    .from("site_captures")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const captures = (rows ?? []) as SiteCapture[];

  const userIds = [...new Set(captures.map((c) => c.author_user_id).filter(Boolean))] as string[];
  const contactIds = [...new Set(captures.map((c) => c.author_contact_id).filter(Boolean))] as string[];

  const [{ data: profiles }, { data: contacts }] = await Promise.all([
    userIds.length
      ? supabase.from("profiles").select("id,full_name").in("id", userIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
    contactIds.length
      ? supabase.from("contacts").select("id,company").in("id", contactIds)
      : Promise.resolve({ data: [] as { id: string; company: string }[] }),
  ]);
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

  const withUrls = await Promise.all(
    captures.map(async (row) => {
      const capture = await withCaptureUrl(supabase, row);
      const author = row.author_user_id
        ? { label: profileById.get(row.author_user_id)?.full_name || "Team member", source: "user" as const }
        : row.author_contact_id
          ? { label: contactById.get(row.author_contact_id)?.company || "Trade", source: "contact" as const }
          : null;
      return { ...capture, author };
    })
  );

  const body: SiteCaptureListResponse = { captures: withUrls };
  return NextResponse.json(body);
}
