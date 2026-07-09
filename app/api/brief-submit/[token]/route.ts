import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import type { BriefAnswers, BriefSubmitResponse } from "@/types/round-lead-flow";

export const runtime = "nodejs";

/** Verbatim field names emails/brief/project-brief.html's <form> posts
 * (docs/RESLU-lead-flow-brief.md build task 2) — must match that
 * file's `name="..."` attributes letter-for-letter. */
const ANSWER_FIELDS: (keyof BriefAnswers)[] = [
  "first_name",
  "last_name",
  "hoping",
  "favourite_spaces",
  "materials",
  "feel",
  "must_1",
  "must_2",
  "must_3",
  "bringing",
];

/**
 * POST /api/brief-submit/[token]
 * Public, unauthenticated — token-gated (leads.brief_token), same trust
 * model as POST /api/trade/[token]/respond and POST /api/portal/[token]
 * /**: an unguessable token is the security boundary, service-role
 * client (bypasses RLS), rate-limited tighter than a page GET (10/min)
 * since this is a mutation.
 *
 * DELIBERATELY NOT under /api/brief/** — that prefix already exists in
 * this codebase for a completely unrelated feature (the "Daily Brief"
 * attention-items panel, app/api/brief/route.ts +
 * app/api/brief/items/**, migration 041). This round's own build
 * instructions call this route out by name (`/api/brief-submit/
 * [token]`) specifically to avoid that collision.
 *
 * Body: FormData (emails/brief/project-brief.html's own submit handler
 * posts `new FormData(form)`, not JSON). Stores all 10 fields verbatim into leads.brief_answers +
 * brief_submitted_at. Idempotent re-submit: a second POST against the
 * same token fully OVERWRITES brief_answers (the client-side page has
 * no server-synced draft state — "idempotent" here means "safe to call
 * twice," not "the second call is a no-op"), keeping the PRIOR
 * submission's timestamp as a `_previous_submitted_at` note inside the
 * new blob so a double-submit is visible on the record rather than
 * silently lost.
 *
 * Also inserts one `daily_brief_items` row (source: 'lead' — see
 * migration 041's CHECK constraint, which already allows this value)
 * the FIRST time a given lead's brief is ever open+unactioned on the
 * panel, per docs/RESLU-lead-flow-brief.md build task 4: "attention/
 * daily-brief item 'Brief submitted — {lead}'." Direct insert (not
 * routed through lib/daily-brief-generate.ts's generator) — this is a
 * point-in-time event ("someone just submitted"), not a recurring
 * attention-feed candidate that generator re-derives on every run, so
 * a direct insert with the SAME dedupe shape (guard against a second
 * still-OPEN row for the same source+link_href+title) is the simpler,
 * correct fit; documented here per this round's own BUILD instructions
 * ("direct insert source 'lead', document").
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`brief-submit:${token}:${clientIp}`, 10, 60_000);
  if (!limit.ok) {
    return NextResponse.json({ error: "Too many requests, please try again shortly." }, { status: 429 });
  }

  const supabase = createServiceRoleClient();
  const { data: lead } = await supabase
    .from("leads")
    .select("id,surname_project,brief_submitted_at")
    .eq("brief_token", token)
    .is("deleted_at", null)
    .maybeSingle();

  if (!lead) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form submission" }, { status: 400 });
  }

  const answers: BriefAnswers = {};
  for (const field of ANSWER_FIELDS) {
    const value = form.get(field);
    if (typeof value === "string") {
      answers[field] = value.trim();
    }
  }

  const now = new Date().toISOString();
  const payload: BriefAnswers = { ...answers };
  if (lead.brief_submitted_at) {
    payload._previous_submitted_at = lead.brief_submitted_at;
  }

  const { error: updateError } = await supabase
    .from("leads")
    .update({ brief_answers: payload, brief_submitted_at: now })
    .eq("id", lead.id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Daily Brief surface — see this route's own doc comment above.
  const linkHref = `/leads?lead=${lead.id}`;
  const title = `Brief submitted — ${lead.surname_project}`;
  const { data: existingOpen } = await supabase
    .from("daily_brief_items")
    .select("id")
    .eq("source", "lead")
    .eq("link_href", linkHref)
    .eq("title", title)
    .eq("status", "open")
    .maybeSingle();

  if (!existingOpen) {
    await supabase.from("daily_brief_items").insert({
      title,
      source: "lead",
      link_href: linkHref,
      status: "open",
      created_by_kind: "system",
    });
  }

  const body: BriefSubmitResponse = { ok: true };
  return NextResponse.json(body);
}
