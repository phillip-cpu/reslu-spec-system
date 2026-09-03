import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { buildQuoteThreadMatch, type QuoteContact, type QuoteCostLine, type QuoteEmail, type QuoteProject } from "@/lib/supplier-quote-email-matching";

export const runtime = "nodejs";

const EMAIL_SCAN_LIMIT = 500;
const THREAD_BATCH_SIZE = 20;
const MAILBOX_PRIORITY = ["aria@reslu.com.au", "phillip@reslu.com.au", "tenille@reslu.com.au", "accounts@reslu.com.au", "marco@reslu.com.au"];

type EmailRow = QuoteEmail & { gmail_thread_refs: Record<string, string> | null };

function preferredThread(refs: Record<string, string> | null): { mailbox: string; threadId: string } | null {
  const entries = Object.entries(refs ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]));
  entries.sort((left, right) => {
    const leftRank = MAILBOX_PRIORITY.indexOf(left[0].toLowerCase());
    const rightRank = MAILBOX_PRIORITY.indexOf(right[0].toLowerCase());
    return (leftRank === -1 ? 99 : leftRank) - (rightRank === -1 ? 99 : rightRank);
  });
  return entries[0] ? { mailbox: entries[0][0].toLowerCase(), threadId: entries[0][1] } : null;
}

async function authorised(request: NextRequest): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`) return true;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  return info?.role === "admin";
}

export async function GET(request: NextRequest) {
  if (!(await authorised(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createServiceRoleClient();

  const { data: emailRows, error: emailError } = await supabase
    .from("emails")
    .select("id,subject,clean_text,from_addr,to_addrs,cc_addrs,direction,triage_label,received_at,gmail_thread_refs")
    .not("gmail_thread_refs", "eq", {})
    .order("received_at", { ascending: false })
    .limit(EMAIL_SCAN_LIMIT);
  if (emailError) return NextResponse.json({ error: emailError.message }, { status: 500 });

  const emails = (emailRows ?? []) as EmailRow[];
  const emailIds = emails.map((email) => email.id);
  const [{ data: linkedRows }, { data: existingRows }] = await Promise.all([
    emailIds.length
      ? supabase.from("supplier_quote_request_emails").select("email_id").in("email_id", emailIds)
      : Promise.resolve({ data: [] as { email_id: string }[] }),
    supabase.from("supplier_quote_email_matches").select("provider_mailbox,provider_thread_id"),
  ]);
  const linkedEmailIds = new Set((linkedRows ?? []).map((row) => row.email_id));
  const handledThreads = new Set((existingRows ?? []).map((row) => `${row.provider_mailbox}:${row.provider_thread_id}`));

  const groups = new Map<string, { mailbox: string; threadId: string; emails: EmailRow[] }>();
  for (const email of emails) {
    if (linkedEmailIds.has(email.id)) continue;
    const thread = preferredThread(email.gmail_thread_refs);
    if (!thread) continue;
    const key = `${thread.mailbox}:${thread.threadId}`;
    if (handledThreads.has(key)) continue;
    const group = groups.get(key) ?? { ...thread, emails: [] };
    group.emails.push(email);
    groups.set(key, group);
  }
  const threadGroups = [...groups.values()].slice(0, THREAD_BATCH_SIZE);
  if (threadGroups.length === 0) return NextResponse.json({ scanned: emails.length, reviewed: 0, auto_linked: 0, ignored: 0 });

  const [projectsResult, contactsResult, sectionsResult, linesResult] = await Promise.all([
    supabase.from("projects").select("id,name,alias,job_number,address,client_name").is("deleted_at", null).limit(5000),
    supabase.from("contacts").select("id,company,email,specialty,category").is("deleted_at", null).limit(5000),
    supabase.from("cost_sections").select("id,name").limit(10000),
    supabase.from("cost_lines").select("id,project_id,section_id,description,contact_id").is("deleted_at", null).limit(20000),
  ]);
  const loadError = projectsResult.error ?? contactsResult.error ?? sectionsResult.error ?? linesResult.error;
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });

  const projects = (projectsResult.data ?? []) as QuoteProject[];
  const contacts = (contactsResult.data ?? []) as QuoteContact[];
  const sectionNames = new Map((sectionsResult.data ?? []).map((section) => [section.id, section.name]));
  const lines: QuoteCostLine[] = (linesResult.data ?? []).map((line) => ({
    id: line.id,
    project_id: line.project_id,
    description: line.description,
    contact_id: line.contact_id,
    section_name: sectionNames.get(line.section_id) ?? "Estimate",
  }));

  let reviewed = 0;
  let autoLinked = 0;
  let ignored = 0;
  const failures: string[] = [];

  for (const group of threadGroups) {
    try {
      const match = buildQuoteThreadMatch({ emails: group.emails, projects, contacts, lines });
      const seed = [...group.emails].sort((a, b) => a.received_at.localeCompare(b.received_at))[0];
      if (match.intentConfidence < 0.8 || (!match.project && !match.contact)) {
        await supabase.from("supplier_quote_email_matches").upsert({
          seed_email_id: seed.id,
          provider_mailbox: group.mailbox,
          provider_thread_id: group.threadId,
          external_email: match.externalEmail,
          subject: seed.subject,
          project_id: match.project?.value.id ?? null,
          contact_id: match.contact?.value.id ?? null,
          project_confidence: match.project?.confidence ?? 0,
          contact_confidence: match.contact?.confidence ?? 0,
          overall_confidence: 0,
          status: "dismissed",
          evidence: { reason: match.intentReason, automatic: true },
          reviewed_at: new Date().toISOString(),
        }, { onConflict: "provider_mailbox,provider_thread_id" });
        ignored++;
        continue;
      }
      const evidence = {
        project: match.project?.reasons ?? [],
        contact: match.contact?.reasons ?? [],
        intent: match.intentReason,
        thread_email_ids: group.emails.map((email) => email.id),
      };
      const { data: matchRow, error: matchError } = await supabase.from("supplier_quote_email_matches").upsert({
        seed_email_id: seed.id,
        provider_mailbox: group.mailbox,
        provider_thread_id: group.threadId,
        external_email: match.externalEmail,
        subject: seed.subject,
        project_id: match.project?.value.id ?? null,
        contact_id: match.contact?.value.id ?? null,
        project_confidence: match.project?.confidence ?? 0,
        contact_confidence: match.contact?.confidence ?? 0,
        overall_confidence: match.overallConfidence,
        status: "review",
        evidence,
      }, { onConflict: "provider_mailbox,provider_thread_id" }).select("id").single();
      if (matchError || !matchRow) throw new Error(matchError?.message ?? "Could not save email match");

      if (match.lines.length > 0) {
        const { error: lineError } = await supabase.from("supplier_quote_email_match_lines").upsert(
          match.lines.map((line) => ({ match_id: matchRow.id, cost_line_id: line.id, confidence: line.confidence, reason: line.reason, selected: line.selected })),
          { onConflict: "match_id,cost_line_id" }
        );
        if (lineError) throw new Error(lineError.message);
      }

      if (match.canAutoLink && match.project && match.contact) {
        const selectedLineIds = match.lines.filter((line) => line.selected).map((line) => line.id);
        const { data: packageId, error: importError } = await supabase.rpc("import_supplier_quote_thread", {
          p_project_id: match.project.value.id,
          p_email_id: seed.id,
          p_contact_id: match.contact.value.id,
          p_title: match.title,
          p_scope: match.scope,
          p_cost_line_ids: selectedLineIds,
        });
        if (!importError && packageId) {
          await supabase.from("supplier_quote_email_matches").update({ status: "auto_linked", package_id: packageId, reviewed_at: new Date().toISOString() }).eq("id", matchRow.id);
          autoLinked++;
          continue;
        }
        await supabase.from("supplier_quote_email_matches").update({ evidence: { ...evidence, auto_link_error: importError?.message ?? "Unknown import error" } }).eq("id", matchRow.id);
      }

      await supabase.from("aria_queue").upsert({
        kind: "approval_needed",
        source: "supplier-quote-email-match",
        dedupe_key: `supplier_quote_email_match:${matchRow.id}`,
        payload: {
          match_id: matchRow.id,
          project_id: match.project?.value.id ?? null,
          subject: seed.subject,
          external_email: match.externalEmail,
          instruction: "Review the suggested project, Address Book contact and estimate lines before linking this imported Gmail thread.",
        },
      }, { onConflict: "dedupe_key", ignoreDuplicates: true });
      reviewed++;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "Unknown thread matching error");
    }
  }

  return NextResponse.json({ scanned: emails.length, thread_batch: threadGroups.length, reviewed, auto_linked: autoLinked, ignored, failures });
}
