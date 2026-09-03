import { createClient } from "@supabase/supabase-js";
import { buildQuoteThreadMatch, matchQuoteProject, type QuoteEmail, type QuoteProject, type QuoteContact, type QuoteCostLine } from "../lib/supplier-quote-email-matching.ts";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const [{ data: emails, error: emailError }, { data: projects }, { data: contacts }, { data: sections }, { data: lines }] = await Promise.all([
  supabase.from("emails").select("id,subject,clean_text,from_addr,to_addrs,cc_addrs,direction,triage_label,received_at,gmail_thread_refs").ilike("subject", "%Hone%").order("received_at", { ascending: false }).limit(120),
  supabase.from("projects").select("id,name,alias,job_number,address,client_name").is("deleted_at", null),
  supabase.from("contacts").select("id,company,email,specialty,category").is("deleted_at", null),
  supabase.from("cost_sections").select("id,name"),
  supabase.from("cost_lines").select("id,project_id,section_id,description,contact_id").is("deleted_at", null),
]);
if (emailError) throw emailError;
const sectionNames = new Map((sections ?? []).map((row) => [row.id, row.name]));
const costLines: QuoteCostLine[] = (lines ?? []).map((row) => ({ id: row.id, project_id: row.project_id, description: row.description, contact_id: row.contact_id, section_name: sectionNames.get(row.section_id) ?? "Estimate" }));
const groups = new Map<string, QuoteEmail[]>();
for (const row of emails ?? []) {
  const ref = Object.entries(row.gmail_thread_refs ?? {})[0];
  if (!ref) continue;
  const list = groups.get(`${ref[0]}:${ref[1]}`) ?? [];
  list.push(row as QuoteEmail);
  groups.set(`${ref[0]}:${ref[1]}`, list);
}
const results = [...groups.values()].map((thread) => {
  const result = buildQuoteThreadMatch({ emails: thread, projects: (projects ?? []) as QuoteProject[], contacts: (contacts ?? []) as QuoteContact[], lines: costLines });
  return {
    subject: thread[0].subject,
    intent: result.intentConfidence,
    project: result.project?.value.name ?? null,
    project_confidence: result.project?.confidence ?? 0,
    contact: result.contact?.value.company ?? null,
    external_email: result.externalEmail,
    selected_lines: result.lines.filter((line) => line.selected).map((line) => line.description),
    other_candidates: result.lines.filter((line) => !line.selected).slice(0, 4).map((line) => `${line.description} (${Math.round(line.confidence * 100)}%)`),
    auto: result.canAutoLink,
    competing_projects: result.project ? [] : ((projects ?? []) as QuoteProject[]).map((project) => matchQuoteProject(thread, [project])).filter(Boolean).map((candidate) => `${candidate!.value.name} (${Math.round(candidate!.confidence * 100)}%)`) ,
  };
}).filter((row) => row.intent >= 0.8);
console.log(JSON.stringify(results, null, 2));
