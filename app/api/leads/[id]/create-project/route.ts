import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { nextJobNumber } from "@/lib/job-number";
import { copyStandardItems } from "@/lib/library-items";
import type { Lead, Project } from "@/types";
import type { StandardItemIdsInput } from "@/types/round-d";
import type { LeadWithBriefFields } from "@/types/round-lead-flow";
import type { ProposalContent } from "@/types/proposals";

export const runtime = "nodejs";

/**
 * Extracts the surname portion of a lead's `surname_project` card name.
 * BUILD-SPEC.md format is `'Surname'` or `'Surname — project
 * descriptor'` — the descriptor, when present, is separated by an
 * em-dash (' — ') or a plain hyphen (' - '), both with surrounding
 * spaces (matching how the leads import script and the kanban card
 * title actually render these — see scripts/import-monday-leads.mjs
 * and components/leads/LeadCard.tsx for the same 'Surname — descriptor'
 * convention). Heuristic: split on the FIRST such separator and take
 * everything before it, trimmed; if no separator is found, the whole
 * string is the surname. This is intentionally simple (not a full name
 * parser) — surname_project is a free-text card title, not a
 * structured name field, so this is best-effort by design, same as the
 * existing clientName fallback below it.
 */
function extractSurname(surnameProject: string): string {
  const match = /\s+[—-]\s+/.exec(surnameProject);
  if (!match) return surnameProject.trim();
  return surnameProject.slice(0, match.index).trim();
}

/**
 * POST /api/leads/[id]/create-project
 * Admin-only. BUILD-SPEC.md "Moving a lead to Design Work In Progress
 * offers one-click 'Create project' (links lead -> project)" — UI label
 * renamed to "Progress to job" (Phase 11 extension, 5 July 2026), route
 * path unchanged:
 *   - name         <- leads.surname_project
 *   - client_name  <- leads.first_name + surname EXTRACTED from
 *                     surname_project via extractSurname() above
 *                     (best-effort; falls back to the extracted surname
 *                     alone if no first name is on file). Phase 11
 *                     extension: previously this concatenated
 *                     first_name with the WHOLE surname_project string
 *                     (including any " — descriptor" suffix), producing
 *                     client names like "Jane Smith — Kitchen Reno";
 *                     now it extracts just the surname first, so
 *                     client_name reads "Jane Smith".
 *   - client_email <- leads.email
 *   - client_phone <- leads.phone
 *   - address      <- leads.location
 *   - budget       <- leads.construction_value
 * Stores project_id on the lead AND the reverse lead_id on the new
 * project ("links both ways"). Idempotent: if the lead already has a
 * project_id, returns the existing project rather than creating a
 * second one (409 avoided — a re-click of "Progress to job" after a
 * page refresh should never double-create).
 *
 * Does NOT require the lead to currently be in any particular stage —
 * the button is surfaced by the UI only at 'Design Work In Progress',
 * 'Construction In Progress', or 'Complete' (per the spec's "offers
 * one-click" phrasing describing the UI affordance, not a hard
 * state-machine rule), but the route itself stays a simple, reusable
 * "make a project from this lead" action so an admin correcting an
 * out-of-order lead isn't blocked.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  // Migration 030 round — "Standard spec items" checklist, same body
  // field as POST /api/projects (see that route + this round's
  // components/leads/LeadDetailPanel.tsx compact checklist). A missing
  // or unparsable body is fine here — this route previously accepted
  // no body at all — so parse failures are swallowed, not surfaced.
  const body: StandardItemIdsInput = await request.json().catch(() => ({}));

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can create projects from leads" }, { status: 403 });
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (leadError || !lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const typedLead = lead as Lead;

  if (typedLead.project_id) {
    const { data: existingProject, error: existingError } = await supabase
      .from("projects")
      .select("*")
      .eq("id", typedLead.project_id)
      .maybeSingle();
    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }
    if (existingProject) {
      return NextResponse.json({ project: existingProject as Project, lead: typedLead });
    }
    // project_id pointed at a since-deleted/missing project — fall
    // through and create a fresh one rather than erroring out.
  }

  const surname = extractSurname(typedLead.surname_project);
  const clientName = typedLead.first_name
    ? `${typedLead.first_name} ${surname}`.trim()
    : surname;
  // Captured outside insertProject() below — TS narrowing on `info`
  // (from the `if (!info)` guard above) doesn't propagate into a
  // nested function's body, so this closure needs its own
  // already-non-null reference.
  const createdBy = info.userId;

  // Job number (migration 028_job_numbers.sql, BUILD-SPEC.md "Three
  // from Phillip — 6 July 2026 evening" item 2): both project-creation
  // paths must generate one — this is the second path (the first is
  // POST /api/projects). Retry once on a unique-violation race, same
  // pattern as that route.
  async function insertProject(jobNumber: string) {
    return supabase
      .from("projects")
      .insert({
        name: typedLead.surname_project,
        client_name: clientName,
        client_email: typedLead.email || null,
        client_phone: typedLead.phone || null,
        address: typedLead.location || null,
        budget: typedLead.construction_value ?? null,
        lead_id: typedLead.id,
        created_by: createdBy,
        job_number: jobNumber,
      })
      .select()
      .single();
  }

  let jobNumber = await nextJobNumber(supabase);
  let { data: project, error: projectError } = await insertProject(jobNumber);

  if (projectError && projectError.code === "23505") {
    jobNumber = await nextJobNumber(supabase);
    ({ data: project, error: projectError } = await insertProject(jobNumber));
  }

  if (projectError) {
    const status = projectError.code === "23505" ? 409 : 500;
    const message =
      projectError.code === "23505"
        ? `Job number "${jobNumber}" is already in use by another project.`
        : projectError.message;
    return NextResponse.json({ error: message }, { status });
  }

  const { data: updatedLead, error: linkError } = await supabase
    .from("leads")
    .update({ project_id: project.id })
    .eq("id", id)
    .select()
    .single();

  if (linkError) {
    // The project now exists but the back-link failed to save — surface
    // this clearly rather than silently losing the link; the caller can
    // retry (the idempotency check above will pick up the existing
    // project next time once project_id is retried/reset).
    return NextResponse.json(
      { error: `Project created, but failed to link it back to the lead: ${linkError.message}`, project },
      { status: 500 }
    );
  }

  // Migration 030 round — "Standard spec items" checklist, compact
  // version in the "Progress to job" confirm step
  // (components/leads/LeadDetailPanel.tsx). Only runs on THIS fresh-
  // create path, never on the idempotent early-return above (re-
  // clicking "Progress to job" after a refresh must never re-copy
  // items onto an already-existing project). Same shared copy helper
  // as POST /api/projects — no duplicated item-construction logic.
  if (Array.isArray(body.standard_item_ids) && body.standard_item_ids.length > 0) {
    await copyStandardItems(supabase, project.id, body.standard_item_ids, createdBy);
  }

  // BUILD-SPEC.md r27 item 6 — proposal -> project carry. Additive and
  // entirely skippable: a lead with no accepted proposal (the normal
  // case pre-r23, and still normal for a lead that never went through
  // the proposal flow) leaves the project exactly as it was before this
  // block existed. Best-effort/never fails project creation, which has
  // already committed above — a partial carry (e.g. the SOW insert
  // fails) is logged, not surfaced as a 500 on an otherwise-successful
  // "Progress to job".
  try {
    // BUILD-SPEC.md r27 item 7 — migration 054's client_invoices.lead_id.
    // Backfills project_id onto every one of THIS lead's invoices that
    // were drafted project_id-null (a deposit invoice raised off a
    // lead-only accepted proposal, before this project existed — see
    // POST /api/proposal/[token]/accept's own lead_id-set comment).
    // lead_id itself is left set (history, not cleared) — only
    // project_id changes. Runs regardless of whether this lead has an
    // accepted proposal at all (a manually-created invoice against this
    // lead_id would be picked up here too), so it's a separate query
    // from the acceptedProposal one below, not nested inside it.
    await supabase
      .from("client_invoices")
      .update({ project_id: project.id })
      .eq("lead_id", id)
      .is("project_id", null);

    const { data: acceptedProposal } = await supabase
      .from("proposals")
      .select("id,project_id,content")
      .eq("lead_id", id)
      .eq("status", "accepted")
      .order("signed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (acceptedProposal) {
      // (a) Proposal reference stored on the project — links the
      // proposal back to this project. Closes the exact gap migration
      // 051's own proposals.project_id column comment documents: "not
      // automated in this round — no route currently re-links an
      // existing proposal when a lead progresses to a job." Only backfills
      // when still unset, so re-running "Progress to job" (idempotent
      // early-return above skips all of this on a second call anyway)
      // never clobbers a manually-relinked proposal.
      if (!acceptedProposal.project_id) {
        await supabase.from("proposals").update({ project_id: project.id }).eq("id", acceptedProposal.id);
      }

      // (b) SOW draft lines from content.scope_sections — section title
      // -> sow_sections.heading, bullets -> sow_lines (kind
      // 'inclusion'), deliverables -> sow_lines (kind 'note', since
      // they're forward-looking deliverable statements rather than
      // scope inclusions proper) — per existing sow schema (migration
      // 011). A fresh draft (status 'draft', revision_label 'T1' — this
      // is always a brand-new project, so no revision_label collision
      // is possible), left for the team to review/edit/issue normally;
      // this never auto-issues a SOW.
      const content = acceptedProposal.content as ProposalContent | null;
      const scopeSections = content?.scope_sections ?? [];
      if (scopeSections.length > 0) {
        const { data: sowDoc, error: sowError } = await supabase
          .from("sow_documents")
          .insert({ project_id: project.id, revision_label: "T1", status: "draft", created_by: createdBy })
          .select("id")
          .maybeSingle();
        if (sowError || !sowDoc) {
          console.error("create-project: SOW draft insert failed (non-fatal)", sowError);
        } else {
          for (let i = 0; i < scopeSections.length; i++) {
            const section = scopeSections[i];
            const { data: sowSection } = await supabase
              .from("sow_sections")
              .insert({ sow_id: sowDoc.id, heading: section.title, sort: i })
              .select("id")
              .maybeSingle();
            if (!sowSection) continue;
            const lines: { text: string; kind: "inclusion" | "note" }[] = [
              ...section.bullets.map((text) => ({ text, kind: "inclusion" as const })),
              ...section.deliverables.map((text) => ({ text, kind: "note" as const })),
            ];
            if (lines.length > 0) {
              await supabase.from("sow_lines").insert(
                lines.map((line, idx) => ({
                  section_id: sowSection.id,
                  text: line.text,
                  kind: line.kind,
                  sort: idx,
                }))
              );
            }
          }
        }
      }
    }

    // (c) brief_answers copied onto the project's notes/overview home.
    // `projects` has no dedicated notes/overview column (checked
    // migrations 001-053 before writing this — only `settings jsonb`,
    // added by 006_monday_email.sql, exists as a general per-project
    // bucket, already keyed by feature namespace elsewhere, e.g.
    // lib/monday/sync.ts's `settings.monday.columns`). Same convention
    // here: `settings.lead_brief`, a LOCAL type shape (not editing the
    // protected types/index.ts Project type), so this is additive and
    // structurally skippable — a project with no lead_brief key simply
    // has nothing to show wherever this gets surfaced. This is a fresh
    // insert (settings defaults to '{}'), so a plain set is safe — no
    // pre-existing settings keys to merge/preserve.
    const typedLeadForBrief = lead as LeadWithBriefFields;
    if (typedLeadForBrief.brief_answers) {
      await supabase
        .from("projects")
        .update({
          settings: {
            lead_brief: {
              answers: typedLeadForBrief.brief_answers,
              submitted_at: typedLeadForBrief.brief_submitted_at,
              copied_at: new Date().toISOString(),
            },
          },
        })
        .eq("id", project.id);
    }
  } catch (carryError) {
    console.error("create-project: proposal/brief carry failed (non-fatal)", carryError);
  }

  return NextResponse.json(
    { project: project as Project, lead: updatedLead as Lead },
    { status: 201 }
  );
}
