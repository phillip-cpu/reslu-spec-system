import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateSignatureRequestInput } from "@/lib/signatures";

/**
 * POST /api/signatures — team creates a signature request for a
 * project_file or variation ("Request signature" in the client area,
 * BUILD-SPEC.md "Team-side client area": "contract flow (pick a
 * project_file → 'Request signature' creates signature_request)").
 *
 * Team-authenticated (any signed-in team member — contract flow is NOT
 * admin-only; only variation SHARING is admin-only per the spec, and
 * that gate lives in the variations share-toggle route, not here).
 *
 * GET /api/signatures?project_id=... — list signature requests for a
 * project, for the team client-area UI (status chips, certificate
 * links).
 */

const SUBJECT_TYPES = ["project_file", "variation", "sow"];

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateSignatureRequestInput & { project_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { project_id, subject_type, subject_id } = body;
  if (!project_id || !subject_type || !subject_id) {
    return NextResponse.json(
      { error: "project_id, subject_type, and subject_id are required" },
      { status: 400 }
    );
  }
  if (!SUBJECT_TYPES.includes(subject_type)) {
    return NextResponse.json({ error: "Invalid subject_type" }, { status: 400 });
  }

  // Validate the subject actually exists and belongs to this project
  // before creating a request against it — mirrors the ownership
  // discipline used throughout the portal routes, applied here on the
  // team-authoring side instead.
  if (subject_type === "project_file") {
    const { data: file } = await supabase
      .from("project_files")
      .select("id,project_id")
      .eq("id", subject_id)
      .eq("project_id", project_id)
      .is("deleted_at", null)
      .single();
    if (!file) {
      return NextResponse.json({ error: "Document not found in this project" }, { status: 404 });
    }
  } else if (subject_type === "variation") {
    const { data: variation } = await supabase
      .from("variations")
      .select("id,project_id")
      .eq("id", subject_id)
      .eq("project_id", project_id)
      .is("deleted_at", null)
      .single();
    if (!variation) {
      return NextResponse.json({ error: "Variation not found in this project" }, { status: 404 });
    }
  }
  // 'sow' — no SOW table in this agent's boundary; requests may be
  // created against a subject_id the SOW builder (Week 8A) owns, and
  // are trusted at face value here (no cross-boundary table to check).

  // Hashing happens at SIGN time, server-side (see
  // app/api/portal/[token]/sign/[requestId]/route.ts) — not here at
  // request-creation time, since the document may still change before
  // the client opens it.
  const { data: row, error } = await supabase
    .from("signature_requests")
    .insert({
      project_id,
      subject_type,
      subject_id,
      requested_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ request: row }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project_id");
  if (!projectId) {
    return NextResponse.json({ error: "project_id is required" }, { status: 400 });
  }

  const { data: requests, error } = await supabase
    .from("signature_requests")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Attach the signing evidence summary (signer/signed_at) for any
  // 'signed' requests, so the client-area status chips don't need a
  // second round-trip per request.
  const signedIds = (requests ?? []).filter((r) => r.status === "signed").map((r) => r.id);
  const eventsByRequest = new Map<string, { signer_name_typed: string; signed_at: string }>();
  if (signedIds.length > 0) {
    const { data: events } = await supabase
      .from("signature_events")
      .select("signature_request_id,signer_name_typed,signed_at")
      .in("signature_request_id", signedIds);
    for (const e of events ?? []) {
      if (e.signature_request_id) {
        eventsByRequest.set(e.signature_request_id, {
          signer_name_typed: e.signer_name_typed,
          signed_at: e.signed_at,
        });
      }
    }
  }

  return NextResponse.json({
    requests: (requests ?? []).map((r) => ({
      ...r,
      evidence: eventsByRequest.get(r.id) ?? null,
    })),
  });
}
