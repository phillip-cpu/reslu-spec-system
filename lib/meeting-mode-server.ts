import { conversationParticipants } from "@/lib/conversation-access";
import { meetingTypeForTitle, rankMeetingCandidates } from "@/lib/meeting-mode";
import { createClient } from "@/lib/supabase/server";
import type { ConversationMeetingMinutes, MeetingDestinationCandidate } from "@/types/meeting-mode";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

interface EventRow {
  id: string;
  project_id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  client_name: string | null;
  updated_at: string;
}

interface LeadRow {
  id: string;
  first_name: string | null;
  surname_project: string;
  stage: string;
  site_visit_date: string | null;
  updated_at: string;
}

function words(value: string | null | undefined): string[] {
  return (value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
}

function titleMatchBoost(conversationTitle: string | null, ...labels: (string | null | undefined)[]): number {
  const titleWords = new Set(words(conversationTitle));
  if (titleWords.size === 0) return 0;
  const matching = labels.flatMap(words).filter((word) => titleWords.has(word));
  return Math.min(0.2, new Set(matching).size * 0.08);
}

function timeConfidence(startsAt: string, endsAt: string | null, nowMs: number): { confidence: number; reason: string } {
  const startMs = Date.parse(startsAt);
  const endMs = endsAt ? Date.parse(endsAt) : startMs + 90 * 60_000;
  if (startMs <= nowMs && nowMs <= endMs) return { confidence: 0.98, reason: "This calendar event is happening now" };
  const hours = Math.abs(startMs - nowMs) / 3_600_000;
  if (hours <= 2) return { confidence: 0.93, reason: "This calendar event starts within two hours" };
  if (hours <= 6) return { confidence: 0.86, reason: "This calendar event is close to the current time" };
  return { confidence: 0.68, reason: "This calendar event is scheduled within a day" };
}

export async function requireMeetingModeAccess(supabase: SupabaseServerClient, conversationId: string, userId: string) {
  const result = await conversationParticipants(supabase, conversationId, userId);
  if (result.error) return { error: "Conversation not found" as const, participants: [] };
  const hasAria = result.participants.some((participant) => participant.type === "agent" && participant.agent_slug === "aria");
  if (!hasAria) return { error: "Meeting Mode is available in an Aria conversation" as const, participants: result.participants };
  return { error: null, participants: result.participants };
}

export async function meetingModeContext(supabase: SupabaseServerClient, conversationId: string) {
  const now = new Date();
  const rangeStart = new Date(now.getTime() - 12 * 3_600_000).toISOString();
  const rangeEnd = new Date(now.getTime() + 24 * 3_600_000).toISOString();
  const [conversationResult, eventsResult, visitsResult, projectsResult, leadsResult, activeResult, filedResult] = await Promise.all([
    supabase.from("conversations").select("title").eq("id", conversationId).maybeSingle(),
    supabase
      .from("client_events")
      .select("id,project_id,title,starts_at,ends_at")
      .gte("starts_at", rangeStart)
      .lte("starts_at", rangeEnd)
      .is("deleted_at", null)
      .order("starts_at")
      .limit(20),
    supabase
      .from("leads")
      .select("id,first_name,surname_project,stage,site_visit_date,updated_at")
      .gte("site_visit_date", rangeStart)
      .lte("site_visit_date", rangeEnd)
      .is("deleted_at", null)
      .order("site_visit_date")
      .limit(20),
    supabase
      .from("projects")
      .select("id,name,client_name,updated_at")
      .eq("status", "active")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(30),
    supabase
      .from("leads")
      .select("id,first_name,surname_project,stage,site_visit_date,updated_at")
      .is("deleted_at", null)
      .not("stage", "in", '("Lead Lost","Complete","Unable to Contact")')
      .order("updated_at", { ascending: false })
      .limit(30),
    supabase
      .from("conversation_meeting_minutes")
      .select("*")
      .eq("conversation_id", conversationId)
      .in("status", ["recording", "paused", "processing", "review", "failed"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("conversation_meeting_minutes")
      .select("id,client_event_id,lead_id,source_snapshot")
      .eq("status", "filed")
      .order("filed_at", { ascending: false })
      .limit(200),
  ]);

  for (const result of [conversationResult, eventsResult, visitsResult, projectsResult, leadsResult, activeResult, filedResult]) {
    if (result.error) throw new Error(result.error.message);
  }

  const conversationTitle = conversationResult.data?.title ?? null;
  const activeProjects = (projectsResult.data ?? []) as ProjectRow[];
  const activeProjectIds = new Set(activeProjects.map((project) => project.id));
  const missingEventProjectIds = [...new Set(
    ((eventsResult.data ?? []) as EventRow[])
      .map((event) => event.project_id)
      .filter((projectId) => !activeProjectIds.has(projectId)),
  )];
  let linkedProjects: ProjectRow[] = [];
  if (missingEventProjectIds.length > 0) {
    const linkedProjectsResult = await supabase
      .from("projects")
      .select("id,name,client_name,updated_at")
      .in("id", missingEventProjectIds)
      .is("deleted_at", null);
    if (linkedProjectsResult.error) throw new Error(linkedProjectsResult.error.message);
    linkedProjects = (linkedProjectsResult.data ?? []) as ProjectRow[];
  }
  // A concrete calendar association is stronger evidence than recency/status.
  // Keep its project eligible even when it falls outside the generic active
  // project list, while still excluding deleted destinations.
  const projects = [...activeProjects, ...linkedProjects];
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const filedByEventId = new Map((filedResult.data ?? []).flatMap((row) => row.client_event_id ? [[row.client_event_id, row.id] as const] : []));
  const filedByLeadSource = new Map((filedResult.data ?? []).flatMap((row) => {
    const sourceReference = row.source_snapshot && typeof row.source_snapshot === "object" && !Array.isArray(row.source_snapshot)
      ? (row.source_snapshot as Record<string, unknown>).source_reference
      : null;
    return row.lead_id && typeof sourceReference === "string" && sourceReference
      ? [[`${row.lead_id}:${sourceReference}`, row.id] as const]
      : [];
  }));
  const candidates = new Map<string, MeetingDestinationCandidate>();
  const projectIdsWithCalendarEvents = new Set<string>();

  for (const event of (eventsResult.data ?? []) as EventRow[]) {
    const project = projectById.get(event.project_id);
    if (!project) continue;
    projectIdsWithCalendarEvents.add(project.id);
    const timing = timeConfidence(event.starts_at, event.ends_at, now.getTime());
    const boost = titleMatchBoost(conversationTitle, project.name, project.client_name, event.title);
    // Keep calendar events distinct even when they belong to the same project.
    // Otherwise a later event can overwrite the meeting happening now and
    // silently change the duplicate-detection/source-event association.
    candidates.set(`project:${project.id}:event:${event.id}`, {
      kind: "project",
      id: project.id,
      label: project.name,
      subtitle: `${event.title} · ${new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Adelaide", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(event.starts_at))}`,
      client_event_id: event.id,
      source_reference: `client_event:${event.id}`,
      duplicate_filed_minutes_id: filedByEventId.get(event.id) ?? null,
      confidence: Math.min(1, timing.confidence + boost),
      reasons: [timing.reason, ...(boost ? ["The event or project matches this conversation"] : [])],
      meeting_type: meetingTypeForTitle(event.title),
    });
  }

  for (const lead of (visitsResult.data ?? []) as LeadRow[]) {
    if (!lead.site_visit_date) continue;
    const timing = timeConfidence(lead.site_visit_date, null, now.getTime());
    const label = [lead.first_name, lead.surname_project].filter(Boolean).join(" ") || lead.surname_project;
    const boost = titleMatchBoost(conversationTitle, label);
    const sourceReference = `lead_visit:${lead.id}:${lead.site_visit_date}`;
    candidates.set(`lead:${lead.id}`, {
      kind: "lead",
      id: lead.id,
      label,
      subtitle: `New lead consultation · ${new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Adelaide", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(lead.site_visit_date))}`,
      client_event_id: null,
      source_reference: sourceReference,
      duplicate_filed_minutes_id: filedByLeadSource.get(`${lead.id}:${sourceReference}`) ?? null,
      confidence: Math.min(1, timing.confidence + boost),
      reasons: [timing.reason.replace("calendar event", "lead visit"), ...(boost ? ["The lead matches this conversation"] : [])],
      meeting_type: "new_lead",
    });
  }

  for (const project of projects) {
    const key = `project:${project.id}`;
    if (projectIdsWithCalendarEvents.has(project.id)) continue;
    const boost = titleMatchBoost(conversationTitle, project.name, project.client_name);
    candidates.set(key, {
      kind: "project",
      id: project.id,
      label: project.name,
      subtitle: project.client_name || "Active project",
      client_event_id: null,
      source_reference: null,
      duplicate_filed_minutes_id: null,
      confidence: Math.min(0.7, 0.34 + boost),
      reasons: [boost ? "The project matches this conversation" : "Recently active project"],
      meeting_type: "client_meeting",
    });
  }

  for (const lead of (leadsResult.data ?? []) as LeadRow[]) {
    const key = `lead:${lead.id}`;
    if (candidates.has(key)) continue;
    const label = [lead.first_name, lead.surname_project].filter(Boolean).join(" ") || lead.surname_project;
    const boost = titleMatchBoost(conversationTitle, label);
    candidates.set(key, {
      kind: "lead",
      id: lead.id,
      label,
      subtitle: lead.stage,
      client_event_id: null,
      source_reference: null,
      duplicate_filed_minutes_id: null,
      confidence: Math.min(0.68, 0.3 + boost),
      reasons: [boost ? "The lead matches this conversation" : "Active lead"],
      meeting_type: "new_lead",
    });
  }

  const ranked = rankMeetingCandidates([...candidates.values()]);
  return {
    candidates: ranked.candidates.slice(0, 40),
    suggested: ranked.suggested,
    needsClarification: ranked.needsClarification,
    activeMinutes: (activeResult.data as ConversationMeetingMinutes | null) ?? null,
  };
}
