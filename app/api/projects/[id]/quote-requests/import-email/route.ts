import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { matchQuoteProject, quoteIntent, type QuoteEmail, type QuoteProject } from "@/lib/supplier-quote-email-matching";
import { loadSupplierQuotePackages } from "@/lib/supplier-quote-server";
import { createClient } from "@/lib/supabase/server";

type CandidateEmail = QuoteEmail & { gmail_thread_refs: Record<string, string> | null };
type SuggestionLine = {
  cost_line_id: string;
  confidence: number;
  reason: string;
  selected: boolean;
  cost_lines: { id: string; description: string } | null;
};
type Suggestion = {
  id: string;
  seed_email_id: string;
  provider_mailbox: string;
  provider_thread_id: string;
  external_email: string | null;
  project_confidence: number;
  contact_id: string | null;
  evidence: Record<string, unknown>;
  supplier_quote_email_match_lines: SuggestionLine[];
};

const MAILBOX_PRIORITY = ["aria@reslu.com.au", "phillip@reslu.com.au", "tenille@reslu.com.au", "accounts@reslu.com.au", "marco@reslu.com.au"];

function preferredThread(refs: Record<string, string> | null): { mailbox: string; threadId: string } | null {
  const entries = Object.entries(refs ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]));
  entries.sort((left, right) => {
    const l = MAILBOX_PRIORITY.indexOf(left[0].toLowerCase());
    const r = MAILBOX_PRIORITY.indexOf(right[0].toLowerCase());
    return (l === -1 ? 99 : l) - (r === -1 ? 99 : r);
  });
  return entries[0] ? { mailbox: entries[0][0].toLowerCase(), threadId: entries[0][1] } : null;
}

async function requireAdmin() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return { supabase, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (info.role !== "admin") return { supabase, response: NextResponse.json({ error: "Only admins can link quote emails" }, { status: 403 }) };
  return { supabase, info };
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;
  const { supabase } = auth;

  const [{ data: project }, { data: suggestions, error: suggestionError }, { data: recentEmails, error: emailError }] = await Promise.all([
    supabase.from("projects").select("id,name,alias,job_number,address,client_name").eq("id", projectId).maybeSingle(),
    supabase.from("supplier_quote_email_matches")
      .select("id,seed_email_id,provider_mailbox,provider_thread_id,external_email,project_confidence,contact_id,evidence,supplier_quote_email_match_lines(cost_line_id,confidence,reason,selected,cost_lines(id,description))")
      .eq("project_id", projectId).eq("status", "review").order("created_at", { ascending: false }),
    supabase.from("emails")
      .select("id,gmail_thread_refs,to_addrs,cc_addrs,from_addr,subject,received_at,direction,triage_label,clean_text")
      .not("gmail_thread_refs", "eq", {}).order("received_at", { ascending: false }).limit(500),
  ]);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (suggestionError || emailError) return NextResponse.json({ error: suggestionError?.message ?? emailError?.message }, { status: 500 });

  const typedProject = project as QuoteProject;
  const typedSuggestions = (suggestions ?? []) as unknown as Suggestion[];
  const candidateEmails = [...((recentEmails ?? []) as CandidateEmail[])];
  const loadedEmailIds = new Set(candidateEmails.map((email) => email.id));
  const missingSeedIds = typedSuggestions.map((suggestion) => suggestion.seed_email_id).filter((id) => !loadedEmailIds.has(id));
  if (missingSeedIds.length > 0) {
    const { data: olderSeedEmails, error: olderSeedError } = await supabase.from("emails")
      .select("id,gmail_thread_refs,to_addrs,cc_addrs,from_addr,subject,received_at,direction,triage_label,clean_text")
      .in("id", missingSeedIds);
    if (olderSeedError) return NextResponse.json({ error: olderSeedError.message }, { status: 500 });
    candidateEmails.push(...((olderSeedEmails ?? []) as CandidateEmail[]));
  }
  const suggestionByThread = new Map(typedSuggestions.map((row) => [`${row.provider_mailbox}:${row.provider_thread_id}`, row]));
  const groups = new Map<string, CandidateEmail[]>();
  for (const email of candidateEmails) {
    const thread = preferredThread(email.gmail_thread_refs);
    if (!thread) continue;
    const key = `${thread.mailbox}:${thread.threadId}`;
    const suggestion = suggestionByThread.get(key);
    const projectMatch = matchQuoteProject([email], [typedProject]);
    if (!suggestion && (!projectMatch || projectMatch.confidence < 0.88 || quoteIntent([email]).confidence < 0.8)) continue;
    const rows = groups.get(key) ?? [];
    rows.push(email);
    groups.set(key, rows);
  }

  const groupedEmails = [...groups].map(([threadKey, rows]) => {
    const seed = [...rows].sort((left, right) => {
      if (left.direction !== right.direction) return left.direction === "sent" ? -1 : 1;
      return left.received_at.localeCompare(right.received_at);
    })[0];
    return { threadKey, seed, rows, suggestion: suggestionByThread.get(threadKey) ?? null };
  });
  const emailIds = groupedEmails.flatMap((group) => group.rows.map((email) => email.id));
  const { data: existingLinks } = emailIds.length
    ? await supabase.from("supplier_quote_request_emails").select("email_id").in("email_id", emailIds)
    : { data: [] as { email_id: string }[] };
  const linked = new Set((existingLinks ?? []).map((row) => row.email_id));
  const available = groupedEmails.filter((group) => !group.rows.some((email) => linked.has(email.id)));

  const addresses = new Set(available.flatMap((group) => group.rows.flatMap((email) => [email.from_addr, ...(email.to_addrs ?? []), ...(email.cc_addrs ?? [])])).map((address) => address.toLowerCase()));
  const contactIds = typedSuggestions.map((suggestion) => suggestion.contact_id).filter((id): id is string => Boolean(id));
  const { data: contacts } = await supabase.from("contacts").select("id,company,email").is("deleted_at", null).limit(5000);
  const contactByEmail = new Map((contacts ?? []).filter((contact) => contact.email && addresses.has(contact.email.toLowerCase())).map((contact) => [contact.email!.toLowerCase(), contact]));
  const contactById = new Map((contacts ?? []).filter((contact) => contactIds.includes(contact.id)).map((contact) => [contact.id, contact]));

  return NextResponse.json({
    emails: available.map(({ seed, rows, suggestion }) => {
      const matchingContact = (suggestion?.contact_id ? contactById.get(suggestion.contact_id) : null) ?? [seed.from_addr, ...(seed.to_addrs ?? []), ...(seed.cc_addrs ?? [])]
        .map((address) => contactByEmail.get(address.toLowerCase())).find(Boolean) ?? null;
      const lineCandidates = (suggestion?.supplier_quote_email_match_lines ?? []).map((line) => ({
        id: line.cost_line_id,
        description: line.cost_lines?.description ?? "Estimate line",
        confidence: Number(line.confidence),
        reason: line.reason,
        selected: line.selected,
      }));
      return {
        id: seed.id,
        suggestion_id: suggestion?.id ?? null,
        subject: seed.subject,
        received_at: seed.received_at,
        direction: seed.direction,
        from_addr: seed.from_addr,
        to_addrs: seed.to_addrs ?? [],
        has_thread_id: true,
        suggested_contact: matchingContact,
        suggested_line_ids: lineCandidates.filter((line) => line.selected).map((line) => line.id),
        line_candidates: lineCandidates,
        project_confidence: suggestion ? Number(suggestion.project_confidence) : matchQuoteProject(rows, [typedProject])?.confidence ?? 0,
        external_email: suggestion?.external_email ?? null,
        preview: seed.clean_text?.slice(0, 240) ?? null,
      };
    }).sort((left, right) => right.received_at.localeCompare(left.received_at)),
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;
  const { supabase, info } = auth;
  const body = await request.json().catch(() => null) as null | {
    email_id?: unknown; contact_id?: unknown; title?: unknown; scope?: unknown; line_ids?: unknown; suggestion_id?: unknown;
  };
  const emailId = typeof body?.email_id === "string" ? body.email_id : "";
  const contactId = typeof body?.contact_id === "string" ? body.contact_id : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const scope = typeof body?.scope === "string" ? body.scope.trim() || null : null;
  const suggestionId = typeof body?.suggestion_id === "string" ? body.suggestion_id : null;
  const lineIds = Array.isArray(body?.line_ids) ? [...new Set(body.line_ids.filter((id): id is string => typeof id === "string"))] : [];
  if (!emailId || !contactId || !title || lineIds.length === 0) return NextResponse.json({ error: "Email, one Address Book contact, title and estimate lines are required" }, { status: 400 });

  const [{ data: project }, { data: sourceEmail }, { data: suggestion }] = await Promise.all([
    supabase.from("projects").select("id,name,alias,job_number,address,client_name").eq("id", projectId).maybeSingle(),
    supabase.from("emails").select("id,subject,clean_text,from_addr,to_addrs,cc_addrs,direction,triage_label,received_at").eq("id", emailId).maybeSingle(),
    suggestionId ? supabase.from("supplier_quote_email_matches").select("id,project_id,status").eq("id", suggestionId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!project || !sourceEmail) return NextResponse.json({ error: "Project or email not found" }, { status: 404 });
  if (suggestion && (suggestion.project_id !== projectId || suggestion.status !== "review")) return NextResponse.json({ error: "That review suggestion is no longer available for this project" }, { status: 409 });
  if (!suggestion) {
    const projectMatch = matchQuoteProject([sourceEmail as QuoteEmail], [project as QuoteProject]);
    if (!projectMatch || projectMatch.confidence < 0.88) return NextResponse.json({ error: "That email does not contain enough evidence for this project" }, { status: 409 });
  }

  const { data: packageId, error } = await supabase.rpc("import_supplier_quote_thread", {
    p_project_id: projectId, p_email_id: emailId, p_contact_id: contactId, p_title: title, p_scope: scope, p_cost_line_ids: lineIds,
  });
  if (error || !packageId) return NextResponse.json({ error: error?.message ?? "Could not link email thread" }, { status: 409 });
  if (suggestionId) {
    await Promise.all([
      supabase.from("supplier_quote_email_matches").update({ status: "confirmed", package_id: packageId, contact_id: contactId, reviewed_by: info.userId, reviewed_at: new Date().toISOString() }).eq("id", suggestionId),
      supabase.from("aria_queue").update({ status: "done", resolved_at: new Date().toISOString() }).eq("dedupe_key", `supplier_quote_email_match:${suggestionId}`),
    ]);
  }
  const packages = await loadSupplierQuotePackages(supabase, projectId);
  return NextResponse.json({ package: packages.find((row) => row.id === packageId) ?? null }, { status: 201 });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;
  const { supabase, info } = auth;
  const body = await request.json().catch(() => null) as null | { suggestion_id?: unknown; action?: unknown };
  const suggestionId = typeof body?.suggestion_id === "string" ? body.suggestion_id : "";
  if (!suggestionId || body?.action !== "dismiss") return NextResponse.json({ error: "A suggestion and dismiss action are required" }, { status: 400 });
  const { data, error } = await supabase.from("supplier_quote_email_matches").update({ status: "dismissed", reviewed_by: info.userId, reviewed_at: new Date().toISOString() }).eq("id", suggestionId).eq("project_id", projectId).eq("status", "review").select("id").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Suggestion not found" }, { status: 404 });
  await supabase.from("aria_queue").update({ status: "done", resolved_at: new Date().toISOString() }).eq("dedupe_key", `supplier_quote_email_match:${suggestionId}`);
  return NextResponse.json({ dismissed: true });
}
