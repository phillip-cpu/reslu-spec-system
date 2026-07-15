import type { SupabaseClient } from "@supabase/supabase-js";
import {
  automationMarker,
  futureNurtureMilestone,
  projectHealthPriority,
  type AriaPriorityLane,
} from "@/lib/aria-action-rules";
import { isLikelySupplierInvoice } from "@/lib/invoice-candidates";
import { daysSince, isActiveStage, isFollowUpDue } from "@/lib/leads";
import {
  adelaideDateKey,
  loadProjectDataQuality,
} from "@/lib/project-data-quality-server";
import type { ProjectDataQualityIssue } from "@/types/data-quality";
import type { LeadStage } from "@/types";

const SORT_STEP = 1000;
const INVOICE_CANDIDATE_BATCH = 25;
const ACTIONABLE_WARNING_CODES = new Set(["trade_confirmation_due"]);

type OfficeTaskResult = "created" | "refreshed" | "handled";

interface OfficeTaskRow {
  id: string;
  group_id: string;
  title: string;
  description: string | null;
  sort: number;
  completed_at: string | null;
}

interface OfficeAutomationContext {
  groups: { id: string; name: string; sort: number }[];
  tasks: OfficeTaskRow[];
  nextSortByGroup: Map<string, number>;
  assigneeId: string | null;
}

export interface AriaActionSyncSummary {
  priority: Record<AriaPriorityLane, string[]>;
  projects_scanned: number;
  project_health: {
    actionable_issues: number;
    office_tasks_created: number;
    office_tasks_refreshed: number;
    projects: {
      id: string;
      name: string;
      critical: number;
      warning: number;
      action_codes: string[];
    }[];
  };
  delivery_exceptions: {
    found: number;
    office_tasks_created: number;
    office_tasks_refreshed: number;
    queue_items_raised: number;
  };
  future_nurture: {
    due: number;
    office_tasks_created: number;
    office_tasks_refreshed: number;
    queue_items_raised: number;
  };
  followup_drafts: {
    due: number;
    queue_items_raised: number;
  };
  invoice_candidates: {
    checked: number;
    found: number;
    queue_items_raised: number;
  };
  errors: string[];
}

function targetGroup(
  context: OfficeAutomationContext,
  preferred: "Operations" | "Phillip"
): { id: string; name: string; sort: number } {
  const exact = context.groups.find(
    (group) => group.name.trim().toLowerCase() === preferred.toLowerCase()
  );
  const fallback = context.groups.find(
    (group) => group.name.trim().toLowerCase() !== "archived"
  );
  if (!exact && !fallback) throw new Error("No active Office group is available");
  return exact ?? fallback!;
}

async function loadOfficeContext(supabase: SupabaseClient): Promise<OfficeAutomationContext> {
  const [{ data: groups, error: groupsError }, { data: tasks, error: tasksError }, { data: profiles }] =
    await Promise.all([
      supabase
        .from("office_groups")
        .select("id,name,sort")
        .is("deleted_at", null)
        .order("sort"),
      supabase
        .from("office_tasks")
        .select("id,group_id,title,description,sort,completed_at")
        .is("deleted_at", null),
      supabase.from("profiles").select("id,email,full_name"),
    ]);
  if (groupsError) throw new Error(groupsError.message);
  if (tasksError) throw new Error(tasksError.message);

  const typedTasks = (tasks ?? []) as OfficeTaskRow[];
  const nextSortByGroup = new Map<string, number>();
  for (const group of groups ?? []) {
    const highest = typedTasks
      .filter((task) => task.group_id === group.id)
      .reduce((max, task) => Math.max(max, task.sort), -SORT_STEP);
    nextSortByGroup.set(group.id, highest + SORT_STEP);
  }

  const assignee = (profiles ?? []).find(
    (profile) =>
      profile.email?.trim().toLowerCase() === "phillip@reslu.com.au" ||
      profile.full_name?.trim().toLowerCase().startsWith("phillip")
  );

  return {
    groups: groups ?? [],
    tasks: typedTasks,
    nextSortByGroup,
    assigneeId: assignee?.id ?? null,
  };
}

async function ensureOfficeTask(
  supabase: SupabaseClient,
  context: OfficeAutomationContext,
  input: {
    key: string;
    group: "Operations" | "Phillip";
    title: string;
    description: string;
    dueDate: string;
    familyKey?: string;
    completedSatisfies?: boolean;
  }
): Promise<OfficeTaskResult> {
  const marker = automationMarker(input.key);
  const familyMarker = input.familyKey ? automationMarker(input.familyKey) : null;
  const description = [input.description.trim(), marker, familyMarker]
    .filter(Boolean)
    .join("\n\n");
  const exact = context.tasks.find((task) => task.description?.includes(marker));
  if (exact?.completed_at && input.completedSatisfies) return "handled";
  const existing = context.tasks.find(
    (task) =>
      !task.completed_at &&
      (task.description?.includes(marker) ||
        (familyMarker && task.description?.includes(familyMarker)))
  );

  if (existing) {
    const { error } = await supabase
      .from("office_tasks")
      .update({ title: input.title.trim(), description })
      .eq("id", existing.id)
      .is("deleted_at", null);
    if (error) throw new Error(error.message);
    existing.title = input.title.trim();
    existing.description = description;
    return "refreshed";
  }

  const group = targetGroup(context, input.group);
  const sort = context.nextSortByGroup.get(group.id) ?? 0;
  const { data: task, error } = await supabase
    .from("office_tasks")
    .insert({
      group_id: group.id,
      title: input.title.trim(),
      description,
      kind: "task",
      due_date: input.dueDate,
      sort,
      created_by: context.assigneeId,
    })
    .select("id,group_id,title,description,sort,completed_at")
    .single();
  if (error || !task) throw new Error(error?.message ?? "Could not create Office task");

  context.nextSortByGroup.set(group.id, sort + SORT_STEP);
  context.tasks.push(task as OfficeTaskRow);
  if (context.assigneeId) {
    const { error: assigneeError } = await supabase.from("office_task_assignees").insert({
      task_id: task.id,
      profile_id: context.assigneeId,
    });
    if (assigneeError) throw new Error(assigneeError.message);
  }
  return "created";
}

function issueDescription(
  projectName: string,
  issue: ProjectDataQualityIssue,
  appUrl: string
): string {
  const samples = issue.samples.map((sample) => sample.label).join("; ");
  return [
    `Project Health automatically found this issue on ${projectName}.`,
    issue.detail,
    samples ? `Examples: ${samples}` : null,
    `Review: ${appUrl}${issue.href}`,
    "Aria may investigate and propose a correction, but project records must not be changed without human approval.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function deliveryProblem(
  row: Record<string, unknown>
): { label: string; eventType: string } | null {
  if (row.complained_at) return { label: "recipient complaint", eventType: "email.complained" };
  if (row.suppressed_at) return { label: "suppressed email", eventType: "email.suppressed" };
  if (row.bounced_at) return { label: "bounced email", eventType: "email.bounced" };
  if (row.failed_at) return { label: "failed delivery", eventType: "email.failed" };
  if (row.delivery_delayed_at && !row.delivered_at) {
    return { label: "delivery delay", eventType: "email.delivery_delayed" };
  }
  return null;
}

async function raiseQueueItem(
  supabase: SupabaseClient,
  input: {
    kind:
      | "lead_flag"
      | "trade_reminder"
      | "followup_draft"
      | "invoice_candidate";
    payload: Record<string, unknown>;
    key: string;
    source: string;
  }
): Promise<boolean> {
  const { data, error } = await supabase
    .from("aria_queue")
    .upsert(
      {
        kind: input.kind,
        payload: input.payload,
        dedupe_key: input.key,
        source: input.source,
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true }
    )
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

/**
 * Convert read-only health evidence into safe internal actions. The only
 * writes here are Office tasks and Aria queue rows. No project, booking,
 * lead stage, email or financial record is ever changed.
 */
export async function syncAriaActions(
  supabase: SupabaseClient,
  now = new Date()
): Promise<AriaActionSyncSummary> {
  const today = adelaideDateKey(now);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
  const errors: string[] = [];
  const context = await loadOfficeContext(supabase);

  const summary: AriaActionSyncSummary = {
    priority: { today: [], this_week: [], monitor: [] },
    projects_scanned: 0,
    project_health: {
      actionable_issues: 0,
      office_tasks_created: 0,
      office_tasks_refreshed: 0,
      projects: [],
    },
    delivery_exceptions: {
      found: 0,
      office_tasks_created: 0,
      office_tasks_refreshed: 0,
      queue_items_raised: 0,
    },
    future_nurture: {
      due: 0,
      office_tasks_created: 0,
      office_tasks_refreshed: 0,
      queue_items_raised: 0,
    },
    followup_drafts: { due: 0, queue_items_raised: 0 },
    invoice_candidates: { checked: 0, found: 0, queue_items_raised: 0 },
    errors,
  };
  const addPriority = (lane: AriaPriorityLane, label: string) => {
    if (!summary.priority[lane].includes(label)) summary.priority[lane].push(label);
  };

  const { data: projects, error: projectsError } = await supabase
    .from("projects")
    .select("id,name,alias")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("name");
  if (projectsError) throw new Error(projectsError.message);
  summary.projects_scanned = projects?.length ?? 0;

  const healthResults = await Promise.allSettled(
    (projects ?? []).map(async (project) => ({
      project,
      report: await loadProjectDataQuality(supabase, project.id, now),
    }))
  );

  for (const result of healthResults) {
    if (result.status === "rejected") {
      errors.push(
        `Project Health: ${result.reason instanceof Error ? result.reason.message : "unknown error"}`
      );
      continue;
    }
    const { project, report } = result.value;
    const actionIssues = report.issues.filter(
      (issue) => issue.severity === "critical" || ACTIONABLE_WARNING_CODES.has(issue.code)
    );
    summary.project_health.projects.push({
      id: project.id,
      name: project.name,
      critical: report.summary.critical,
      warning: report.summary.warning,
      action_codes: actionIssues.map((issue) => issue.code),
    });
    summary.project_health.actionable_issues += actionIssues.length;

    for (const issue of report.issues) {
      addPriority(
        projectHealthPriority(issue.severity, issue.code),
        `${project.name}: ${issue.title} (${issue.count})`
      );
    }

    for (const issue of actionIssues) {
      try {
        const action = await ensureOfficeTask(supabase, context, {
          key: `project-health:${project.id}:${issue.code}`,
          group: "Operations",
          title: `${project.name} — ${issue.title} (${issue.count})`,
          description: issueDescription(project.name, issue, appUrl),
          dueDate: today,
        });
        if (action !== "handled") {
          summary.project_health[
            action === "created" ? "office_tasks_created" : "office_tasks_refreshed"
          ] += 1;
        }
      } catch (error) {
        errors.push(
          `${project.name}/${issue.code}: ${error instanceof Error ? error.message : "task error"}`
        );
      }
    }
  }

  const { data: emailRows, error: emailError } = await supabase
    .from("email_sends")
    .select(
      "id,record_id,to_email,created_at,delivered_at,bounced_at,failed_at,delivery_delayed_at,complained_at,suppressed_at"
    )
    .eq("record_type", "trade_booking_request")
    .eq("template", "trade-booking-request")
    .order("created_at", { ascending: false })
    .limit(500);
  if (emailError) {
    errors.push(`Delivery evidence: ${emailError.message}`);
  } else {
    const latestByRequest = new Map<string, Record<string, unknown>>();
    for (const row of emailRows ?? []) {
      if (!latestByRequest.has(row.record_id)) latestByRequest.set(row.record_id, row);
    }
    const problemRows = [...latestByRequest.values()].flatMap((row) => {
      const problem = deliveryProblem(row);
      return problem ? [{ row, ...problem }] : [];
    });

    const requestIds = problemRows.map(({ row }) => String(row.record_id));
    const { data: requests, error: requestsError } = requestIds.length
      ? await supabase
          .from("trade_booking_requests")
          .select("id,project_id,contact_id,status")
          .in("id", requestIds)
      : { data: [], error: null };
    if (requestsError) {
      errors.push(`Booking requests: ${requestsError.message}`);
    } else {
      const openRequests = (requests ?? []).filter((request) => request.status === "sent");
      const projectIds = [...new Set(openRequests.map((request) => request.project_id))];
      const contactIds = [
        ...new Set(openRequests.map((request) => request.contact_id).filter(Boolean)),
      ] as string[];
      const [{ data: deliveryProjects }, { data: contacts }] = await Promise.all([
        projectIds.length
          ? supabase.from("projects").select("id,name").in("id", projectIds)
          : Promise.resolve({ data: [] as { id: string; name: string }[] }),
        contactIds.length
          ? supabase.from("contacts").select("id,company").in("id", contactIds)
          : Promise.resolve({ data: [] as { id: string; company: string }[] }),
      ]);
      const requestById = new Map(openRequests.map((request) => [request.id, request]));
      const projectById = new Map((deliveryProjects ?? []).map((project) => [project.id, project]));
      const contactById = new Map((contacts ?? []).map((contact) => [contact.id, contact]));

      for (const { row, label, eventType } of problemRows) {
        const request = requestById.get(String(row.record_id));
        if (!request) continue;
        summary.delivery_exceptions.found += 1;
        const project = projectById.get(request.project_id);
        const contact = request.contact_id ? contactById.get(request.contact_id) : null;
        const projectName = project?.name ?? "Project";
        const company = contact?.company ?? String(row.to_email || "Trade");
        addPriority("today", `${projectName}: booking email ${label} — ${company}`);
        try {
          const action = await ensureOfficeTask(supabase, context, {
            key: `trade-delivery:${request.id}`,
            group: "Operations",
            title: `${projectName} — booking email ${label}: ${company}`,
            description: [
              `The latest grouped booking email to ${String(row.to_email || company)} has a ${label}.`,
              `Review: ${appUrl}/trade-requests/${request.id}`,
              "Confirm the address or choose a resend manually. Aria must not resend or contact the trade without approval.",
            ].join("\n\n"),
            dueDate: today,
          });
          if (action !== "handled") {
            summary.delivery_exceptions[
              action === "created" ? "office_tasks_created" : "office_tasks_refreshed"
            ] += 1;
          }
          if (
            await raiseQueueItem(supabase, {
              kind: "trade_reminder",
              payload: {
                action: "booking_email_delivery_exception",
                booking_request_id: request.id,
                project_id: request.project_id,
                problem: label,
                event_type: eventType,
                to_email: row.to_email,
                instruction:
                  "Investigate and prepare a safe internal follow-up. Do not resend or contact the trade without approval.",
              },
              key: `trade_delivery:${String(row.id)}:${eventType}`,
              source: "aria-action-sync",
            })
          ) {
            summary.delivery_exceptions.queue_items_raised += 1;
          }
        } catch (error) {
          errors.push(
            `Delivery/${request.id}: ${error instanceof Error ? error.message : "task error"}`
          );
        }
      }
    }
  }

  const { data: futureLeads, error: futureLeadsError } = await supabase
    .from("leads")
    .select("id,first_name,surname_project,received_at,created_at")
    .eq("stage", "Potential Future Lead")
    .is("deleted_at", null);
  if (futureLeadsError) {
    errors.push(`Future nurture: ${futureLeadsError.message}`);
  } else {
    const leadIds = (futureLeads ?? []).map((lead) => lead.id);
    const { data: events, error: eventsError } = leadIds.length
      ? await supabase
          .from("lead_stage_events")
          .select("lead_id,at")
          .in("lead_id", leadIds)
          .eq("to_stage", "Potential Future Lead")
          .order("at", { ascending: false })
      : { data: [] as { lead_id: string; at: string }[], error: null };
    if (eventsError) {
      errors.push(`Future nurture history: ${eventsError.message}`);
    } else {
      const enteredByLead = new Map<string, string>();
      for (const event of events ?? []) {
        if (!enteredByLead.has(event.lead_id)) enteredByLead.set(event.lead_id, event.at);
      }

      for (const lead of futureLeads ?? []) {
        const enteredAt =
          enteredByLead.get(lead.id) ?? lead.received_at ?? lead.created_at;
        const daysInStage = daysSince(enteredAt, now);
        const milestone = futureNurtureMilestone(daysInStage);
        if (!milestone) continue;
        summary.future_nurture.due += 1;
        const leadName =
          [lead.first_name, lead.surname_project].filter(Boolean).join(" ") || "Future lead";
        const entryKey = `future-nurture:${lead.id}:${enteredAt}`;
        addPriority("this_week", `${leadName}: ${milestone}-day future-lead review`);
        try {
          const action = await ensureOfficeTask(supabase, context, {
            key: `${entryKey}:${milestone}`,
            familyKey: entryKey,
            completedSatisfies: true,
            group: "Phillip",
            title: `${leadName} — ${milestone}-day future-lead review`,
            description: [
              `${leadName} has been in Potential Future Lead for ${daysInStage} days.`,
              "This is a nurture reminder only. The lead remains excluded from active pipeline value.",
              `Review: ${appUrl}/leads`,
              "Aria may research context and draft a check-in, but must not send it or change the lead stage without approval.",
            ].join("\n\n"),
            dueDate: today,
          });
          if (action !== "handled") {
            summary.future_nurture[
              action === "created" ? "office_tasks_created" : "office_tasks_refreshed"
            ] += 1;
          }
          if (
            await raiseQueueItem(supabase, {
              kind: "lead_flag",
              payload: {
                action: "future_nurture_review",
                lead_id: lead.id,
                milestone_days: milestone,
                days_in_stage: daysInStage,
                excluded_from_pipeline_value: true,
                instruction:
                  "Review context and prepare a draft check-in if useful. Do not send or change stage without approval.",
              },
              key: `future_nurture:${lead.id}:${enteredAt}:${milestone}`,
              source: "aria-action-sync",
            })
          ) {
            summary.future_nurture.queue_items_raised += 1;
          }
        } catch (error) {
          errors.push(
            `Future nurture/${lead.id}: ${error instanceof Error ? error.message : "task error"}`
          );
        }
      }
    }
  }

  const { data: followupLeads, error: followupError } = await supabase
    .from("leads")
    .select("id,first_name,surname_project,email,stage,follow_up_date")
    .not("email", "is", null)
    .not("follow_up_date", "is", null)
    .lte("follow_up_date", today)
    .is("deleted_at", null);
  if (followupError) {
    errors.push(`Lead follow-ups: ${followupError.message}`);
  } else {
    for (const lead of followupLeads ?? []) {
      if (
        !lead.email?.trim() ||
        !isFollowUpDue(lead.follow_up_date, now) ||
        !isActiveStage(lead.stage as LeadStage)
      ) {
        continue;
      }
      summary.followup_drafts.due += 1;
      const leadName =
        [lead.first_name, lead.surname_project].filter(Boolean).join(" ") || "Lead";
      addPriority("today", `${leadName}: follow-up due ${lead.follow_up_date}`);
      try {
        if (
          await raiseQueueItem(supabase, {
            kind: "followup_draft",
            payload: {
              action: "prepare_lead_followup_draft",
              lead_id: lead.id,
              lead_name: leadName,
              recipient_email: lead.email.trim().toLowerCase(),
              stage: lead.stage,
              follow_up_date: lead.follow_up_date,
              draft_dedupe_key: `lead-followup:${lead.id}:${lead.follow_up_date}`,
              instruction:
                "Search Second Brain and the lead record for current context. Prepare a concise, personal RESLU follow-up and call submit_followup_draft. Do not send it, change the lead stage, or change the follow-up date; Phillip must approve the exact draft in Office.",
            },
            key: `followup_draft:${lead.id}:${lead.follow_up_date}`,
            source: "aria-action-sync",
          })
        ) {
          summary.followup_drafts.queue_items_raised += 1;
        }
      } catch (error) {
        errors.push(
          `Lead follow-up/${lead.id}: ${error instanceof Error ? error.message : "queue error"}`
        );
      }
    }
  }

  const invoiceCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: candidateEmails, error: candidateEmailError } = await supabase
    .from("emails")
    .select("id,from_addr,subject,clean_text,received_at,triage_label")
    .eq("direction", "inbound")
    .gte("received_at", invoiceCutoff)
    .order("received_at", { ascending: false })
    .limit(500);
  if (candidateEmailError) {
    errors.push(`Invoice candidates: ${candidateEmailError.message}`);
  } else {
    const emailIds = (candidateEmails ?? []).map((email) => email.id);
    const [{ data: invoiceAttachments, error: invoiceAttachmentError }, { data: existingInvoices, error: existingInvoiceError }] =
      await Promise.all([
        emailIds.length
          ? supabase
              .from("email_attachments")
              .select("email_id,filename,extracted_text")
              .in("email_id", emailIds)
          : Promise.resolve({ data: [] as { email_id: string; filename: string | null; extracted_text: string | null }[], error: null }),
        emailIds.length
          ? supabase
              .from("invoices")
              .select("source_email_id")
              .in("source_email_id", emailIds)
          : Promise.resolve({ data: [] as { source_email_id: string | null }[], error: null }),
      ]);
    if (invoiceAttachmentError) errors.push(`Invoice attachments: ${invoiceAttachmentError.message}`);
    if (existingInvoiceError) errors.push(`Existing invoices: ${existingInvoiceError.message}`);

    if (!invoiceAttachmentError && !existingInvoiceError) {
      const attachmentsByEmail = new Map<
        string,
        { filenames: string[]; texts: string[] }
      >();
      for (const attachment of invoiceAttachments ?? []) {
        const values = attachmentsByEmail.get(attachment.email_id) ?? {
          filenames: [],
          texts: [],
        };
        if (attachment.filename) values.filenames.push(attachment.filename);
        if (attachment.extracted_text) values.texts.push(attachment.extracted_text);
        attachmentsByEmail.set(attachment.email_id, values);
      }
      const alreadyProposed = new Set(
        (existingInvoices ?? [])
          .map((invoice) => invoice.source_email_id)
          .filter((id): id is string => Boolean(id))
      );

      for (const email of candidateEmails ?? []) {
        summary.invoice_candidates.checked += 1;
        if (alreadyProposed.has(email.id)) continue;
        const attachmentEvidence = attachmentsByEmail.get(email.id);
        if (
          !isLikelySupplierInvoice({
            subject: email.subject,
            clean_text: email.clean_text,
            attachment_filenames: attachmentEvidence?.filenames,
            attachment_texts: attachmentEvidence?.texts,
          })
        ) {
          continue;
        }
        summary.invoice_candidates.found += 1;
        if (summary.invoice_candidates.queue_items_raised >= INVOICE_CANDIDATE_BATCH) {
          continue;
        }
        try {
          if (
            await raiseQueueItem(supabase, {
              kind: "invoice_candidate",
              payload: {
                action: "review_supplier_invoice",
                source_email_id: email.id,
                from_addr: email.from_addr,
                subject: email.subject,
                received_at: email.received_at,
                attachment_filenames: attachmentEvidence?.filenames ?? [],
                triage_label: email.triage_label,
                instruction:
                  "Read the ingested email and its attachments, match it to the correct RESLU project and specification context, then call propose_supplier_invoice. Do not approve, apply, mark paid, or alter project financials.",
              },
              key: `invoice_candidate:${email.id}`,
              source: "aria-action-sync",
            })
          ) {
            summary.invoice_candidates.queue_items_raised += 1;
          }
        } catch (error) {
          errors.push(
            `Invoice candidate/${email.id}: ${error instanceof Error ? error.message : "queue error"}`
          );
        }
      }
      if (summary.invoice_candidates.found > 0) {
        addPriority(
          "today",
          `Supplier invoice candidates: ${summary.invoice_candidates.found} need review`
        );
      }
    }
  }

  return summary;
}
